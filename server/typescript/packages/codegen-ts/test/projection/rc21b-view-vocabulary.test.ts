// rc.21 part B — the view vocabulary, golden SQL per construct on Postgres and SQLite, and the
// SQLite spellings run on a real SQLite (the live Postgres run is integration-tests'
// view-vocabulary-rc21-pg.test.ts).

import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { buildProjectionViews } from "../../src/projection/build-projection-views.js";
import { RC21B_ENTITIES, withoutFunction } from "./rc21b-view-vocabulary.fixture.js";

const orderRow = (fields: unknown[]) => ({ "object.projection": { name: "OrderRow", children: [
  { "source.rdb": { "@kind": "view", "@table": "v_order_row" } },
  { "field.long": { name: "id", extends: "Order.id" } },
  ...fields,
  { "identity.primary": { name: "id", extends: "Order.id" } } ] } });
const computed = (name: string, subType: string, expr: unknown) =>
  ({ [`field.${subType}`]: { name, children: [ { "origin.computed": { "@expr": expr } } ] } });

async function views(dialect: "postgres" | "sqlite", ...projections: unknown[]): Promise<Map<string, string>> {
  // The origin.function field must be reached (an entity has no read source for it), so only the
  // tests that read it keep it.
  const reachesFunction = JSON.stringify(projections).includes("loyaltyTier");
  const entities = reachesFunction ? RC21B_ENTITIES : withoutFunction(RC21B_ENTITIES);
  const doc = { "metadata.root": { package: "acme", children: [...entities, ...projections] } };
  const { root, errors } = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(doc))]);
  expect(errors).toEqual([]);
  return new Map(buildProjectionViews(root, { dialect }).map((v) => [v.name, v.sql]));
}
const one = async (dialect: "postgres" | "sqlite", projection: unknown) => [...(await views(dialect, projection)).values()][0]!;

describe("U12 cast and U2 a typed NULL of an unbounded varchar", () => {
  const p = orderRow([
    computed("ref", "string", { fn: "coalesce", args: [{ field: "externalRef" }, { cast: { field: "id" }, as: "string" }] }),
    computed("nothing", "string", { cast: { value: null }, as: "string", dbColumnType: "varchar" }),
    computed("code", "string", { cast: { field: "externalRef" }, as: "string", dbColumnType: "character(3)" }),
  ]);
  test("postgres", async () => {
    const sql = await one("postgres", p);
    expect(sql).toContain("COALESCE(o.external_ref, CAST(o.id AS TEXT)) AS ref");
    expect(sql).toContain("CAST(NULL AS VARCHAR) AS nothing");
    expect(sql).toContain("CAST(o.external_ref AS CHARACTER(3)) AS code");
  });
  test("sqlite", async () => {
    const sql = await one("sqlite", p);
    expect(sql).toContain("COALESCE(o.external_ref, CAST(o.id AS TEXT)) AS ref");
    expect(sql).toContain("CAST(NULL AS TEXT) AS nothing");
  });
});

describe("U8 an int-stored enum and an int in one case, through the cast", () => {
  test("postgres", async () => {
    const sql = await one("postgres", orderRow([computed("outcome", "int", {
      case: [{ when: { op: "eq", left: { field: "stage" }, right: { value: 0 } }, then: { cast: { field: "status" }, as: "int" } }],
      else: { field: "stage" } })]));
    expect(sql).toContain("(CASE WHEN o.stage = 0 THEN CAST(o.status AS INTEGER) ELSE o.stage END) AS outcome");
  });
});

describe("U11 string functions, and U3 a path the view does not output", () => {
  const p = orderRow([
    computed("zip5", "string", { fn: "splitPart", args: [{ field: "customerId.zip" }, { value: "-" }, { value: 1 }] }),
    computed("fullName", "string", { fn: "btrim", args: [{ fn: "concatWs", args: [{ value: " " }, { field: "customerId.firstName" }, { field: "customerId.lastName" }] }] }),
    computed("tag", "string", { fn: "concat", args: [{ fn: "lower", args: [{ field: "externalRef" }] }, { value: "#" }, { field: "id" }] }),
    computed("mid", "string", { fn: "replace", args: [{ fn: "substring", args: [{ field: "externalRef" }, { value: 2 }, { value: 3 }] }, { value: "X" }, { value: "" }] }),
    computed("ends", "string", { fn: "concat", args: [{ fn: "left", args: [{ field: "externalRef" }, { value: 1 }] }, { fn: "right", args: [{ field: "externalRef" }, { value: 1 }] }] }),
    computed("len", "int", { fn: "length", args: [{ fn: "upper", args: [{ field: "externalRef" }] }] }),
    computed("noRef", "string", { fn: "nullif", args: [{ field: "externalRef" }, { value: "NONE" }] }),
  ]);
  test("postgres: each function by its own name, and the path joined, not output", async () => {
    const sql = await one("postgres", p);
    expect(sql).toContain("SPLIT_PART(c.zip, '-', 1) AS zip5");
    expect(sql).toContain("BTRIM(CONCAT_WS(' ', c.first_name, c.last_name)) AS full_name");
    expect(sql).toContain("CONCAT(LOWER(o.external_ref), '#', o.id) AS tag");
    expect(sql).toContain("REPLACE(SUBSTR(o.external_ref, 2, 3), 'X', '') AS mid");
    expect(sql).toContain("CONCAT(LEFT(o.external_ref, 1), RIGHT(o.external_ref, 1)) AS ends");
    expect(sql).toContain("CHAR_LENGTH(UPPER(o.external_ref)) AS len");
    expect(sql).toContain("NULLIF(o.external_ref, 'NONE') AS no_ref");
    expect(sql).toContain("LEFT OUTER JOIN customers c ON c.id = o.customer_id");
    expect(sql).not.toMatch(/AS zip\b/);
  });
  test("sqlite: the same values from SQLite's own functions", async () => {
    const sql = await one("sqlite", p);
    const db = new Database(":memory:");
    db.run("CREATE TABLE customers (id INTEGER PRIMARY KEY, first_name TEXT, last_name TEXT, zip TEXT, region_id INTEGER, default_warehouse_id INTEGER, contacts TEXT)");
    db.run("CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER, status INTEGER, stage INTEGER, external_ref TEXT, updated_at TEXT)");
    db.run("INSERT INTO customers (id, first_name, last_name, zip) VALUES (10, 'Ada', 'Lovelace', '02139-4307'), (11, NULL, 'Hopper', '12345')");
    db.run("INSERT INTO orders (id, customer_id, external_ref) VALUES (1, 10, 'AXXBCD'), (2, 11, 'NONE'), (3, NULL, NULL)");
    db.run(`CREATE VIEW v AS ${sql}`);
    expect(db.query("SELECT id, zip5, full_name, tag, mid, ends, len, no_ref FROM v ORDER BY id").all()).toEqual([
      { id: 1, zip5: "02139", full_name: "Ada Lovelace", tag: "axxbcd#1", mid: "B", ends: "AD", len: 6, no_ref: "AXXBCD" },
      { id: 2, zip5: "12345", full_name: "Hopper", tag: "none#2", mid: "ONE", ends: "NE", len: 4, no_ref: null },
      { id: 3, zip5: null, full_name: "", tag: "#3", mid: null, ends: "", len: null, no_ref: null },
    ]);
  });
  test("sqlite: splitPart beyond the first part is refused, not mis-spelled", async () => {
    await expect(one("sqlite", orderRow([computed("p2", "string", { fn: "splitPart", args: [{ field: "externalRef" }, { value: "-" }, { value: 2 }] })])))
      .rejects.toThrow(/splitPart on SQLite is lowered only for the first part/);
  });
});

describe("U13 greatest / least over an aggregate, and U4 a correlated path operand", () => {
  const p = orderRow([
    { "field.timestamp": { name: "lastEvent", children: [ { "origin.aggregate": { "@agg": "max", "@of": "OrderEvent.createdAt", "@via": "Order.orderEvents" } } ] } },
    computed("touched", "timestamp", { fn: "greatest", args: [{ field: "updatedAt" }, { field: "lastEvent" }] }),
    computed("earliest", "timestamp", { fn: "least", args: [{ field: "updatedAt" }, { field: "lastEvent" }] }),
    { "field.long": { name: "eventByCustomer", children: [ { "origin.first": { "@of": "OrderEvent.id", "@via": "Order.orderEvents", "@orderBy": ["createdAt"],
      "@filter": { customerId: { eq: { field: "customerId.id" } } } } } ] } },
  ]);
  test("postgres", async () => {
    const sql = await one("postgres", p);
    expect(sql).toContain("GREATEST(o.updated_at, MAX(o0.created_at)) AS touched");
    expect(sql).toContain("LEAST(o.updated_at, MAX(o0.created_at)) AS earliest");
    expect(sql).toContain("WHERE o1.order_id = o.id AND o1.customer_id = c.id ORDER BY");
    expect(sql).toContain("GROUP BY o.id, c.id");
  });
  test("sqlite: greatest / least skip NULLs as Postgres does", async () => {
    const sql = await one("sqlite", p);
    expect(sql).toContain("MAX(COALESCE(o.updated_at, MAX(o0.created_at)), COALESCE(MAX(o0.created_at), o.updated_at)) AS touched");
    const db = new Database(":memory:");
    db.run("CREATE TABLE customers (id INTEGER PRIMARY KEY, first_name TEXT, last_name TEXT, zip TEXT, region_id INTEGER, default_warehouse_id INTEGER, contacts TEXT)");
    db.run("CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER, status INTEGER, stage INTEGER, external_ref TEXT, updated_at TEXT)");
    db.run("CREATE TABLE order_events (id INTEGER PRIMARY KEY, order_id INTEGER, customer_id INTEGER, stage INTEGER, created_at TEXT)");
    db.run("INSERT INTO customers (id) VALUES (10)");
    db.run("INSERT INTO orders (id, customer_id, updated_at) VALUES (1, 10, '2026-01-05'), (2, 10, NULL), (3, 10, '2026-01-01')");
    db.run("INSERT INTO order_events (id, order_id, customer_id, created_at) VALUES (100, 1, 10, '2026-02-01'), (101, 2, 9, '2026-03-01'), (102, 2, 10, '2026-03-02')");
    db.run(`CREATE VIEW v AS ${sql}`);
    expect(db.query("SELECT id, touched, earliest, event_by_customer FROM v ORDER BY id").all()).toEqual([
      { id: 1, touched: "2026-02-01", earliest: "2026-01-05", event_by_customer: 100 },
      { id: 2, touched: "2026-03-02", earliest: "2026-03-02", event_by_customer: 102 },
      { id: 3, touched: "2026-01-01", earliest: "2026-01-01", event_by_customer: null },
    ]);
  });
});

describe("U10 origin.function", () => {
  test("postgres: the declared call, its arguments read on the reached row", async () => {
    const sql = await one("postgres", orderRow([
      { "field.string": { name: "tier", children: [ { "origin.passthrough": { "@from": "Customer.loyaltyTier", "@via": "Order.customerId" } } ] } }]));
    // fix round I4: the call is cast to the field's column type, so the column has it.
    expect(sql).toContain("CAST(app.loyalty_tier(c.id, c.zip) AS TEXT) AS tier");
  });
  test("codegen refuses a signature the loader would refuse (a caller that skipped it)", async () => {
    const bad = JSON.parse(JSON.stringify(RC21B_ENTITIES).replace('"@params":["long","string"]', '"@params":["int","string"]'));
    const doc = { "metadata.root": { package: "acme", children: [...bad, orderRow([
      { "field.string": { name: "tier", children: [ { "origin.passthrough": { "@from": "Customer.loyaltyTier", "@via": "Order.customerId" } } ] } }])] } };
    const { root } = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(doc))]);
    expect(() => buildProjectionViews(root, { dialect: "postgres" })).toThrow(/argument 1 "id" is a field.long, but parameter 1 is declared int/);
  });
  test("a SQLite view refuses it: SQLite has no stored functions", async () => {
    const doc = { "metadata.root": { package: "acme", children: [...RC21B_ENTITIES, orderRow([
      { "field.string": { name: "tier", children: [ { "origin.passthrough": { "@from": "Customer.loyaltyTier", "@via": "Order.customerId" } } ] } }])] } };
    const { root } = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(doc))]);
    expect(() => buildProjectionViews(root, { dialect: "sqlite" })).toThrow(/calls a database function, which SQLite does not have/);
  });
});

describe("U14 @grain — one row per array element", () => {
  const p = { "object.projection": { name: "CustomerContact", "@grain": "contacts", "@grainOrdinal": "position", children: [
    { "source.rdb": { "@kind": "view", "@table": "v_customer_contact" } },
    { "field.long": { name: "customerId", extends: "Customer.id" } },
    { "field.int": { name: "position" } },
    { "field.string": { name: "kind", children: [ { "origin.passthrough": { "@from": "Contact.kind" } } ] } },
    { "field.int": { name: "rank", children: [ { "origin.passthrough": { "@from": "Contact.rank" } } ] } } ] } };
  test("postgres", async () => {
    const sql = await one("postgres", p);
    // fix round M3: a non-array value (JSON null, an object, a scalar) has no element.
    expect(sql).toContain("FROM customers c CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(c.contacts) = 'array' THEN c.contacts END) WITH ORDINALITY AS mo_el(value, ordinality)");
    expect(sql).toContain("CAST(mo_el.ordinality AS INTEGER) AS position");
    expect(sql).toContain("(mo_el.value ->> 'kind') AS kind");
    expect(sql).toContain("CAST((mo_el.value ->> 'rank') AS INTEGER) AS rank");
  });
  test("sqlite", async () => {
    const sql = await one("sqlite", p);
    const db = new Database(":memory:");
    db.run("CREATE TABLE customers (id INTEGER PRIMARY KEY, first_name TEXT, last_name TEXT, zip TEXT, region_id INTEGER, default_warehouse_id INTEGER, contacts TEXT)");
    db.run(`INSERT INTO customers (id, contacts) VALUES (1, '[{"kind":"email","rank":1},{"kind":"phone","rank":2}]'), (2, '[]'), (3, NULL), (4, '{"kind":"x"}'), (5, 'null'), (6, '7')`);
    db.run(`CREATE VIEW v AS ${sql}`);
    expect(db.query("SELECT customer_id, position, kind, rank FROM v ORDER BY customer_id, position").all()).toEqual([
      { customer_id: 1, position: 1, kind: "email", rank: 1 },
      { customer_id: 1, position: 2, kind: "phone", rank: 2 },
    ]);
  });
});

describe("U15 @union", () => {
  const branches = [
    { "object.projection": { name: "PersonBranch", abstract: true, children: [
      { "field.long": { name: "personId", extends: "Customer.id" } },
      computed("label", "string", { fn: "lower", args: [{ field: "lastName" }] }) ] } },
    { "object.projection": { name: "AddressBranch", abstract: true, children: [
      { "field.long": { name: "personId", extends: "Address.customerId" } },
      computed("label", "string", { fn: "lower", args: [{ field: "street" }] }) ] } },
  ];
  const union = (all: boolean) => ({ "object.projection": { name: "People", extends: "PersonBranch", "@union": ["AddressBranch"],
    ...(all ? { "@unionAll": true } : {}), children: [ { "source.rdb": { "@kind": "view", "@table": "v_people" } } ] } });
  test("postgres: UNION by default, UNION ALL on request, and each branch reads its own base", async () => {
    const sql = (await views("postgres", ...branches, union(false))).get("v_people")!;
    expect(sql).toBe([
      "  SELECT\n    c.id AS person_id,\n    LOWER(c.last_name) AS label\n  FROM customers c",
      "  UNION",
      "  SELECT\n    a.customer_id AS person_id,\n    LOWER(a.street) AS label\n  FROM addresses a",
    ].join("\n"));
    expect((await views("postgres", ...branches, union(true))).get("v_people")).toContain("\n  UNION ALL\n");
  });
  test("sqlite: removes duplicates, or keeps them", async () => {
    for (const all of [false, true]) {
      const sql = (await views("sqlite", ...branches, union(all))).get("v_people")!;
      const db = new Database(":memory:");
      db.run("CREATE TABLE customers (id INTEGER PRIMARY KEY, first_name TEXT, last_name TEXT, zip TEXT, region_id INTEGER, default_warehouse_id INTEGER, contacts TEXT)");
      db.run("CREATE TABLE addresses (id INTEGER PRIMARY KEY, customer_id INTEGER, street TEXT)");
      db.run("INSERT INTO customers (id, last_name) VALUES (1, 'Main')");
      db.run("INSERT INTO addresses (id, customer_id, street) VALUES (9, 1, 'main'), (10, 2, 'Elm')");
      db.run(`CREATE VIEW v AS ${sql}`);
      expect((db.query("SELECT count(*) AS n FROM v").get() as { n: number }).n).toBe(all ? 3 : 2);
    }
  });
});

// rc.21 part B: two fixes the vocabulary needed to build its motivating views.
describe("a projection over a TPH root reads its subtypes' columns; a unique reverse hop is to-one", () => {
  const tph = [
    { "object.entity": { name: "Vehicle", "@discriminator": "kind", children: [
      { "source.rdb": { "@table": "vehicles" } },
      { "field.long": { name: "id" } },
      { "field.string": { name: "kind", "@maxLength": 10 } },
      { "field.long": { name: "lockerId" } },
      { "identity.primary": { "@fields": "id" } } ] } },
    { "object.entity": { name: "Truck", extends: "Vehicle", "@discriminatorValue": "TRUCK", children: [
      { "field.string": { name: "payloadClass" } } ] } },
    { "object.entity": { name: "Locker", children: [
      { "source.rdb": { "@table": "lockers" } },
      { "field.long": { name: "id" } },
      { "field.string": { name: "number" } },
      { "identity.primary": { "@fields": "id" } } ] } },
    { "object.entity": { name: "LockerKey", children: [
      { "source.rdb": { "@table": "locker_keys" } },
      { "field.long": { name: "id" } },
      { "field.long": { name: "lockerId" } },
      { "field.string": { name: "note" } },
      { "identity.primary": { "@fields": "id" } },
      { "identity.reference": { name: "lockerId", "@fields": "lockerId", "@references": "Locker" } } ] } },
  ];
  async function load(extra: unknown[]) {
    const { root, errors } = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify({ "metadata.root": { package: "acme", children: [...tph, ...extra] } }))]);
    return { root, errors: errors.map((e) => e.message) };
  }
  test("an extender with no identity keeps the super's anchor, and a subtype column reads the shared table", async () => {
    const { root, errors } = await load([
      { "object.projection": { name: "VehicleBase", abstract: true, children: [
        { "field.long": { name: "vehicleId", extends: "Vehicle.id" } },
        { "identity.primary": { name: "id", extends: "Vehicle.primary" } } ] } },
      { "object.projection": { name: "VehicleRow", extends: "VehicleBase", children: [
        { "source.rdb": { "@kind": "view", "@view": "v_vehicles" } },
        { "field.string": { name: "externalKey", extends: "Truck.payloadClass" } } ] } },
    ]);
    expect(errors).toEqual([]);
    const sql = buildProjectionViews(root, { dialect: "postgres" })[0]!.sql;
    expect(sql).toContain("v.id AS vehicle_id");
    expect(sql).toContain("v.payload_class AS external_key");
    expect(sql).toContain("FROM vehicles v");
    expect(sql).not.toContain("'TRUCK'");
  });
  const viaCard = (unique: boolean | "partial") => [
    { "object.entity": { name: "LockerKey", children: [
      { "source.rdb": { "@table": "locker_keys" } },
      { "field.long": { name: "id" } },
      { "field.long": { name: "lockerId" } },
      { "field.string": { name: "note" } },
      { "identity.primary": { "@fields": "id" } },
      ...(unique ? [{ "identity.secondary": { name: "locker_keys_locker_uq", "@fields": "lockerId",
        ...(unique === "partial" ? { "@where": "\"note\" IS NOT NULL" } : {}) } }] : []),
      { "identity.reference": { name: "lockerId", "@fields": "lockerId", "@references": "Locker" } } ] } },
  ];
  test("a passthrough over a reverse hop loads when the holder's reference fields are a unique identity, and only then", async () => {
    const projection = { "object.projection": { name: "LockerRow", children: [
      { "source.rdb": { "@kind": "view", "@view": "v_lockers" } },
      { "field.long": { name: "id", extends: "Locker.id" } },
      { "field.string": { name: "note", children: [ { "origin.passthrough": { "@from": "LockerKey.note", "@via": "Locker.lockerKeys" } } ] } },
      { "identity.primary": { name: "id", extends: "Locker.primary" } } ] } };
    const withUnique = async (unique: boolean | "partial") => {
      const doc = { "metadata.root": { package: "acme", children: [...tph.slice(0, 3), ...viaCard(unique), projection] } };
      const { root, errors } = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(doc))]);
      return { root, errors: errors.map((e) => e.message) };
    };
    const ok = await withUnique(true);
    expect(ok.errors).toEqual([]);
    expect(buildProjectionViews(ok.root, { dialect: "postgres" })[0]!.sql).toContain("LEFT OUTER JOIN locker_keys l0 ON l0.locker_id = l.id");
    expect((await withUnique(false)).errors.some((m) => /is to-many/.test(m))).toBe(true);
    // A partial unique index is unique only over its subset, so the hop stays to-many.
    expect((await withUnique("partial")).errors.some((m) => /is to-many/.test(m))).toBe(true);
  });
});

// rc.21 part B fix round (M9): SQLite's left / right / substring give Postgres's meaning for every count.
describe("SQLite left, right and substring over non-positive counts", () => {
  test("match Postgres", async () => {
    const p = orderRow([
      computed("l2", "string", { fn: "left", args: [{ field: "externalRef" }, { value: 2 }] }),
      computed("lm2", "string", { fn: "left", args: [{ field: "externalRef" }, { value: -2 }] }),
      computed("lm9", "string", { fn: "left", args: [{ field: "externalRef" }, { value: -9 }] }),
      computed("r2", "string", { fn: "right", args: [{ field: "externalRef" }, { value: 2 }] }),
      computed("rm2", "string", { fn: "right", args: [{ field: "externalRef" }, { value: -2 }] }),
      computed("r0", "string", { fn: "right", args: [{ field: "externalRef" }, { value: 0 }] }),
      computed("s23", "string", { fn: "substring", args: [{ field: "externalRef" }, { value: 2 }, { value: 3 }] }),
      computed("s03", "string", { fn: "substring", args: [{ field: "externalRef" }, { value: 0 }, { value: 3 }] }),
      computed("sm13", "string", { fn: "substring", args: [{ field: "externalRef" }, { value: -1 }, { value: 3 }] }),
      computed("sm1", "string", { fn: "substring", args: [{ field: "externalRef" }, { value: -1 }] }),
    ]);
    const sql = await one("sqlite", p);
    const db = new Database(":memory:");
    db.run("CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER, status INTEGER, stage INTEGER, external_ref TEXT, updated_at TEXT)");
    db.run("INSERT INTO orders (id, external_ref) VALUES (1, 'abcdef')");
    db.run(`CREATE VIEW v AS ${sql}`);
    // Postgres: left('abcdef',2)='ab', left(-2)='abcd', left(-9)='', right(2)='ef', right(-2)='cdef', right(0)='',
    // substr(s,2,3)='bcd', substr(s,0,3)='ab', substr(s,-1,3)='a', substr(s,-1)='abcdef'.
    expect(db.query("SELECT l2, lm2, lm9, r2, rm2, r0, s23, s03, sm13, sm1 FROM v").get()).toEqual({
      l2: "ab", lm2: "abcd", lm9: "", r2: "ef", rm2: "cdef", r0: "", s23: "bcd", s03: "ab", sm13: "a", sm1: "abcdef",
    });
  });
});

// rc.21 part B — the view vocabulary on a real Postgres: a cast (with a text @dbColumnType
// spelling), the closed function set, a path ref, a correlated path operand, an expression over an
// aggregate, an origin.function, a @grain view, and a @union. Each view is created by the
// production pipeline (build → diff → emit → apply), queried, and a second migrate is a no-op.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { buildExpectedSchema, checkDeclaredFunctions, diff, emit, introspectPostgres, postgresViewReplaceProbe, splitSqlStatements } from "@metaobjectsdev/migrate-ts";
import { buildProjectionViews } from "@metaobjectsdev/codegen-ts";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { startPostgres, type RunningPg } from "../src/postgres-container.ts";

const MODEL = { "metadata.root": { package: "acme", children: [
  { "object.entity": { name: "Region", children: [
    { "source.rdb": { "@table": "regions" } },
    { "field.long": { name: "id" } },
    { "field.string": { name: "code", "@dbColumnType": "character(3)" } },
    { "field.string": { name: "label", "@dbColumnType": "varchar" } },
    { "field.string": { name: "note", "@dbColumnType": "varchar(20)" } },
    { "identity.primary": { name: "id", "@fields": "id" } } ] } },
  { "object.value": { name: "Contact", children: [
    { "field.string": { name: "kind" } },
    { "field.boolean": { name: "preferred" } },
    { "field.int": { name: "rank" } } ] } },
  { "object.entity": { name: "Customer", children: [
    { "source.rdb": { "@table": "customers" } },
    { "field.long": { name: "id" } },
    { "field.string": { name: "firstName" } },
    { "field.string": { name: "lastName" } },
    { "field.string": { name: "zip" } },
    { "field.long": { name: "regionId" } },
    { "field.object": { name: "contacts", "@objectRef": "Contact", isArray: true, "@storage": "jsonb" } },
    { "identity.primary": { name: "id", "@fields": "id" } },
    { "identity.reference": { name: "regionId", "@fields": "regionId", "@references": "Region" } },
    { "field.string": { name: "loyaltyTier", children: [
      { "origin.function": { "@function": "loyalty_tier", "@schema": "app", "@args": ["id", "zip"], "@params": ["long", "string"], "@returns": "string" } } ] } },
    // Fix round 2 (N1): the call is cast to the field's full column type.
    { "field.timestamp": { name: "memberSince", "@localTime": true, children: [
      { "origin.function": { "@function": "member_since", "@schema": "app", "@args": ["id"], "@params": ["long"], "@returns": "timestamp" } } ] } },
    { "field.string": { name: "regionCode", "@maxLength": 8, children: [
      { "origin.function": { "@function": "region_code", "@schema": "app", "@args": ["id"], "@params": ["long"], "@returns": "string" } } ] } },
    { "field.decimal": { name: "creditLimit", "@precision": 10, "@scale": 2, children: [
      { "origin.function": { "@function": "credit_limit", "@schema": "app", "@args": ["id"], "@params": ["long"], "@returns": "decimal" } } ] } } ] } },
  { "object.entity": { name: "Address", children: [
    { "source.rdb": { "@table": "addresses" } },
    { "field.long": { name: "id" } },
    { "field.long": { name: "customerId" } },
    { "field.string": { name: "street" } },
    { "identity.primary": { name: "id", "@fields": "id" } },
    { "identity.reference": { name: "customerId", "@fields": "customerId", "@references": "Customer" } } ] } },
  { "object.entity": { name: "Order", children: [
    { "source.rdb": { "@table": "orders" } },
    { "field.long": { name: "id" } },
    { "field.long": { name: "customerId" } },
    { "field.enum": { name: "status", "@values": ["Open", "Shipped"], "@intValueMap": { Open: 0, Shipped: 1 } } },
    { "field.int": { name: "stage" } },
    { "field.string": { name: "externalRef" } },
    { "field.timestamp": { name: "updatedAt" } },
    { "identity.primary": { name: "id", "@fields": "id" } },
    { "identity.reference": { name: "customerId", "@fields": "customerId", "@references": "Customer" } } ] } },
  { "object.entity": { name: "OrderEvent", children: [
    { "source.rdb": { "@table": "order_events" } },
    { "field.long": { name: "id" } },
    { "field.long": { name: "orderId", "@required": true } },
    { "field.long": { name: "customerId" } },
    { "field.int": { name: "stage" } },
    { "field.timestamp": { name: "createdAt" } },
    { "identity.primary": { name: "id", "@fields": "id" } },
    { "identity.reference": { name: "orderId", "@fields": "orderId", "@references": "Order" } } ] } },
  { "object.projection": { name: "OrderRow", children: [
    { "source.rdb": { "@kind": "view", "@table": "v_order_row" } },
    { "field.long": { name: "id", extends: "Order.id" } },
    { "field.string": { name: "ref", children: [ { "origin.computed": { "@expr": { fn: "coalesce", args: [ { field: "externalRef" }, { cast: { field: "id" }, as: "string" } ] } } } ] } },
    { "field.string": { name: "nothing", children: [ { "origin.computed": { "@expr": { cast: { value: null }, as: "string", dbColumnType: "varchar" } } } ] } },
    { "field.int": { name: "outcome", children: [ { "origin.computed": { "@expr": { case: [ { when: { op: "eq", left: { field: "stage" }, right: { value: 0 } }, then: { cast: { field: "status" }, as: "int" } } ], else: { field: "stage" } } } } ] } },
    { "field.string": { name: "zip5", children: [ { "origin.computed": { "@expr": { fn: "splitPart", args: [ { field: "customerId.zip" }, { value: "-" }, { value: 1 } ] } } } ] } },
    { "field.string": { name: "fullName", children: [ { "origin.computed": { "@expr": { fn: "btrim", args: [ { fn: "concatWs", args: [ { value: " " }, { field: "customerId.firstName" }, { field: "customerId.lastName" } ] } ] } } } ] } },
    { "field.string": { name: "initials", children: [ { "origin.computed": { "@expr": { fn: "upper", args: [ { fn: "concat", args: [ { fn: "left", args: [ { field: "customerId.firstName" }, { value: 1 } ] }, { fn: "right", args: [ { fn: "lower", args: [ { field: "customerId.lastName" } ] }, { value: 1 } ] } ] } ] } } } ] } },
    { "field.int": { name: "refLength", children: [ { "origin.computed": { "@expr": { fn: "length", args: [ { fn: "replace", args: [ { fn: "substring", args: [ { field: "externalRef" }, { value: 2 }, { value: 3 } ] }, { value: "X" }, { value: "" } ] } ] } } } ] } },
    { "field.string": { name: "noRef", children: [ { "origin.computed": { "@expr": { fn: "nullif", args: [ { field: "externalRef" }, { value: "NONE" } ] } } } ] } },
    { "field.string": { name: "tier", children: [ { "origin.passthrough": { "@from": "Customer.loyaltyTier", "@via": "Order.customerId" } } ] } },
    { "field.timestamp": { name: "memberSince", "@localTime": true, children: [ { "origin.passthrough": { "@from": "Customer.memberSince", "@via": "Order.customerId" } } ] } },
    { "field.string": { name: "regionCode", "@maxLength": 8, children: [ { "origin.passthrough": { "@from": "Customer.regionCode", "@via": "Order.customerId" } } ] } },
    { "field.decimal": { name: "creditLimit", "@precision": 10, "@scale": 2, children: [ { "origin.passthrough": { "@from": "Customer.creditLimit", "@via": "Order.customerId" } } ] } },
    { "field.timestamp": { name: "lastEvent", children: [ { "origin.aggregate": { "@agg": "max", "@of": "OrderEvent.createdAt", "@via": "Order.orderEvents" } } ] } },
    { "field.timestamp": { name: "firstAtStatus", children: [ { "origin.aggregate": { "@agg": "min", "@of": "OrderEvent.createdAt", "@via": "Order.orderEvents", "@filter": { stage: { eq: { field: "stage" } } } } } ] } },
    { "field.timestamp": { name: "touched", children: [ { "origin.computed": { "@expr": { fn: "greatest", args: [ { field: "updatedAt" }, { field: "lastEvent" } ] } } } ] } },
    { "field.timestamp": { name: "earliest", children: [ { "origin.computed": { "@expr": { fn: "least", args: [ { field: "updatedAt" }, { field: "lastEvent" } ] } } } ] } },
    { "field.long": { name: "eventByCustomer", children: [ { "origin.first": { "@of": "OrderEvent.id", "@via": "Order.orderEvents", "@orderBy": ["createdAt"], "@filter": { customerId: { eq: { field: "customerId.id" } } } } } ] } },
    { "identity.primary": { name: "id", extends: "Order.id" } } ] } },
  { "object.projection": { name: "CustomerContact", "@grain": "contacts", "@grainOrdinal": "position", children: [
    { "source.rdb": { "@kind": "view", "@table": "v_customer_contact" } },
    { "field.long": { name: "customerId", extends: "Customer.id" } },
    { "field.int": { name: "position" } },
    { "field.string": { name: "kind", children: [ { "origin.passthrough": { "@from": "Contact.kind" } } ] } },
    { "field.boolean": { name: "preferred", children: [ { "origin.passthrough": { "@from": "Contact.preferred" } } ] } },
    { "field.int": { name: "rank", children: [ { "origin.passthrough": { "@from": "Contact.rank" } } ] } } ] } },
  { "object.projection": { name: "PersonBranch", abstract: true, children: [
    { "field.long": { name: "personId", extends: "Customer.id" } },
    { "field.string": { name: "label", children: [ { "origin.computed": { "@expr": { fn: "lower", args: [ { field: "lastName" } ] } } } ] } } ] } },
  { "object.projection": { name: "AddressBranch", abstract: true, children: [
    { "field.long": { name: "personId", extends: "Address.customerId" } },
    { "field.string": { name: "label", children: [ { "origin.computed": { "@expr": { fn: "lower", args: [ { field: "street" } ] } } } ] } } ] } },
  { "object.projection": { name: "People", extends: "PersonBranch", "@union": ["AddressBranch"], children: [
    { "source.rdb": { "@kind": "view", "@table": "v_people" } } ] } },
  { "object.projection": { name: "PeopleAll", extends: "PersonBranch", "@union": ["AddressBranch"], "@unionAll": true, children: [
    { "source.rdb": { "@kind": "view", "@table": "v_people_all" } } ] } },
] } };

let pg: RunningPg;
let k: Kysely<Record<string, unknown>>;

beforeAll(async () => {
  pg = await startPostgres();
  k = new Kysely<Record<string, unknown>>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: pg.connectionUri }) }) });
}, 120_000);

afterAll(async () => {
  await k.destroy();
  await pg.stop();
}, 60_000);

async function migrate() {
  const { root, errors } = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(MODEL))]);
  expect(errors).toEqual([]);
  const expected = buildExpectedSchema(root, { views: buildProjectionViews(root, { dialect: "postgres" }) });
  const run = async () => diff({ expected, actual: await introspectPostgres(k), dialect: "postgres", viewReplaceProbe: postgresViewReplaceProbe(k) });
  const first = await run();
  expect(first.blocked).toEqual([]);
  const { up } = emit(first.changes, { dialect: "postgres" });
  for (const stmt of splitSqlStatements(up)) await sql.raw(stmt.endsWith(";") ? stmt : `${stmt};`).execute(k);
  return run;
}

const rows = async (q: string) => (await sql.raw(q).execute(k)).rows as Record<string, unknown>[];

describe("rc.21 part B view vocabulary — live Postgres", () => {
  test("every construct creates, reads the expected rows, and a second migrate is a no-op", async () => {
    await sql.raw("DROP SCHEMA IF EXISTS app CASCADE").execute(k);
    await sql.raw("CREATE SCHEMA app").execute(k);
    // The function the project owns: owned SQL, created before the view that calls it.
    await sql.raw(`CREATE FUNCTION app.loyalty_tier(bigint, text) RETURNS text LANGUAGE sql IMMUTABLE
      AS $$ SELECT CASE WHEN $1 % 2 = 0 THEN 'gold' ELSE 'silver' END || ':' || left($2, 2) $$`).execute(k);
    await sql.raw(`CREATE FUNCTION app.member_since(bigint) RETURNS timestamp LANGUAGE sql IMMUTABLE
      AS $$ SELECT timestamp '2026-01-01 08:30:00' + ($1 || ' days')::interval $$`).execute(k);
    await sql.raw(`CREATE FUNCTION app.region_code(bigint) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT 'R-' || $1 $$`).execute(k);
    await sql.raw(`CREATE FUNCTION app.credit_limit(bigint) RETURNS numeric LANGUAGE sql IMMUTABLE AS $$ SELECT $1 * 100.5 $$`).execute(k);
    const again = await migrate();

    // U2: the text spellings are the column types.
    const types = await rows(`SELECT column_name, data_type, character_maximum_length FROM information_schema.columns
      WHERE table_name = 'regions' AND column_name IN ('code', 'label', 'note') ORDER BY column_name`);
    expect(types).toEqual([
      { column_name: "code", data_type: "character", character_maximum_length: 3 },
      { column_name: "label", data_type: "character varying", character_maximum_length: null },
      { column_name: "note", data_type: "character varying", character_maximum_length: 20 },
    ]);
    const nothingType = await rows(`SELECT data_type FROM information_schema.columns WHERE table_name = 'v_order_row' AND column_name = 'nothing'`);
    expect(nothingType).toEqual([{ data_type: "character varying" }]);
    // I4: the function's call is cast to the carrying field's column type.
    expect(await rows(`SELECT data_type FROM information_schema.columns WHERE table_name = 'v_order_row' AND column_name = 'tier'`))
      .toEqual([{ data_type: "text" }]);
    // N1: a local timestamp stays without a zone, a sized string keeps its length, a decimal its precision and scale.
    expect(await rows(`SELECT column_name, data_type, character_maximum_length, numeric_precision, numeric_scale
      FROM information_schema.columns WHERE table_name = 'v_order_row' AND column_name IN ('member_since', 'region_code', 'credit_limit')
      ORDER BY column_name`)).toEqual([
      { column_name: "credit_limit", data_type: "numeric", character_maximum_length: null, numeric_precision: 10, numeric_scale: 2 },
      { column_name: "member_since", data_type: "timestamp without time zone", character_maximum_length: null, numeric_precision: null, numeric_scale: null },
      { column_name: "region_code", data_type: "character varying", character_maximum_length: 8, numeric_precision: null, numeric_scale: null },
    ]);

    await sql.raw(`
      INSERT INTO regions (id, code, label, note) VALUES (1, 'NE', 'north east', 'n');
      INSERT INTO customers (id, first_name, last_name, zip, region_id, contacts) VALUES
        (10, 'Ada', 'Lovelace', '02139-4307', 1, '[{"kind":"email","preferred":true,"rank":1},{"kind":"phone","preferred":false,"rank":2}]'),
        (11, '  Alan', 'Turing  ', '12345', 1, '{"kind":"not an array"}'),
        (12, NULL, 'Hopper', NULL, NULL, 'null');
      INSERT INTO addresses (id, customer_id, street) VALUES (100, 10, 'Lovelace'), (101, 11, 'Main St');
      INSERT INTO orders (id, customer_id, status, stage, external_ref, updated_at) VALUES
        (1, 10, 1, 0, NULL, '2026-01-05T00:00:00Z'),
        (2, 11, 0, 7, 'AXXBCD', '2026-03-01T00:00:00Z'),
        (3, 12, 0, 0, 'NONE', NULL);
      INSERT INTO order_events (id, order_id, customer_id, stage, created_at) VALUES
        (1000, 1, 10, 0, '2026-01-01T00:00:00Z'),
        (1001, 1, 10, 0, '2026-02-01T00:00:00Z'),
        (1002, 1, 99, 3, '2026-01-02T00:00:00Z'),
        (1003, 2, 11, 7, '2026-02-15T00:00:00Z');
    `).execute(k);

    const order = await rows(`SELECT id, ref, nothing, outcome, zip5, full_name, initials, ref_length, no_ref, tier,
      (last_event AT TIME ZONE 'UTC')::text AS last_event, (first_at_status AT TIME ZONE 'UTC')::text AS first_at_status,
      (touched AT TIME ZONE 'UTC')::text AS touched, (earliest AT TIME ZONE 'UTC')::text AS earliest, event_by_customer FROM v_order_row ORDER BY id`);
    expect(order).toEqual([
      { id: "1", ref: "1", nothing: null, outcome: 1, zip5: "02139", full_name: "Ada Lovelace", initials: "AE", ref_length: null, no_ref: null,
        tier: "gold:02", last_event: "2026-02-01 00:00:00", first_at_status: "2026-01-01 00:00:00",
        touched: "2026-02-01 00:00:00", earliest: "2026-01-05 00:00:00", event_by_customer: "1000" },
      { id: "2", ref: "AXXBCD", nothing: null, outcome: 7, zip5: "12345", full_name: "Alan Turing", initials: "  ", ref_length: 1, no_ref: "AXXBCD",
        tier: "silver:12", last_event: "2026-02-15 00:00:00", first_at_status: "2026-02-15 00:00:00",
        touched: "2026-03-01 00:00:00", earliest: "2026-02-15 00:00:00", event_by_customer: "1003" },
      { id: "3", ref: "NONE", nothing: null, outcome: 0, zip5: null, full_name: "Hopper", initials: "R", ref_length: 3, no_ref: null,
        tier: null, last_event: null, first_at_status: null, touched: null, earliest: null, event_by_customer: null },
    ]);

    // N1: the local timestamp reads the same in any session zone (a TIMESTAMPTZ cast would have moved it).
    // One connection: SET LOCAL holds for the transaction only.
    const zoned = await k.transaction().execute(async (trx) => {
      await sql.raw(`SET LOCAL TIME ZONE 'America/New_York'`).execute(trx);
      return (await sql.raw(`SELECT current_setting('TimeZone') AS tz, id, member_since::text AS member_since, region_code,
        credit_limit::text AS credit_limit FROM v_order_row ORDER BY id`).execute(trx)).rows;
    });
    expect(zoned).toEqual([
      { tz: "America/New_York", id: "1", member_since: "2026-01-11 08:30:00", region_code: "R-10", credit_limit: "1005.00" },
      { tz: "America/New_York", id: "2", member_since: "2026-01-12 08:30:00", region_code: "R-11", credit_limit: "1105.50" },
      { tz: "America/New_York", id: "3", member_since: "2026-01-13 08:30:00", region_code: "R-12", credit_limit: "1206.00" },
    ]);

    // U14: one row per element; a customer whose value is an object or JSON null has none (fix round M3).
    expect(await rows(`SELECT customer_id, position, kind, preferred, rank FROM v_customer_contact ORDER BY customer_id, position`)).toEqual([
      { customer_id: "10", position: 1, kind: "email", preferred: true, rank: 1 },
      { customer_id: "10", position: 2, kind: "phone", preferred: false, rank: 2 },
    ]);

    // U15: UNION removes the duplicate ('lovelace' as a customer and as a street); UNION ALL keeps it.
    expect(await rows(`SELECT person_id, label FROM v_people ORDER BY person_id, label`)).toEqual([
      { person_id: "10", label: "lovelace" }, { person_id: "11", label: "main st" },
      { person_id: "11", label: "turing  " }, { person_id: "12", label: "hopper" },
    ]);
    expect((await rows(`SELECT count(*)::int AS n FROM v_people_all`))[0]).toEqual({ n: 5 });

    const followup = await again();
    expect(followup.changes).toEqual([]);

    // N2: every declared function is the database's, with the declared types.
    const { root } = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(MODEL))]);
    expect(await checkDeclaredFunctions(k, root)).toEqual([]);
  }, 120_000);

  // N2: `meta verify --db` reads each declared function from pg_proc; a declaration the database
  // does not have is a finding, never hidden by the view's cast. Runs after the test above, which
  // created the functions.
  test("a declared function signature the database does not have is a finding", async () => {
    const fn = (field: Record<string, unknown>, origin: Record<string, unknown>) => ({ ...field, children: [ { "origin.function": { "@schema": "app", ...origin } } ] });
    const findings = async (...fields: { [k: string]: Record<string, unknown> }[]) => {
      const model = { "metadata.root": { package: "acme", children: [
        { "object.entity": { name: "Account", children: [
          { "source.rdb": { "@table": "accounts" } }, { "field.long": { name: "id" } }, { "field.int": { name: "pin" } },
          { "identity.primary": { name: "id", "@fields": "id" } } ] } },
        { "object.projection": { name: "AccountRow", children: [
          { "source.rdb": { "@kind": "view", "@table": "v_account_row" } },
          { "field.long": { name: "id", extends: "Account.id" } }, { "field.int": { name: "pin", extends: "Account.pin" } },
          { "identity.primary": { name: "id", extends: "Account.id" } }, ...fields ] } } ] } };
      const { root, errors } = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(model))]);
      expect(errors).toEqual([]);
      return checkDeclaredFunctions(k, root);
    };
    // Matching declarations: none.
    expect(await findings(
      { "field.decimal": fn({ name: "limit" }, { "@function": "credit_limit", "@args": ["id"], "@params": ["long"], "@returns": "decimal" }) },
      { "field.timestamp": fn({ name: "since", "@localTime": true }, { "@function": "member_since", "@args": ["id"], "@params": ["long"], "@returns": "timestamp" }) },
    )).toEqual([]);
    // A numeric result declared int: the cast would round it.
    const [rounded] = await findings({ "field.int": fn({ name: "limit" }, { "@function": "credit_limit", "@args": ["id"], "@params": ["long"], "@returns": "int" }) });
    expect(rounded).toBe("origin.function app.credit_limit on AccountRow.limit: declared (long) → int, which needs app.credit_limit(bigint) → integer; " +
      "the database has app.credit_limit(bigint) → numeric.");
    // A local timestamp result on a zoned field: the cast would read it in the session's zone.
    const [zoned] = await findings({ "field.timestamp": fn({ name: "since" }, { "@function": "member_since", "@args": ["id"], "@params": ["long"], "@returns": "timestamp" }) });
    expect(zoned).toMatch(/needs app\.member_since\(bigint\) → timestamp with time zone; the database has app\.member_since\(bigint\) → timestamp without time zone\.$/);
    // A parameter of another type, and a function that does not exist.
    const [param] = await findings({ "field.decimal": fn({ name: "limit" }, { "@function": "credit_limit", "@args": ["pin"], "@params": ["int"], "@returns": "decimal" }) });
    expect(param).toMatch(/needs app\.credit_limit\(integer\) → numeric; the database has app\.credit_limit\(bigint\) → numeric\.$/);
    const [missing] = await findings({ "field.int": fn({ name: "score" }, { "@function": "no_such_fn", "@args": [], "@params": [], "@returns": "int" }) });
    expect(missing).toBe("origin.function app.no_such_fn on AccountRow.score: no such function in the database (declared () → int).");
  }, 60_000);
});

/**
 * Real-engine gate for the D1 FK-cascade rebuild (#241) — the PROOF the cascade
 * emitter (`emitD1Cascade`) is correct. Migrate-engine doctrine: emit → apply to a
 * REAL engine → introspect → re-diff must be EMPTY, plus value semantics (seeded row
 * data intact, the rebuilt FK re-enforced).
 *
 * The whole batch is applied inside ONE libSQL `transaction("write")` with
 * `foreign_keys = ON` at the connection — this models remote D1's implicit
 * transaction, where `PRAGMA foreign_keys = OFF` is a no-op (the thing that made the
 * naive SQLite recreate recipe fail on D1, #226). The cascade defers FK enforcement
 * to commit via `PRAGMA defer_foreign_keys = ON` and rebuilds the whole affected set
 * parents-first, so it applies cleanly here.
 *
 * The ONE delta vs the #226 gate (`d1-referenced-rebuild.test.ts`) is that every
 * scenario passes `actualSchema` to `emit()` — that is what activates the cascade and
 * closes #226's residual gap (scenario 5).
 *
 * Topologies: (1) single parent + populated child, (2) transitive g→c→p,
 * (3) multiple children of one parent, (4) self-referential, (5) the #226 residual
 * gap (rebuild parent AND drop the child's FK in one migration), (6) a multi-table
 * A↔B cycle → refuse (emitter-level), (7) a no-referenced-rebuild → byte-identical to
 * the pre-#241 path, (8) a MIXED migration — cascade + unrelated create-table/add-column
 * in the same batch, proving `renderD1`'s splice with a NON-empty `rest` (every other
 * scenario has every change on an affected table, so `rest.up` is always empty there).
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kysely } from "kysely";
import { LibsqlDialect, libsql } from "@libsql/kysely-libsql";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../../src/expected-schema.js";
import { introspectSqlite } from "../../src/introspect/sqlite.js";
import { diff } from "../../src/diff/index.js";
import { emit } from "../../src/emit/index.js";
import { renderSqlite } from "../../src/emit/sqlite.js";
import { applyD1SafetyPass } from "../../src/emit/d1-safety-pass.js";
// Imported from the PACKAGE ROOT to prove the #241 re-export of the cycle error.
import { D1CyclicForeignKeyError } from "../../src/index.js";
import type { AllowOptions, Change, SchemaSnapshot, TableDescriptor } from "../../src/types.js";

// D1 is SQLite at the SQL level; snake_case matches the runtime ObjectManager strategy.
const BUILD_OPTS = { dialect: "d1", columnNamingStrategy: "snake_case" } as const;

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "d1-cascade-"));
  dbPath = join(tmpDir, "t.db");
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// --- harness (copied from d1-referenced-rebuild.test.ts; #226 file stays untouched) ---

/** Apply statements inside ONE explicit transaction on a single connection (models remote D1). */
async function applyInImplicitTxn(stmts: string[]): Promise<{ ok: boolean; error?: string }> {
  const client = libsql.createClient({ url: `file:${dbPath}` });
  await client.execute("PRAGMA foreign_keys = ON"); // D1 remote default
  const tx = await client.transaction("write");
  try {
    for (const s of stmts) await tx.execute(s);
    await tx.commit();
    return { ok: true };
  } catch (e) {
    try { await tx.rollback(); } catch { /* ignore */ }
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    client.close();
  }
}

/** Run statements one at a time on a fresh client (for seeding the v1 schema + rows). */
async function execEach(stmts: string[]): Promise<void> {
  const client = libsql.createClient({ url: `file:${dbPath}` });
  for (const s of stmts) await client.execute(s);
  client.close();
}

function splitSql(sqlText: string): string[] {
  return sqlText.trim().split(";").map((s) => s.trim()).filter(Boolean);
}

/** SELECT rows back on a fresh connection. */
async function queryRows(sqlText: string): Promise<Array<Record<string, unknown>>> {
  const client = libsql.createClient({ url: `file:${dbPath}` });
  try {
    const rs = await client.execute(sqlText);
    return rs.rows as unknown as Array<Record<string, unknown>>;
  } finally {
    client.close();
  }
}

/** Attempt an INSERT with foreign_keys ON; true if the engine REJECTS it (FK enforced). */
async function insertIsRejected(stmt: string): Promise<boolean> {
  const client = libsql.createClient({ url: `file:${dbPath}` });
  await client.execute("PRAGMA foreign_keys = ON");
  try {
    await client.execute(stmt);
    return false; // accepted → FK is NOT enforced
  } catch {
    return true; // rejected → FK enforced
  } finally {
    client.close();
  }
}

// --- metadata + pipeline helpers -------------------------------------------

function entity(name: string, children: unknown[]): unknown {
  return { "object.entity": { name, children } };
}
function rootMeta(children: unknown[]): string {
  return JSON.stringify({ "metadata.root": { package: "acme", children } });
}
async function build(meta: string): Promise<SchemaSnapshot> {
  const r = (await new MetaDataLoader().load([new InMemoryStringSource(meta)])).root;
  return buildExpectedSchema(r, BUILD_OPTS);
}
async function introspectDb(): Promise<SchemaSnapshot> {
  const k = new Kysely<Record<string, unknown>>({ dialect: new LibsqlDialect({ url: `file:${dbPath}` }) });
  try {
    return await introspectSqlite(k);
  } finally {
    await k.destroy();
  }
}

/** Materialize v1 from an empty DB (all create-tables → byte-identical safety pass). */
async function applyV1(v1Meta: string): Promise<void> {
  const expected1 = await build(v1Meta);
  const actual0 = await introspectDb();
  const d0 = await diff({ expected: expected1, actual: actual0, dialect: "d1" });
  const em0 = emit(d0.changes, {
    dialect: "d1",
    expectedSchema: expected1,
    ...(actual0.meta ? { actualMeta: actual0.meta } : {}),
  });
  await execEach(splitSql(em0.up));
}

interface MigrateResult {
  res: { ok: boolean; error?: string };
  em: { up: string; down: string };
  changes: Change[];
  expected2: SchemaSnapshot;
  actual: SchemaSnapshot;
}

/**
 * Diff v2 against the live DB with `actualSchema` threaded through (the whole point —
 * activates the cascade), then apply the D1 migration inside ONE implicit transaction.
 */
async function migrateV2(v2Meta: string, allow?: AllowOptions): Promise<MigrateResult> {
  const expected2 = await build(v2Meta);
  const actual = await introspectDb();
  const d = await diff({
    expected: expected2,
    actual,
    dialect: "d1",
    ...(allow ? { allow } : {}),
  });
  expect(d.blocked).toEqual([]);
  const em = emit(d.changes, {
    dialect: "d1",
    expectedSchema: expected2,
    actualSchema: actual,
    ...(actual.meta ? { actualMeta: actual.meta } : {}),
  });
  const res = await applyInImplicitTxn(splitSql(em.up));
  return { res, em, changes: d.changes, expected2, actual };
}

/** Re-diff the live DB against the desired schema; the convergence proof asserts []. */
async function reDiffChanges(expected2: SchemaSnapshot): Promise<Change[]> {
  const followup = await diff({ expected: expected2, actual: await introspectDb(), dialect: "d1" });
  if (followup.changes.length > 0) {
    console.error("ROUND-TRIP FAILURE — a second `meta migrate` would emit:");
    for (const c of followup.changes) console.error("  -", JSON.stringify(c));
  }
  return followup.changes;
}

// --- shared entity fragments -----------------------------------------------

const ID_PK = { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } };
/** A nullable enum column: adds an inline CHECK → forces a table rebuild, but NULL passes so seeded rows survive. */
const ENUM_KIND = { "field.enum": { name: "kind", "@values": ["A", "B"] } };

// ==========================================================================

describe("#241 D1 FK-cascade — real-engine gate (libSQL, one transaction = remote D1)", () => {
  // Scenario 1 --------------------------------------------------------------
  test("single parent + populated child: cascade applies, rows intact, FK re-enforced, re-diff EMPTY", async () => {
    const parentV = (withEnum: boolean): unknown =>
      entity("Parent", [
        { "field.long": { name: "id" } },
        { "field.string": { name: "name", "@required": true } },
        ...(withEnum ? [ENUM_KIND] : []),
        ID_PK,
        { "index.lookup": { name: "parent_name_ix", "@fields": ["name"] } },
      ]);
    const child = entity("Note", [
      { "field.long": { name: "id" } },
      { "field.long": { name: "parentId", "@required": true } },
      ID_PK,
      { "identity.reference": { name: "ref_parent", "@fields": ["parentId"], "@references": "Parent" } },
    ]);
    const v1 = rootMeta([parentV(false), child]);
    const v2 = rootMeta([parentV(true), child]);

    await applyV1(v1);
    await execEach([
      "INSERT INTO parents (id, name) VALUES (1, 'root')",
      "INSERT INTO notes (id, parent_id) VALUES (1, 1)",
    ]);

    const { res, expected2 } = await migrateV2(v2);
    expect(res.ok).toBe(true);

    // Row data intact (carried columns preserved; new enum column defaulted to NULL).
    const parents = await queryRows("SELECT id, name, kind FROM parents ORDER BY id");
    expect(parents.length).toBe(1);
    expect(String(parents[0]!.name)).toBe("root");
    expect(parents[0]!.kind).toBeNull();
    const notes = await queryRows("SELECT id, parent_id FROM notes ORDER BY id");
    expect(notes.length).toBe(1);
    expect(Number(notes[0]!.parent_id)).toBe(1);

    // The rebuilt FK is LIVE, not silently dropped.
    expect(await insertIsRejected("INSERT INTO notes (id, parent_id) VALUES (2, 999)")).toBe(true);

    // Convergence.
    expect(await reDiffChanges(expected2)).toEqual([]);
  });

  // Scenario 2 --------------------------------------------------------------
  test("transitive g→c→p: all three rebuilt parents-first, rows intact, FK re-enforced, re-diff EMPTY", async () => {
    const countryV = (withEnum: boolean): unknown =>
      entity("Country", [
        { "field.long": { name: "id" } },
        { "field.string": { name: "name", "@required": true } },
        ...(withEnum ? [ENUM_KIND] : []),
        ID_PK,
      ]);
    const region = entity("Region", [
      { "field.long": { name: "id" } },
      { "field.long": { name: "countryId", "@required": true } },
      ID_PK,
      { "identity.reference": { name: "ref_country", "@fields": ["countryId"], "@references": "Country" } },
    ]);
    const city = entity("City", [
      { "field.long": { name: "id" } },
      { "field.long": { name: "regionId", "@required": true } },
      ID_PK,
      { "identity.reference": { name: "ref_region", "@fields": ["regionId"], "@references": "Region" } },
    ]);
    const v1 = rootMeta([countryV(false), region, city]);
    const v2 = rootMeta([countryV(true), region, city]);

    await applyV1(v1);
    await execEach([
      "INSERT INTO countries (id, name) VALUES (1, 'US')",
      "INSERT INTO regions (id, country_id) VALUES (1, 1)",
      "INSERT INTO cities (id, region_id) VALUES (1, 1)",
    ]);

    const { res, em, expected2 } = await migrateV2(v2);
    expect(res.ok).toBe(true);

    // Rebuild order proof: parents-first RENAME (country → region → city).
    const renCountry = em.up.indexOf('ALTER TABLE "__f_countries" RENAME TO "countries"');
    const renRegion = em.up.indexOf('ALTER TABLE "__f_regions" RENAME TO "regions"');
    const renCity = em.up.indexOf('ALTER TABLE "__f_cities" RENAME TO "cities"');
    expect(renCountry).toBeGreaterThanOrEqual(0);
    expect(renCountry).toBeLessThan(renRegion);
    expect(renRegion).toBeLessThan(renCity);

    // Rows intact through the whole chain.
    expect(Number((await queryRows("SELECT id FROM countries"))[0]!.id)).toBe(1);
    expect(Number((await queryRows("SELECT region_id FROM cities"))[0]!.region_id)).toBe(1);

    // FKs re-enforced at both hops.
    expect(await insertIsRejected("INSERT INTO regions (id, country_id) VALUES (2, 999)")).toBe(true);
    expect(await insertIsRejected("INSERT INTO cities (id, region_id) VALUES (2, 999)")).toBe(true);

    expect(await reDiffChanges(expected2)).toEqual([]);
  });

  // Scenario 3 --------------------------------------------------------------
  test("multiple children of one parent: both children rebuilt, rows intact, FKs re-enforced, re-diff EMPTY", async () => {
    const hubV = (withEnum: boolean): unknown =>
      entity("Hub", [
        { "field.long": { name: "id" } },
        { "field.string": { name: "name", "@required": true } },
        ...(withEnum ? [ENUM_KIND] : []),
        ID_PK,
      ]);
    const spoke = entity("Spoke", [
      { "field.long": { name: "id" } },
      { "field.long": { name: "hubId", "@required": true } },
      ID_PK,
      { "identity.reference": { name: "ref_hub", "@fields": ["hubId"], "@references": "Hub" } },
    ]);
    const rim = entity("Rim", [
      { "field.long": { name: "id" } },
      { "field.long": { name: "hubId", "@required": true } },
      ID_PK,
      { "identity.reference": { name: "ref_hub", "@fields": ["hubId"], "@references": "Hub" } },
    ]);
    const v1 = rootMeta([hubV(false), spoke, rim]);
    const v2 = rootMeta([hubV(true), spoke, rim]);

    await applyV1(v1);
    await execEach([
      "INSERT INTO hubs (id, name) VALUES (1, 'center')",
      "INSERT INTO spokes (id, hub_id) VALUES (1, 1)",
      "INSERT INTO rims (id, hub_id) VALUES (1, 1)",
    ]);

    const { res, em, expected2 } = await migrateV2(v2);
    expect(res.ok).toBe(true);

    // Both children pulled into the cascade.
    expect(em.up).toContain('CREATE TABLE "__f_spokes"');
    expect(em.up).toContain('CREATE TABLE "__f_rims"');

    expect(Number((await queryRows("SELECT hub_id FROM spokes"))[0]!.hub_id)).toBe(1);
    expect(Number((await queryRows("SELECT hub_id FROM rims"))[0]!.hub_id)).toBe(1);

    expect(await insertIsRejected("INSERT INTO spokes (id, hub_id) VALUES (2, 999)")).toBe(true);
    expect(await insertIsRejected("INSERT INTO rims (id, hub_id) VALUES (2, 999)")).toBe(true);

    expect(await reDiffChanges(expected2)).toEqual([]);
  });

  // Scenario 4 --------------------------------------------------------------
  test("self-referential table: single temp referencing itself, rows intact, FK re-enforced, re-diff EMPTY", async () => {
    const nodeV = (withEnum: boolean): unknown =>
      entity("Node", [
        { "field.long": { name: "id" } },
        { "field.long": { name: "parentId" } }, // nullable — the root has no parent
        ...(withEnum ? [ENUM_KIND] : []),
        ID_PK,
        { "identity.reference": { name: "ref_parent", "@fields": ["parentId"], "@references": "Node" } },
      ]);
    const v1 = rootMeta([nodeV(false)]);
    const v2 = rootMeta([nodeV(true)]);

    await applyV1(v1);
    await execEach([
      "INSERT INTO nodes (id, parent_id) VALUES (1, NULL)",
      "INSERT INTO nodes (id, parent_id) VALUES (2, 1)",
    ]);

    const { res, em, expected2 } = await migrateV2(v2);
    expect(res.ok).toBe(true);

    // Exactly one temp, self-referencing.
    expect((em.up.match(/CREATE TABLE "__f_/g) ?? []).length).toBe(1);
    expect(em.up).toContain('REFERENCES "__f_nodes"');

    const nodes = await queryRows("SELECT id, parent_id FROM nodes ORDER BY id");
    expect(nodes.length).toBe(2);
    expect(nodes[0]!.parent_id).toBeNull();
    expect(Number(nodes[1]!.parent_id)).toBe(1);

    expect(await insertIsRejected("INSERT INTO nodes (id, parent_id) VALUES (3, 999)")).toBe(true);

    expect(await reDiffChanges(expected2)).toEqual([]);
  });

  // Scenario 5 — the #226 residual gap (load-bearing regression guard for the union graph) ---
  test("#226 gap: rebuild parent AND drop child's FK in one migration — applies cleanly + re-diff EMPTY", async () => {
    const parentV = (withEnum: boolean): unknown =>
      entity("Parent", [
        { "field.long": { name: "id" } },
        { "field.string": { name: "name", "@required": true } },
        ...(withEnum ? [ENUM_KIND] : []),
        ID_PK,
        { "index.lookup": { name: "parent_name_ix", "@fields": ["name"] } },
      ]);
    // v1: child HAS the FK; v2: child DROPS it (no identity.reference).
    const childWithFk = entity("Note", [
      { "field.long": { name: "id" } },
      { "field.long": { name: "parentId", "@required": true } },
      ID_PK,
      { "identity.reference": { name: "ref_parent", "@fields": ["parentId"], "@references": "Parent" } },
    ]);
    const childNoFk = entity("Note", [
      { "field.long": { name: "id" } },
      { "field.long": { name: "parentId", "@required": true } },
      ID_PK,
    ]);
    const v1 = rootMeta([parentV(false), childWithFk]);
    const v2 = rootMeta([parentV(true), childNoFk]);

    await applyV1(v1);
    await execEach([
      "INSERT INTO parents (id, name) VALUES (1, 'root')",
      "INSERT INTO parents (id, name) VALUES (2, 'other')",
      "INSERT INTO notes (id, parent_id) VALUES (1, 1)",
    ]);

    // The FK now exists ONLY in the actual schema (v2/expected dropped it). Without the
    // union FK graph this emits a recreate that fails to DROP the still-referenced parent.
    const { res, changes, em, expected2 } = await migrateV2(v2, { dropFk: true });
    expect(res.ok).toBe(true);

    // The diff really is "rebuild parent + drop child FK" (the construction under test).
    expect(changes.some((c) => c.kind === "add-check" && c.table === "parents")).toBe(true);
    expect(changes.some((c) => c.kind === "drop-fk" && c.table === "notes")).toBe(true);
    // Index recreation is exercised (Task-4 Minor #2).
    expect(em.up).toContain('CREATE INDEX "parent_name_ix"');

    // Rows carried through both rebuilds.
    expect((await queryRows("SELECT id FROM parents")).length).toBe(2);
    expect(Number((await queryRows("SELECT parent_id FROM notes"))[0]!.parent_id)).toBe(1);

    // The FK really was dropped: a formerly-illegal child insert now SUCCEEDS.
    expect(await insertIsRejected("INSERT INTO notes (id, parent_id) VALUES (2, 999)")).toBe(false);

    expect(await reDiffChanges(expected2)).toEqual([]);
  });

  // Scenario 6 — multi-table cycle → refuse (emitter-level, no apply) --------
  test("multi-table A↔B cycle → emit() throws D1CyclicForeignKeyError (re-exported from package root)", () => {
    const ALLOWED = { state: "allowed" } as const;
    const tableA = (withCheck: boolean): TableDescriptor => ({
      name: "a",
      columns: [
        { name: "id", sqlType: { kind: "integer", bits: 64 }, nullable: false, identity: "increment" },
        { name: "b_id", sqlType: { kind: "integer", bits: 64 }, nullable: true },
      ],
      indexes: [],
      foreignKeys: [{ name: "a_b_id_fk", columns: ["b_id"], refTable: "b", refColumns: ["id"] }],
      primaryKey: ["id"],
      checks: withCheck ? [{ name: "a_id_chk", expression: "id > 0" }] : [],
    });
    const tableB: TableDescriptor = {
      name: "b",
      columns: [
        { name: "id", sqlType: { kind: "integer", bits: 64 }, nullable: false, identity: "increment" },
        { name: "a_id", sqlType: { kind: "integer", bits: 64 }, nullable: true },
      ],
      indexes: [],
      foreignKeys: [{ name: "b_a_id_fk", columns: ["a_id"], refTable: "a", refColumns: ["id"] }],
      primaryKey: ["id"],
      checks: [],
    };
    const changes: Change[] = [
      { kind: "add-check", status: ALLOWED, table: "a", check: { name: "a_id_chk", expression: "id > 0" } },
    ];
    const expected: SchemaSnapshot = { tables: [tableA(true), tableB], views: [] };
    const actual: SchemaSnapshot = { tables: [tableA(false), tableB], views: [] };

    expect(() =>
      emit(changes, { dialect: "d1", expectedSchema: expected, actualSchema: actual }),
    ).toThrow(D1CyclicForeignKeyError);
  });

  // Scenario 7 — no referenced rebuild → byte-identical to the pre-#241 path --
  test("no-referenced-rebuild (leaf) → D1 up is byte-identical to applyD1SafetyPass(renderSqlite(...))", async () => {
    const logV = (withEnum: boolean): unknown =>
      entity("Log", [
        { "field.long": { name: "id" } },
        { "field.string": { name: "level", "@required": true } },
        ...(withEnum ? [ENUM_KIND] : []),
        ID_PK,
      ]);
    const v1 = rootMeta([logV(false)]);
    const v2 = rootMeta([logV(true)]);

    await applyV1(v1);
    await execEach(["INSERT INTO logs (id, level) VALUES (1, 'info')"]);

    const expected2 = await build(v2);
    const actual = await introspectDb();
    const d = await diff({ expected: expected2, actual, dialect: "d1" });
    const em = emit(d.changes, {
      dialect: "d1",
      expectedSchema: expected2,
      actualSchema: actual,
      ...(actual.meta ? { actualMeta: actual.meta } : {}),
    });

    // The whole reason scenario 7 exists: a leaf rebuild takes the pre-#241 path unchanged.
    const expectedUp = applyD1SafetyPass(renderSqlite(d.changes, expected2, actual.meta).up);
    expect(em.up).toBe(expectedUp);

    // And it still converges on the real engine.
    const res = await applyInImplicitTxn(splitSql(em.up));
    expect(res.ok).toBe(true);
    expect(String((await queryRows("SELECT level FROM logs"))[0]!.level)).toBe("info");
    expect(await reDiffChanges(expected2)).toEqual([]);
  });

  // Scenario 8 — mixed migration: cascade + unrelated native changes → non-empty `rest` ---
  test("mixed migration: cascade (referenced parent) PLUS unrelated create-table/add-column flow through `rest`, re-diff EMPTY", async () => {
    const parentV = (withEnum: boolean): unknown =>
      entity("Parent", [
        { "field.long": { name: "id" } },
        { "field.string": { name: "name", "@required": true } },
        ...(withEnum ? [ENUM_KIND] : []),
        ID_PK,
      ]);
    const child = entity("Note", [
      { "field.long": { name: "id" } },
      { "field.long": { name: "parentId", "@required": true } },
      ID_PK,
      { "identity.reference": { name: "ref_parent", "@fields": ["parentId"], "@references": "Parent" } },
    ]);
    // Unrelated to the Parent/Note cascade set — no FK to or from either. Exists in
    // BOTH versions; v2 adds a column, exercising `rest`'s add-column path.
    const otherV = (withNote: boolean): unknown =>
      entity("Other", [
        { "field.long": { name: "id" } },
        { "field.string": { name: "tag", "@required": true } },
        ...(withNote ? [{ "field.string": { name: "note" } }] : []),
        ID_PK,
      ]);
    // Brand-new in v2 — exercises `rest`'s create-table path.
    const widget = entity("Widget", [
      { "field.long": { name: "id" } },
      { "field.string": { name: "label", "@required": true } },
      ID_PK,
    ]);
    const v1 = rootMeta([parentV(false), child, otherV(false)]);
    const v2 = rootMeta([parentV(true), child, otherV(true), widget]);

    await applyV1(v1);
    await execEach([
      "INSERT INTO parents (id, name) VALUES (1, 'root')",
      "INSERT INTO notes (id, parent_id) VALUES (1, 1)",
      "INSERT INTO others (id, tag) VALUES (1, 'x')",
    ]);

    const { res, em, changes, expected2 } = await migrateV2(v2);
    expect(res.ok).toBe(true);

    // The construction under test: an FK-referenced-parent rebuild (cascade) PLUS
    // unrelated native changes on tables outside the affected set — proves
    // `nonAffected`/`rest` is non-empty for this migration.
    expect(changes.some((c) => c.kind === "add-check" && c.table === "parents")).toBe(true);
    expect(changes.some((c) => c.kind === "create-table" && c.table.name === "widgets")).toBe(true);
    expect(
      changes.some((c) => c.kind === "add-column" && c.table === "others" && c.column.name === "note"),
    ).toBe(true);

    // The emitted `up` contains BOTH the cascade block (temp `__f_` tables for the
    // referenced parent + its referrer) AND the spliced-in `rest` (the unrelated
    // create-table and add-column) — proving the splice really ran with a
    // non-empty `rest`, not the trivially-empty case every other scenario exercises.
    expect(em.up).toContain('CREATE TABLE "__f_parents"');
    expect(em.up).toContain('CREATE TABLE "__f_notes"');
    expect(em.up).toContain('CREATE TABLE "widgets"');
    expect(em.up).toContain('ALTER TABLE "others" ADD COLUMN "note"');

    // Seeded row data intact — across the cascaded tables AND the `rest`-altered table.
    const parents = await queryRows("SELECT id, name, kind FROM parents ORDER BY id");
    expect(parents.length).toBe(1);
    expect(String(parents[0]!.name)).toBe("root");
    expect(parents[0]!.kind).toBeNull();
    const notes = await queryRows("SELECT id, parent_id FROM notes ORDER BY id");
    expect(notes.length).toBe(1);
    expect(Number(notes[0]!.parent_id)).toBe(1);
    const others = await queryRows("SELECT id, tag, note FROM others ORDER BY id");
    expect(others.length).toBe(1);
    expect(String(others[0]!.tag)).toBe("x");
    expect(others[0]!.note).toBeNull();

    // The brand-new native table is live (created AFTER the cascade, per the splice order).
    await execEach(["INSERT INTO widgets (id, label) VALUES (1, 'w1')"]);
    expect((await queryRows("SELECT label FROM widgets"))[0]!.label).toBe("w1");

    // The rebuilt FK is LIVE, not silently dropped.
    expect(await insertIsRejected("INSERT INTO notes (id, parent_id) VALUES (2, 999)")).toBe(true);

    // Convergence — the whole point: a mixed migration re-diffs EMPTY too.
    expect(await reDiffChanges(expected2)).toEqual([]);
  });
});

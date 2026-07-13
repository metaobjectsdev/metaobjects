/**
 * uuid-PK kitchen sink — real libsql engine, BOTH required gates.
 *
 * A downstream consumer on SQLite/D1 with uuid primary keys hit a family of
 * migrate bugs that a 5,000-test suite and five conformance corpora could not
 * see, for one reason: every PK in every fixture was a `field.long` with
 * `@generation: increment`. This file closes that hole on the SQLite/D1 side.
 *
 * It drives the SHARED `trainer-website-entities` fixture (the same one the
 * round-trip tests use) so the fixture and this gate cannot drift apart. The
 * `MediaAsset` entity there carries a uuid PK plus one shape per shipped bug.
 *
 * TWO gates, because neither alone is sufficient — that is the core lesson of
 * the post-mortem:
 *
 *   1. IDEMPOTENCE — apply to a REAL engine, introspect, re-diff, assert EMPTY.
 *      Catches ASYMMETRY between what emit writes, what introspect reads back,
 *      and what expected-schema models. This is what nothing in the repo did:
 *      every migrate layer was unit-tested against hand-built ColumnDescriptors,
 *      so expected/emit/introspect had never been in the same room.
 *
 *   2. VALUE SEMANTICS — INSERT a row that takes the column DEFAULTS and ask the
 *      engine what it actually stored. Idempotence is blind to CONSISTENTLY
 *      wrong behavior: emit and introspect happily agreed on `DEFAULT 'false'`
 *      and converged, while SQLite stored the TEXT "false" in a numeric-affinity
 *      column and `WHERE archived = 0` matched nothing.
 *
 * Every assertion below is a bug that actually shipped. Do not relax one without
 * proving the new behavior correct against the real engine — two goldens in this
 * repo were found to be ENCODING the bugs they pinned.
 */

import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kysely, sql } from "kysely";
import { LibsqlDialect } from "@libsql/kysely-libsql";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../../src/expected-schema.js";
import { introspectSqlite } from "../../src/introspect/sqlite.js";
import { diff } from "../../src/diff/index.js";
import { emit } from "../../src/emit/index.js";
import type { AllowOptions } from "../../src/types.js";

const FIXTURE = join(import.meta.dir, "..", "fixtures", "trainer-website-entities.json");

let tmpDir: string;
let k: Kysely<Record<string, unknown>>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "migrate-ts-uuid-pk-"));
  k = new Kysely({ dialect: new LibsqlDialect({ url: `file:${join(tmpDir, "t.db")}` }) });
});
afterEach(async () => {
  await k.destroy();
  rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * libsql's execute() is single-statement-only — a multi-statement string silently
 * stops after the first. Split on ";" and run each one.
 */
async function applyRaw(sqlText: string): Promise<void> {
  for (const stmt of sqlText.trim().split(";").map((s) => s.trim()).filter(Boolean)) {
    await sql.raw(stmt).execute(k);
  }
}

async function load(json: string) {
  return (await new MetaDataLoader().load([new InMemoryStringSource(json)])).root;
}

/**
 * Run the FULL pipeline the way the CLI runs it. `dialect` is load-bearing on
 * BOTH calls and must never be dropped: `buildExpectedSchema` needs it to
 * normalize types to what SQLite introspection can see, and `diff` needs it to
 * (a) key FKs structurally — SQLite stores no FK names, so a @constraintName can
 * never match by name — and (b) diff CHECK constraints at all, without which an
 * enum @values change is invisible. Omitting it tests a shape production never
 * produces.
 */
async function migrate(
  json: string,
  allow: AllowOptions = {},
): Promise<{ up: string; expected: ReturnType<typeof buildExpectedSchema> }> {
  const expected = buildExpectedSchema(await load(json), { dialect: "sqlite" });
  const actual = await introspectSqlite(k);
  const result = await diff({ expected, actual, dialect: "sqlite", allow });
  expect(result.blocked).toEqual([]);
  const { up } = emit(result.changes, {
    dialect: "sqlite",
    expectedSchema: expected,
    ...(actual.meta !== undefined && { actualMeta: actual.meta }),
  });
  await applyRaw(up);
  return { up, expected };
}

/** The gate: a second `meta migrate` against the just-migrated DB must be a no-op. */
async function assertConverged(
  expected: ReturnType<typeof buildExpectedSchema>,
  allow: AllowOptions = {},
): Promise<void> {
  const followup = await diff({ expected, actual: await introspectSqlite(k), dialect: "sqlite", allow });
  if (followup.changes.length > 0) {
    console.error("NOT CONVERGED — a second `meta migrate` would emit:");
    for (const c of followup.changes) console.error("  -", JSON.stringify(c));
  }
  expect(followup.changes).toEqual([]);
}

/** Insert one MediaAsset taking every column default. Only the two required-no-default cols are supplied. */
async function insertTakingDefaults(storageKey: string, kind = "IMAGE"): Promise<void> {
  await sql
    .raw(`INSERT INTO "media_assets" ("storage_key", "kind") VALUES ('${storageKey}', '${kind}')`)
    .execute(k);
}

async function row(select: string): Promise<Record<string, unknown>> {
  return (await sql.raw(select).execute(k)).rows[0] as Record<string, unknown>;
}

const original = () => readFileSync(FIXTURE, "utf8");

describe("uuid-PK kitchen sink — SQLite/libsql", () => {
  // ---------------------------------------------------------------------------
  // Gate 1 — IDEMPOTENCE
  // ---------------------------------------------------------------------------

  test("IDEMPOTENCE: a uuid PK migrates once and CONVERGES — a second migrate is a no-op", async () => {
    const { up, expected } = await migrate(original());

    // The uuid PK's DEFAULT is synthesized at emit time and deliberately NOT
    // modeled as a ColumnDefault on the expected side (uuid generation is
    // `identity`, not `default`). Introspection reads it back off the live table
    // as a real default, so diffing the two disagreed for EVERY uuid-PK table on
    // EVERY run — and on SQLite there is no ALTER COLUMN, so the recreate-and-copy
    // path rebuilt the WHOLE table each time.
    expect(up).toContain("lower(hex(randomblob(16)))");

    await assertConverged(expected);
  });

  test("IDEMPOTENCE: an FK whose TARGET PK is a uuid converges (name and type)", async () => {
    const { up, expected } = await migrate(original());
    // videos.thumbnail_asset_id -> media_assets.id, i.e. a long-PK table holding an
    // FK into a uuid-PK table. Generators that hardcoded the PK type emitted
    // `Column<Long>.references(Column<UUID>)`, which did not compile.
    expect(up).toContain(`REFERENCES "media_assets" ("id")`);
    await assertConverged(expected);
  });

  // ---------------------------------------------------------------------------
  // Gate 2 — VALUE SEMANTICS (what the engine ACTUALLY stored)
  // ---------------------------------------------------------------------------

  test("VALUE SEMANTICS: the uuid PK default generates a real, unique, non-null id", async () => {
    await migrate(original());
    await insertTakingDefaults("a");
    await insertTakingDefaults("b");

    const r = await row(`SELECT typeof("id") AS t, "id" AS id FROM "media_assets" WHERE "storage_key" = 'a'`);
    expect(r["t"]).toBe("text");
    // lower(hex(randomblob(16))) → 32 lowercase hex chars.
    expect(String(r["id"])).toMatch(/^[0-9a-f]{32}$/);

    const distinct = await row(
      `SELECT COUNT(DISTINCT "id") AS c, COUNT(*) AS n FROM "media_assets"`,
    );
    expect(Number(distinct["c"])).toBe(2);
    expect(Number(distinct["n"])).toBe(2);
  });

  test("VALUE SEMANTICS: a boolean @default false is stored as INTEGER 0, so `= 0` matches", async () => {
    await migrate(original());
    await insertTakingDefaults("a");

    const r = await row(`SELECT typeof("archived") AS t, "archived" AS v FROM "media_assets"`);
    // The bug: `DEFAULT 'false'` on a numeric-affinity column stores the TEXT "false".
    // Idempotence was BLIND to this — emit and introspect agreed on 'false' and converged.
    expect(r["t"]).toBe("integer");
    expect(r["v"]).toBe(0);

    // …and the consequence that actually bites: the filter silently misses the row.
    const hits = await row(`SELECT COUNT(*) AS c FROM "media_assets" WHERE "archived" = 0`);
    expect(Number(hits["c"])).toBe(1);
  });

  test("VALUE SEMANTICS: a paren-bearing string default is stored LITERALLY, not evaluated", async () => {
    await migrate(original());
    await insertTakingDefaults("a");
    // `n/a (unknown)` — the parens made the literal look like a SQL expression, so it
    // was emitted unquoted and the schema never converged (perpetual rebuild).
    const r = await row(`SELECT typeof("caption") AS t, "caption" AS v FROM "media_assets"`);
    expect(r["t"]).toBe("text");
    expect(r["v"]).toBe("n/a (unknown)");
  });

  test("VALUE SEMANTICS: a quote-bearing string default round-trips its apostrophe", async () => {
    await migrate(original());
    await insertTakingDefaults("a");
    // `don't know` — the '' escaping was asymmetric between emit and introspect, so the
    // default never compared equal and the table rebuilt on every migrate.
    const r = await row(`SELECT "alt_text" AS v FROM "media_assets"`);
    expect(r["v"]).toBe("don't know");
  });

  test("VALUE SEMANTICS: @autoSet onCreate stores a real timestamp (not the text 'now()')", async () => {
    const { up } = await migrate(original());
    // `DEFAULT now()` is Postgres-only — emitting it on SQLite produced a migration
    // that could not even be APPLIED (`near "(": syntax error`).
    expect(up).not.toContain("now()");

    await insertTakingDefaults("a");
    const r = await row(`SELECT "created_at" AS v FROM "media_assets"`);
    expect(r["v"]).not.toBeNull();
    expect(String(r["v"])).toMatch(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/);
  });

  test("VALUE SEMANTICS: the enum CHECK actually rejects a value outside @values", async () => {
    await migrate(original());
    await insertTakingDefaults("ok", "IMAGE");
    expect(insertTakingDefaults("bad", "DOCUMENT")).rejects.toThrow();
  });

  test("VALUE SEMANTICS: the partial UNIQUE index stays PARTIAL (its WHERE is not dropped)", async () => {
    const { up } = await migrate(original());
    // Dropping the `@where` silently promoted a partial UNIQUE to a FULL one — which
    // then rejects perfectly legal rows in production.
    expect(up).toContain(`WHERE (caption IS NOT NULL)`);

    // Two rows with the SAME storage_key but caption NULL: excluded from the partial
    // index, so both are legal. A full UNIQUE would reject the second.
    await sql
      .raw(`INSERT INTO "media_assets" ("storage_key", "kind", "caption") VALUES ('dup', 'IMAGE', NULL)`)
      .execute(k);
    await sql
      .raw(`INSERT INTO "media_assets" ("storage_key", "kind", "caption") VALUES ('dup', 'IMAGE', NULL)`)
      .execute(k);
    const n = await row(`SELECT COUNT(*) AS c FROM "media_assets" WHERE "storage_key" = 'dup'`);
    expect(Number(n["c"])).toBe(2);
  });

  // ---------------------------------------------------------------------------
  // Evolution — the change that was silently NEVER migrated
  // ---------------------------------------------------------------------------

  test("EVOLUTION: changing enum @values migrates the CHECK — the new member becomes insertable", async () => {
    await migrate(original());
    await insertTakingDefaults("a", "IMAGE");
    // Before the change the CHECK must reject DOCUMENT.
    expect(insertTakingDefaults("pre", "DOCUMENT")).rejects.toThrow();

    // Widen @values on MediaAsset.kind.
    const json = JSON.parse(original());
    const mediaAsset = json["metadata.root"].children.find(
      (c: { "object.entity"?: { name: string } }) => c["object.entity"]?.name === "MediaAsset",
    )["object.entity"];
    const kind = mediaAsset.children.find(
      (c: { "field.enum"?: { name: string } }) => c["field.enum"]?.name === "kind",
    )["field.enum"];
    kind["@values"] = ["IMAGE", "VIDEO", "AUDIO", "DOCUMENT"];

    // On SQLite a CHECK is create-time-only, so this must route through
    // recreate-and-copy. The bug: the CHECK change was never diffed at all, so the
    // stale CHECK survived and every DOCUMENT insert failed in production.
    //
    // allow.dropCheck is REQUIRED and that is intentional: evolving a CHECK is a
    // drop+add pair, and drop-check is a gated destructive change (same on Postgres).
    // Widening an enum therefore needs an explicit opt-in — it is not silent.
    const allow = { dropCheck: true };
    const { expected } = await migrate(JSON.stringify(json), allow);

    // Existing data survived the recreate-and-copy…
    const kept = await row(`SELECT COUNT(*) AS c FROM "media_assets" WHERE "storage_key" = 'a'`);
    expect(Number(kept["c"])).toBe(1);

    // …the new member is now insertable…
    await insertTakingDefaults("post", "DOCUMENT");
    const n = await row(`SELECT COUNT(*) AS c FROM "media_assets" WHERE "kind" = 'DOCUMENT'`);
    expect(Number(n["c"])).toBe(1);

    // …a value still outside @values is STILL rejected (the CHECK was migrated, not dropped)…
    expect(insertTakingDefaults("nope", "SPREADSHEET")).rejects.toThrow();

    // …and the schema converged.
    await assertConverged(expected, allow);
  });
});

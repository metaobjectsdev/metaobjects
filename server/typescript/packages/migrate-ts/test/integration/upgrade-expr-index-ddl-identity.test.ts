/**
 * The claim `meta upgrade` makes when it drops `@fields` beside `@expr` (#342), gated
 * against a real engine.
 *
 * The command tells an adopter that dropping `@fields` "changes no emitted DDL", and that
 * sentence is the entire reason the fix is AUTOMATED rather than refused like
 * `@status: abandoned`. It rests on `migrate-ts` having always run `columns: expr ? [] : cols`
 * — so a node declaring both produced an EXPRESSION index and the `@fields` half was
 * discarded. That is a statement about the migrate engine, and until this file nothing
 * checked it: the `meta upgrade` tests prove the metadata loads afterwards, which is a
 * different claim.
 *
 * IT CANNOT DIFF BEFORE AGAINST AFTER, and says so rather than faking it. The "before" no
 * longer loads — that is what #342 changed — so there is no legacy DDL to emit. What IS
 * checkable is the pair of statements the sentence decomposes into:
 *
 *   1. upgrade(both) emits BYTE-IDENTICAL DDL to hand-authored `@expr`-only, and
 *   2. that DDL differs from hand-authored `@fields`-only.
 *
 * Without (2), (1) would also hold if every arm emitted a plain column index — so (2) is
 * what makes the identity meaningful, and it is also the evidence for the other half of the
 * command's advice: keeping `@fields` instead would have emitted a migration against live
 * data.
 *
 * Then the round trip this repo requires of any migrate change: emit → apply to a real
 * engine → introspect → re-diff must be EMPTY, plus asking the engine what it actually
 * stored rather than trusting the SQL we just printed.
 *
 * ONE REWRITER ARM, NOT TWO. The YAML rewriter reaches the same metadata by a different
 * route and is gated in `cli/test/upgrade-index-key-contradiction.test.ts`; the DDL below is
 * a property of the metadata after the rewrite, not of the syntax it arrived in.
 *
 * BOTH DIALECTS, and the split is deliberate. The emit comparison needs no database — a diff
 * against an empty snapshot is enough — so `sqlite` AND `postgres` are both compared on every
 * run, in the fast lane. Only the engine round trip needs a server: sqlite gets one from
 * libsql unconditionally, and the Postgres one self-skips without `MIGRATE_TS_PG_URL` exactly
 * like every other pg suite here, running in `ts-slow`. Postgres is where `@expr` originally
 * shipped and where introspection reads an expression key back through `pg_get_expr`, so
 * gating the claim on sqlite alone would have left the original dialect uncovered.
 */

import { test, expect, beforeAll, afterAll, beforeEach, afterEach, describe } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { Kysely, PostgresDialect, sql } from "kysely";
import { LibsqlDialect } from "@libsql/kysely-libsql";
import {
  MetaDataLoader,
  InMemoryStringSource,
  rewriteDocument,
  type MetaData,
} from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../../src/expected-schema.js";
import { introspectSqlite } from "../../src/introspect/sqlite.js";
import { introspectPostgres } from "../../src/introspect/postgres.js";
import { diff } from "../../src/diff/index.js";
import { emit } from "../../src/emit/index.js";

/** Same entity three ways; only the index node's key declaration differs. */
function estate(indexNode: string): string {
  return `{
  "metadata.root": {
    "package": "acme",
    "children": [
      { "object.entity": {
          "name": "Account",
          "children": [
            { "source.rdb": {} },
            { "field.long": { "name": "id" } },
            { "field.string": { "name": "email", "@required": true } },
            { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } },
            ${indexNode}
          ]
      }}
    ]
  }
}`;
}

/** The legacy spelling: loaded before 0.24.1, with `@fields` silently discarded. */
const LEGACY = estate(
  `{ "index.lookup": { "name": "ix_email_lower", "@fields": ["email"], "@expr": "lower(email)" } }`,
);
/** What `meta upgrade` should produce. */
const EXPR_ONLY = estate(
  `{ "index.lookup": { "name": "ix_email_lower", "@expr": "lower(email)" } }`,
);
/** The other candidate resolution — the one that would have been wrong. */
const FIELDS_ONLY = estate(
  `{ "index.lookup": { "name": "ix_email_lower", "@fields": ["email"] } }`,
);

let tmpDir: string;
let k: Kysely<Record<string, unknown>>;

beforeEach(() => {
  // A libsql `:memory:` database is PER-CONNECTION, so an apply and a later introspect
  // would see different databases. A temp file is the only shape that proves anything.
  tmpDir = mkdtempSync(join(tmpdir(), "migrate-ts-upgrade-expr-"));
  k = new Kysely({ dialect: new LibsqlDialect({ url: `file:${join(tmpDir, "t.db")}` }) });
});
afterEach(async () => {
  await k.destroy();
  rmSync(tmpDir, { recursive: true, force: true });
});

async function loadOrThrow(json: string): Promise<MetaData> {
  const result = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
  if (result.errors.length > 0) {
    throw new Error(result.errors.map((e) => e.message).join("\n"));
  }
  return result.root;
}

/**
 * The DDL a fresh `meta migrate` emits for this metadata against a database with nothing in
 * it — computed OFFLINE, so the comparison runs for every dialect without a server.
 */
async function ddlOffline(json: string, dialect: "sqlite" | "postgres"): Promise<string> {
  const expected = buildExpectedSchema(await loadOrThrow(json), { dialect });
  const initial = await diff({ expected, actual: { tables: [], views: [] }, dialect });
  return emit(initial.changes, { dialect, expectedSchema: expected }).up;
}

/** The DDL a fresh `meta migrate` would emit for this metadata against an empty database. */
async function ddlFromEmpty(json: string): Promise<string> {
  const expected = buildExpectedSchema(await loadOrThrow(json), { dialect: "sqlite" });
  const actual0 = await introspectSqlite(k);
  const initial = await diff({ expected, actual: actual0, dialect: "sqlite" });
  const { up } = emit(initial.changes, {
    dialect: "sqlite",
    expectedSchema: expected,
    ...(actual0.meta !== undefined && { actualMeta: actual0.meta }),
  });
  return up;
}

async function applyRaw(sqlText: string): Promise<void> {
  for (const stmt of sqlText.trim().split(";").map((s) => s.trim()).filter(Boolean)) {
    await sql.raw(stmt).execute(k);
  }
}

describe("the rewrite is what makes the legacy spelling loadable", () => {
  test("it does not load before, and does after", async () => {
    await expect(loadOrThrow(LEGACY)).rejects.toThrow(/declares BOTH/);
    const upgraded = rewriteDocument(LEGACY);
    expect(upgraded.changes.map((c) => c.attr)).toEqual(["fields"]);
    await expect(loadOrThrow(upgraded.text)).resolves.toBeDefined();
  });
});

for (const dialect of ["sqlite", "postgres"] as const) {
  describe(`dropping @fields beside @expr changes no emitted DDL — ${dialect}`, () => {
    test("upgrade(both) emits BYTE-IDENTICAL DDL to hand-authored @expr-only", async () => {
      const upgraded = await ddlOffline(rewriteDocument(LEGACY).text, dialect);
      const authored = await ddlOffline(EXPR_ONLY, dialect);
      expect(upgraded).toBe(authored);
    });

    // Without this the identity above would be satisfied by both arms emitting the same
    // WRONG thing. It is also the evidence for the advice not to keep `@fields` instead:
    // that resolution is a different index, so it would migrate a live database.
    test("...and that DDL is NOT what @fields-only emits — the two resolutions differ", async () => {
      const upgraded = await ddlOffline(rewriteDocument(LEGACY).text, dialect);
      const fieldsOnly = await ddlOffline(FIELDS_ONLY, dialect);
      expect(upgraded).not.toBe(fieldsOnly);
      expect(upgraded).toContain("lower(email)");
      expect(fieldsOnly).not.toContain("lower(email)");
    });
  });
}

describe("the upgraded metadata survives the engine round trip — sqlite", () => {
  test("emit → apply → introspect → re-diff is EMPTY", async () => {
    const json = rewriteDocument(LEGACY).text;
    await applyRaw(await ddlFromEmpty(json));

    const expected = buildExpectedSchema(await loadOrThrow(json), { dialect: "sqlite" });
    const followup = await diff({ expected, actual: await introspectSqlite(k), dialect: "sqlite" });
    if (followup.changes.length > 0) {
      console.error("ROUND-TRIP FAILURE — a second `meta migrate` would emit:");
      for (const c of followup.changes) console.error("  -", JSON.stringify(c));
    }
    expect(followup.changes).toEqual([]);
  });

  // Ask the ENGINE what it stored. The assertions above read SQL this repo generated; this
  // one reads the object the database actually built from it.
  test("the engine holds an EXPRESSION index, not a plain column one", async () => {
    await applyRaw(await ddlFromEmpty(rewriteDocument(LEGACY).text));
    const row = (await sql
      .raw(`SELECT sql FROM sqlite_master WHERE type='index' AND name='ix_email_lower'`)
      .execute(k)).rows[0] as { sql: string } | undefined;
    expect(row?.sql ?? "").toContain("lower(email)");
  });
});

// ── Postgres, the dialect `@expr` originally shipped on ─────────────────────────────────
//
// Gated on MIGRATE_TS_PG_URL and self-skipping without it, exactly like every other pg suite
// here; the ts-slow lane supplies the sidecar. The offline emit comparison above already
// covers this dialect on every run — what only a server can answer is whether Postgres reads
// an expression key back (through `pg_get_expr`) well enough for the re-diff to converge.
const PG_URL = process.env["MIGRATE_TS_PG_URL"];
const pgDescribe = PG_URL ? describe : describe.skip;

pgDescribe("the upgraded metadata survives the engine round trip — postgres", () => {
  let pg: Kysely<Record<string, unknown>>;

  beforeAll(() => {
    pg = new Kysely({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: PG_URL }) }) });
  });
  afterAll(async () => {
    await sql.raw(`DROP TABLE IF EXISTS "accounts" CASCADE`).execute(pg);
    await pg.destroy();
  });

  async function pgApply(sqlText: string): Promise<void> {
    for (const stmt of sqlText.trim().split(";").map((x) => x.trim()).filter(Boolean)) {
      await sql.raw(stmt).execute(pg);
    }
  }

  test("emit → apply → introspect → re-diff is EMPTY, and the key is the expression", async () => {
    await sql.raw(`DROP TABLE IF EXISTS "accounts" CASCADE`).execute(pg);
    const json = rewriteDocument(LEGACY).text;
    const root = await loadOrThrow(json);

    const expected = buildExpectedSchema(root, { dialect: "postgres" });
    const actual0 = await introspectPostgres(pg);
    const initial = await diff({ expected, actual: actual0, dialect: "postgres" });
    await pgApply(emit(initial.changes, { dialect: "postgres", expectedSchema: expected }).up);

    const followup = await diff({
      expected,
      actual: await introspectPostgres(pg),
      dialect: "postgres",
    });
    if (followup.changes.length > 0) {
      console.error("ROUND-TRIP FAILURE — a second `meta migrate` would emit:");
      for (const c of followup.changes) console.error("  -", JSON.stringify(c));
    }
    expect(followup.changes).toEqual([]);

    // Ask the ENGINE. `indexdef` is rendered by Postgres from the stored expression, not
    // echoed back from the DDL this repo emitted.
    const row = (await sql
      .raw(`SELECT indexdef FROM pg_indexes WHERE indexname = 'ix_email_lower'`)
      .execute(pg)).rows[0] as { indexdef: string } | undefined;
    expect(row?.indexdef ?? "").toContain("lower");
  });
});

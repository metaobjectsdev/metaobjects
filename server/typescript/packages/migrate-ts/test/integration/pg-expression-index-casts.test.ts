/**
 * The cast half of "an `index.lookup @expr` written the way a person writes it must not
 * read as drift". Companion to pg-expression-index-spacing.test.ts, which closed the
 * whitespace axis and left three cast shapes still drifting FOREVER:
 *
 *   1. the paren-strip's own space   authored `x::integer`  vs PG `(x)::integer`
 *   2. a cast target ALIAS           authored `::int`       vs PG `::integer`
 *   3. a cast PG adds or elides      authored `(p->>'k')::text` vs PG `(p ->> 'k'::text)`
 *                                    authored `amt > 0`     vs PG `amt > (0)::numeric`
 *
 * In each case `verify --db` reported drift and `migrate` proposed DROP + CREATE against an
 * index the database already held, declared exactly as it stood — on every run, forever.
 *
 * Shape 3 was NOT in the field report. It came from running this differential: author an
 * expression, let Postgres store it, read back what it hands over, and ask the comparator
 * whether it sees drift. A unit test over the normalizer cannot find that, because it can
 * only converge on the string a human GUESSED Postgres returns.
 *
 * So, per this package's doctrine, the gate is a real engine:
 *   1. Create each index from the AUTHORED spelling.
 *   2. Assert what PG actually stored (so a future PG that re-emits differently fails HERE
 *      rather than silently making every case below vacuous).
 *   3. Diff metadata carrying the authored spelling against it → MUST be empty.
 *   4. Prove the gate can still convict: a genuinely different cast TARGET is drift.
 *
 * Skips gracefully when MIGRATE_TS_PG_URL is not set (ts-slow CI provides a PG sidecar).
 */

import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import { Pool } from "pg";
import { Kysely, PostgresDialect, sql } from "kysely";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../../src/expected-schema.js";
import { introspectPostgres } from "../../src/introspect/postgres.js";
import { diff } from "../../src/diff/index.js";

const PG_URL = process.env["MIGRATE_TS_PG_URL"];

/**
 * The authored spellings under test, each becoming one index named for its case. The index
 * NAME matches the metadata name on purpose: a name mismatch presents as drop+add too, and
 * would mask the expression comparison that is the thing under test.
 */
const CASES: ReadonlyArray<{ name: string; authored: string; pgKeeps: string }> = [
  // 1 + 2: the paren-strip space AND the `int` -> `integer` respelling, together.
  { name: "byKeyInt", authored: "((payload->>'k')::int)", pgKeeps: "::integer" },
  // 2 alone, on a different alias family.
  { name: "byKeyBig", authored: "((payload->>'n')::int8)", pgKeeps: "::bigint" },
  // 3a: `->>` returns text, so PG DROPS the author's explicit cast.
  { name: "byDeviceText", authored: "((payload->>'device_id')::text)", pgKeeps: "->> 'device_id'::text" },
  // 3b: PG ADDS a cast to a bare numeric literal to match the column type.
  { name: "byPositiveAmt", authored: "(amt > 0)", pgKeeps: "::numeric" },
];

const meta = (indexes: ReadonlyArray<{ name: string; expr: string }>): string =>
  JSON.stringify({
    "metadata.root": {
      package: "acme",
      children: [
        {
          "object.entity": {
            name: "Ledger",
            children: [
              { "source.rdb": { "@table": "ledger" } },
              { "field.long": { name: "id" } },
              // An open/untyped JSON map, spelled the way the loader's own error prescribes.
              { "field.string": { name: "payload", "@column": "payload", "@dbColumnType": "jsonb" } },
              { "field.decimal": { name: "amt", "@column": "amt", "@precision": 10, "@scale": 2 } },
              { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
              ...indexes.map((ix) => ({ "index.lookup": { name: ix.name, "@expr": ix.expr } })),
            ],
          },
        },
      ],
    },
  });

const asAuthored = CASES.map((c) => ({ name: c.name, expr: c.authored }));

describe("a cast-bearing expression index written the human way is not drift (PG)", () => {
  if (!PG_URL) {
    test.skip("skipped — MIGRATE_TS_PG_URL not set", () => {});
    return;
  }

  let kysely: Kysely<Record<string, unknown>>;
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG_URL });
    kysely = new Kysely<Record<string, unknown>>({ dialect: new PostgresDialect({ pool }) });
    await sql.raw("DROP TABLE IF EXISTS ledger CASCADE").execute(kysely);
    await sql
      .raw(
        `CREATE TABLE ledger (
           id bigserial PRIMARY KEY,
           payload jsonb,
           amt numeric(10,2)
         )`,
      )
      .execute(kysely);
    // Created from the AUTHORED spelling. Postgres stores its own rendering.
    for (const c of CASES) {
      await sql.raw(`CREATE INDEX "${c.name}" ON ledger (${c.authored})`).execute(kysely);
    }
  });

  afterAll(async () => {
    await sql.raw("DROP TABLE IF EXISTS ledger CASCADE").execute(kysely);
    await pool.end();
  });

  test("PG really does respell each cast (the gate is not vacuous)", async () => {
    const actual = await introspectPostgres(kysely);
    const indexes = actual.tables.find((t) => t.name === "ledger")?.indexes ?? [];
    for (const c of CASES) {
      const ix = indexes.find((i) => i.name === c.name);
      expect(`${c.name}: ${ix?.expr ?? "<missing>"}`).toContain(c.pgKeeps);
      // Every case must differ TEXTUALLY from what was authored, or it is not exercising
      // anything: a future PG that echoed the author back would make this file pass while
      // proving nothing, and this is the line that would say so.
      expect(`${c.name}: ${ix?.expr}`).not.toBe(`${c.name}: ${c.authored}`);
    }
  });

  test("REGRESSION: every authored spelling diffs EMPTY against the live index", async () => {
    const loaded = await new MetaDataLoader().load([new InMemoryStringSource(meta(asAuthored))]);
    expect(loaded.errors).toEqual([]);

    const actual = await introspectPostgres(kysely);
    const d = await diff({
      expected: buildExpectedSchema(loaded.root, { dialect: "postgres" }),
      actual,
      dialect: "postgres",
      allow: { dropIndex: true },
    });
    // Pre-fix each of these was drop-index + add-index against an index already correct.
    expect(JSON.stringify(d.changes)).toBe("[]");
  });

  test("...and so does the spelling PG itself hands back", async () => {
    // The other direction of idempotency: feeding the introspected text back as the
    // authored `@expr` must also be clean, else `migrate --from-db` churns on its own output.
    const actual = await introspectPostgres(kysely);
    const indexes = actual.tables.find((t) => t.name === "ledger")?.indexes ?? [];
    const roundTripped = CASES.map((c) => ({
      name: c.name,
      expr: indexes.find((i) => i.name === c.name)?.expr ?? "",
    }));
    expect(roundTripped.every((r) => r.expr !== "")).toBe(true);

    const loaded = await new MetaDataLoader().load([new InMemoryStringSource(meta(roundTripped))]);
    expect(loaded.errors).toEqual([]);
    const d = await diff({
      expected: buildExpectedSchema(loaded.root, { dialect: "postgres" }),
      actual,
      dialect: "postgres",
      allow: { dropIndex: true },
    });
    expect(JSON.stringify(d.changes)).toBe("[]");
  });

  test("the gate can still CONVICT: a different cast TARGET is drift", async () => {
    // A comparator that canonicalizes aliases must not canonicalize away the DISTINCTION.
    // `int` and `int8` are both aliases; they are not the same type.
    const loaded = await new MetaDataLoader().load([
      new InMemoryStringSource(meta([{ name: "byKeyInt", expr: "((payload->>'k')::int8)" }])),
    ]);
    expect(loaded.errors).toEqual([]);
    const actual = await introspectPostgres(kysely);
    const d = await diff({
      expected: buildExpectedSchema(loaded.root, { dialect: "postgres" }),
      actual,
      dialect: "postgres",
      allow: { dropIndex: true },
    });
    expect(d.changes.some((c) => c.kind === "drop-index")).toBe(true);
    expect(d.changes.some((c) => c.kind === "add-index")).toBe(true);
  });

  test("the gate can still CONVICT: a different jsonb KEY is drift", async () => {
    const loaded = await new MetaDataLoader().load([
      new InMemoryStringSource(meta([{ name: "byKeyInt", expr: "((payload->>'other')::int)" }])),
    ]);
    expect(loaded.errors).toEqual([]);
    const actual = await introspectPostgres(kysely);
    const d = await diff({
      expected: buildExpectedSchema(loaded.root, { dialect: "postgres" }),
      actual,
      dialect: "postgres",
      allow: { dropIndex: true },
    });
    expect(d.changes.some((c) => c.kind === "drop-index")).toBe(true);
  });
});

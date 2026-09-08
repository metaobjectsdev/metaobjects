/**
 * An `index.lookup @expr` written the way a person writes it must not read as drift.
 *
 * `pg_get_expr` re-emits every operator SPACED and appends casts:
 *
 *   authored     (request_context->>'device_id')
 *   introspected ((request_context ->> 'device_id'::text))
 *
 * The comparator already canonicalized the casts and the redundant parens, so the ONE
 * surviving difference was the whitespace around the operator — and it was the one
 * difference a human actually produces. `verify --db` therefore reported drift, and
 * `migrate` proposed DROP + CREATE, against an index the database already held exactly
 * as declared. Found by an adopter estate running the 1.0 RC: its own README told it to
 * retire a hand-written index adjunct "the moment #342 ships", and following that
 * instruction produced a proposed DROP against a live production index.
 *
 * A unit test over the normalizer proves the strings converge. It cannot prove that the
 * string PG hands back is the one being converged ON — which is the half that was wrong.
 * So the gate is a REAL engine, per this package's doctrine:
 *   1. Create the index in Postgres from the AUTHORED spelling.
 *   2. Read back what PG actually stored (asserted, so a future PG that re-emits
 *      differently fails HERE rather than silently making the test vacuous).
 *   3. Diff metadata carrying the natural tight spelling against it → MUST be empty.
 *   4. Prove the gate can still convict: a genuinely different expression → drift.
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

/** `expr` is the authored spelling under test. */
const meta = (expr: string): string =>
  JSON.stringify({
    "metadata.root": {
      package: "acme",
      children: [
        {
          "object.entity": {
            name: "Notification",
            children: [
              { "source.rdb": { "@table": "notification" } },
              { "field.long": { name: "id" } },
              // An open/untyped JSON map: a `field.string` with a jsonb physical type, which
              // is what the loader's own error message prescribes for a bare object.
              { "field.string": { name: "requestContext", "@column": "request_context", "@dbColumnType": "jsonb" } },
              { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
              { "index.lookup": { name: "byDevice", "@expr": expr } },
            ],
          },
        },
      ],
    },
  });

describe("an expression index written the human way is not drift (PG)", () => {
  if (!PG_URL) {
    test.skip("skipped — MIGRATE_TS_PG_URL not set", () => {});
    return;
  }

  let kysely: Kysely<Record<string, unknown>>;
  let pool: Pool;

  const reset = async (): Promise<void> => {
    await sql.raw("DROP TABLE IF EXISTS notification CASCADE").execute(kysely);
    await sql
      .raw(
        `CREATE TABLE notification (
           id bigserial PRIMARY KEY,
           request_context jsonb
         )`,
      )
      .execute(kysely);
    // Created from the AUTHORED spelling — tight, no cast. PG stores its own rendering.
    // Named as the metadata names it, so the diff compares EXPRESSIONS: an index-name
    // mismatch presents as drop+add too, and would mask the thing under test.
    await sql
      .raw(
        `CREATE INDEX "byDevice"
           ON notification ((request_context->>'device_id'))`,
      )
      .execute(kysely);
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG_URL });
    kysely = new Kysely<Record<string, unknown>>({ dialect: new PostgresDialect({ pool }) });
    await reset();
  });

  afterAll(async () => {
    await sql.raw("DROP TABLE IF EXISTS notification CASCADE").execute(kysely);
    await pool.end();
  });

  test("PG really does re-emit the expression spaced and cast", async () => {
    // Asserted rather than assumed. If a future Postgres rendered the expression the way
    // it was authored, every case below would pass while proving nothing, and this is the
    // line that would tell us.
    const actual = await introspectPostgres(kysely);
    const ix = actual.tables
      .find((t) => t.name === "notification")
      ?.indexes?.find((i) => i.name === "byDevice");
    expect(ix).toBeDefined();
    expect(ix?.expr).toBeDefined();
    expect(ix?.expr).toContain(" ->> ");   // spaced — the difference that caused the drift
    expect(ix?.expr).toContain("::text");  // and cast
  });

  test("REGRESSION: the natural tight spelling diffs EMPTY against the live index", async () => {
    const loaded = await new MetaDataLoader().load([
      new InMemoryStringSource(meta("(request_context->>'device_id')")),
    ]);
    expect(loaded.errors).toEqual([]);

    const actual = await introspectPostgres(kysely);
    const d = await diff({
      expected: buildExpectedSchema(loaded.root, { dialect: "postgres" }),
      actual,
      dialect: "postgres",
      allow: { dropIndex: true },
    });
    // Pre-fix this was drop-index + add-index against an index already correct.
    expect(d.changes.filter((c) => c.kind === "drop-index" || c.kind === "add-index")).toEqual([]);
    expect(d.changes).toEqual([]);
  });

  test("...and every other spelling of the same expression agrees with it", async () => {
    const actual = await introspectPostgres(kysely);
    for (const authored of [
      "(request_context ->> 'device_id')",
      "((request_context ->> 'device_id'))",
      "((request_context ->> 'device_id'::text))",
      "((request_context->>'device_id'::text))",
    ]) {
      const loaded = await new MetaDataLoader().load([new InMemoryStringSource(meta(authored))]);
      expect(loaded.errors).toEqual([]);
      const d = await diff({
        expected: buildExpectedSchema(loaded.root, { dialect: "postgres" }),
        actual,
        dialect: "postgres",
        allow: { dropIndex: true },
      });
      expect(`${authored}: ${JSON.stringify(d.changes)}`).toBe(`${authored}: []`);
    }
  });

  test("the gate can still CONVICT: a genuinely different key is drift", async () => {
    // The other half. A comparator that erases whitespace must not erase the key.
    const loaded = await new MetaDataLoader().load([
      new InMemoryStringSource(meta("(request_context->>'session_id')")),
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
});

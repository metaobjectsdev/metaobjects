/**
 * CHECK constraints the schema already guarantees.
 *
 *  - `skipRedundantChecks` on the build (`migrate.checks.skipRedundant` in the project config,
 *    off by default so nothing changes for an existing project): a `validator.length` bound the
 *    column's VARCHAR(n) already enforces, and a minimum of 0 (always true), emit nothing; the
 *    rest of the check stands.
 *  - It is not a schema convention: the efcore conventions alone emit every CHECK.
 *  - Not on SQLite / D1, which accept a declared length and store longer values anyway: there
 *    the length CHECK is the only thing enforcing it.
 */
import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../../src/expected-schema.js";
import { defaultConventions, efcoreConventions } from "../../src/schema-conventions.js";
import { baselineFromMetadata, planOffline } from "../../src/snapshot/plan.js";
import { computeDriftFromActual } from "../../src/drift/drift.js";

async function root(lengthValidator: Record<string, unknown>, maxLength?: number) {
  const doc = { "metadata.root": { package: "acme", children: [
    { "object.entity": { name: "Ticket", children: [
      { "source.rdb": { "@table": "tickets" } },
      { "field.long": { name: "id" } },
      { "field.string": { name: "code", ...(maxLength !== undefined ? { "@maxLength": maxLength } : {}), children: [
        { "validator.length": { name: "len", ...lengthValidator } },
      ] } },
      { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
    ] } },
  ] } };
  const { root, errors } = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(doc))]);
  expect(errors).toHaveLength(0);
  return root;
}

const checksOf = (s: ReturnType<typeof buildExpectedSchema>) =>
  s.tables.find((t) => t.name === "tickets")!.checks.map((c) => c.expression);

const skip = { skipRedundantChecks: true } as const;

describe("redundant CHECKs", () => {
  test("by default: unchanged — the length check is emitted whole", async () => {
    const r = await root({ "@min": 0, "@max": 3 }, 3);
    expect(checksOf(buildExpectedSchema(r))).toEqual(['length("code") >= 0 AND length("code") <= 3']);
    expect(checksOf(buildExpectedSchema(r, { skipRedundantChecks: false }))).toEqual(['length("code") >= 0 AND length("code") <= 3']);
  });

  test("the efcore conventions alone skip nothing", async () => {
    const r = await root({ "@min": 0, "@max": 3 }, 3);
    expect(checksOf(buildExpectedSchema(r, { conventions: efcoreConventions }))).toEqual(['length("code") >= 0 AND length("code") <= 3']);
    expect(checksOf(buildExpectedSchema(r, { conventions: defaultConventions, ...skip }))).toEqual([]);
  });

  test("a max the VARCHAR(n) enforces and a min of 0 emit no check", async () => {
    const r = await root({ "@min": 0, "@max": 3 }, 3);
    expect(checksOf(buildExpectedSchema(r, skip))).toEqual([]);
  });

  test("a max looser than the VARCHAR(n) is redundant too; a real min stays", async () => {
    const r = await root({ "@min": 2, "@max": 10 }, 3);
    expect(checksOf(buildExpectedSchema(r, skip))).toEqual(['length("code") >= 2']);
  });

  test("a max tighter than the column, or on an unbounded column, stays", async () => {
    expect(checksOf(buildExpectedSchema(await root({ "@max": 2 }, 3), skip))).toEqual(['length("code") <= 2']);
    expect(checksOf(buildExpectedSchema(await root({ "@max": 2 }), skip))).toEqual(['length("code") <= 2']);
  });

  test("on SQLite the length check stays, since SQLite does not enforce VARCHAR(n)", async () => {
    const r = await root({ "@min": 0, "@max": 3 }, 3);
    expect(checksOf(buildExpectedSchema(r, { ...skip, dialect: "sqlite" }))).toEqual(['length("code") <= 3']);
  });
});

describe("skipRedundantChecks reaches every build", () => {
  test("the offline plan, the baseline and the drift computation pass it to the build", async () => {
    const r = await root({ "@min": 0, "@max": 3 }, 3);
    const empty = { tables: [], views: [] };
    const tableChecks = (s: { tables: { name: string; checks: unknown[] }[] }) => s.tables.find((t) => t.name === "tickets")!.checks;

    expect(tableChecks((await planOffline({ metadata: r, dialect: "postgres", snapshot: empty, ...skip })).expected)).toEqual([]);
    expect(tableChecks((await planOffline({ metadata: r, dialect: "postgres", snapshot: empty })).expected)).toHaveLength(1);
    expect(tableChecks(baselineFromMetadata(r, "postgres", undefined, skip))).toEqual([]);
    expect(tableChecks(baselineFromMetadata(r, "postgres"))).toHaveLength(1);

    // The database has the CHECK; skipping it makes it extra on the live side, not missing.
    const live = buildExpectedSchema(r, { dialect: "postgres" });
    const kinds = async (opts: { skipRedundantChecks?: boolean }) =>
      (await computeDriftFromActual(live, "postgres", r, opts)).changes.map((c) => c.kind);
    expect(await kinds({})).toEqual([]);
    expect(await kinds(skip)).toEqual(["drop-check"]);
  });
});

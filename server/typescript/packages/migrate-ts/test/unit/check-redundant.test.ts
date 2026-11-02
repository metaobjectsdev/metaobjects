/**
 * CHECK constraints the schema already guarantees.
 *
 *  - `skipRedundantChecks` on the schema conventions (on in the efcore preset, off by default so
 *    nothing changes for an existing project): a `validator.length` bound the column's
 *    VARCHAR(n) already enforces, and a minimum of 0 (always true), emit nothing; the rest of
 *    the check stands.
 *  - Not on SQLite / D1, which accept a declared length and store longer values anyway: there
 *    the length CHECK is the only thing enforcing it.
 */
import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../../src/expected-schema.js";
import { defaultConventions, efcoreConventions } from "../../src/schema-conventions.js";

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

describe("redundant CHECKs", () => {
  test("default conventions: unchanged — the length check is emitted whole", async () => {
    const r = await root({ "@min": 0, "@max": 3 }, 3);
    expect(checksOf(buildExpectedSchema(r, { conventions: defaultConventions }))).toEqual(['length("code") >= 0 AND length("code") <= 3']);
  });

  test("efcore: a max the VARCHAR(n) enforces and a min of 0 emit no check", async () => {
    const r = await root({ "@min": 0, "@max": 3 }, 3);
    expect(checksOf(buildExpectedSchema(r, { conventions: efcoreConventions }))).toEqual([]);
  });

  test("efcore: a max looser than the VARCHAR(n) is redundant too; a real min stays", async () => {
    const r = await root({ "@min": 2, "@max": 10 }, 3);
    expect(checksOf(buildExpectedSchema(r, { conventions: efcoreConventions }))).toEqual(['length("code") >= 2']);
  });

  test("efcore: a max tighter than the column, or on an unbounded column, stays", async () => {
    expect(checksOf(buildExpectedSchema(await root({ "@max": 2 }, 3), { conventions: efcoreConventions })))
      .toEqual(['length("code") <= 2']);
    expect(checksOf(buildExpectedSchema(await root({ "@max": 2 }), { conventions: efcoreConventions })))
      .toEqual(['length("code") <= 2']);
  });

  test("efcore on SQLite: the length check stays, since SQLite does not enforce VARCHAR(n)", async () => {
    const r = await root({ "@min": 0, "@max": 3 }, 3);
    expect(checksOf(buildExpectedSchema(r, { conventions: efcoreConventions, dialect: "sqlite" })))
      .toEqual(['length("code") <= 3']);
  });
});

/**
 * Both sides of one FK declare a relationship and disagree on its referential action.
 *
 * The documented precedence (ADR-0047; docs/features/relationships.md) lets the FK-owning
 * side govern: `Author` declaring `relationship.composition books` (cascade) while `Book`
 * declares `relationship.association author` (restrict) emits ON DELETE RESTRICT. An
 * external reviewer authored exactly that, expected the cascade the composition promised,
 * and got a 409 on DELETE with nothing anywhere saying the composition had no effect.
 * The precedence stands; the silence does not — the schema builder now reports it.
 */
import { test, expect, describe } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../../src/expected-schema.js";
import { describeReferentialActionConflict, type ReferentialActionConflict } from "../../src/referential-actions.js";

type Json = Record<string, unknown>;

function model(opts: { parentRel?: Json; childRel?: Json; refExtra?: Json }): string {
  return JSON.stringify({
    "metadata.root": {
      package: "acme",
      children: [
        {
          "object.entity": {
            name: "Author",
            children: [
              { "source.rdb": { "@table": "authors" } },
              { "field.long": { name: "id" } },
              { "identity.primary": { name: "pk", "@fields": ["id"] } },
              ...(opts.parentRel !== undefined ? [opts.parentRel] : []),
            ],
          },
        },
        {
          "object.entity": {
            name: "Book",
            children: [
              { "source.rdb": { "@table": "books" } },
              { "field.long": { name: "id" } },
              { "field.long": { name: "authorId", "@required": true } },
              { "identity.primary": { name: "pk", "@fields": ["id"] } },
              { "identity.reference": { name: "authorRef", "@fields": ["authorId"], "@references": "Author", ...opts.refExtra } },
              ...(opts.childRel !== undefined ? [opts.childRel] : []),
            ],
          },
        },
      ],
    },
  });
}

const COMPOSITION_BOOKS = { "relationship.composition": { name: "books", "@objectRef": "Book", "@cardinality": "many" } };
const ASSOCIATION_AUTHOR = { "relationship.association": { name: "author", "@objectRef": "Author", "@cardinality": "one" } };

async function build(src: string): Promise<{ onDelete: string | undefined; conflicts: ReferentialActionConflict[] }> {
  const loaded = await new MetaDataLoader().load([new InMemoryStringSource(src)]);
  expect(loaded.errors).toEqual([]);
  const conflicts: ReferentialActionConflict[] = [];
  const schema = buildExpectedSchema(loaded.root, { dialect: "postgres", onReferentialActionConflict: (c) => conflicts.push(c) });
  const fk = schema.tables.find((t) => t.name === "books")!.foreignKeys[0]!;
  return { onDelete: fk.onDelete, conflicts };
}

describe("a parent-side relationship the child side overrides", () => {
  test("REGRESSION: composition on the parent + association on the child — restrict governs, and it is reported", async () => {
    const r = await build(model({ parentRel: COMPOSITION_BOOKS, childRel: ASSOCIATION_AUTHOR }));
    expect(r.onDelete).toBe("restrict");
    expect(r.conflicts).toHaveLength(1);
    const c = r.conflicts[0]!;
    expect(c.onDelete).toEqual(["restrict", "cascade"]);
    expect(c.onUpdate).toBeUndefined();
    const msg = describeReferentialActionConflict(c);
    expect(msg).toContain(`Book.authorRef`);
    expect(msg).toContain(`relationship.composition "books"`);
    expect(msg).toContain(`ON DELETE restrict (not cascade)`);
    expect(msg).toContain("`onDelete: cascade` on Book's identity.reference \"authorRef\"");
  });

  test("the parent side alone is honored: composition cascades, nothing to report", async () => {
    const r = await build(model({ parentRel: COMPOSITION_BOOKS }));
    expect(r.onDelete).toBe("cascade");
    expect(r.conflicts).toEqual([]);
  });

  test("an action declared on the reference settles it: no report", async () => {
    const r = await build(model({ parentRel: COMPOSITION_BOOKS, childRel: ASSOCIATION_AUTHOR, refExtra: { "@onDelete": "cascade" } }));
    expect(r.onDelete).toBe("cascade");
    expect(r.conflicts).toEqual([]);
  });

  test("two sides that agree are not a conflict", async () => {
    const childComposition = { "relationship.association": { name: "author", "@objectRef": "Author", "@cardinality": "one", "@onDelete": "cascade" } };
    const r = await build(model({ parentRel: COMPOSITION_BOOKS, childRel: childComposition }));
    expect(r.onDelete).toBe("cascade");
    expect(r.conflicts).toEqual([]);
  });

  test("an inferred set-null the NOT NULL FK could never honor is not reported", async () => {
    const aggregation = { "relationship.aggregation": { name: "books", "@objectRef": "Book", "@cardinality": "many" } };
    const r = await build(model({ parentRel: aggregation, childRel: ASSOCIATION_AUTHOR }));
    expect(r.onDelete).toBe("restrict");
    expect(r.conflicts).toEqual([]);
  });
});

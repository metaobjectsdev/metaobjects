/**
 * Guard: ON DELETE SET NULL requires nullable FK columns.
 *
 * Emitting SET NULL on a NOT NULL column is a Postgres/SQLite error at
 * runtime. buildExpectedSchema() must surface this conflict early — before
 * diff or emit — via SetNullNotNullableError.
 *
 * Three cases:
 *   1. aggregation (default set-null) + @required FK field → throws
 *   2. aggregation (default set-null) + nullable FK field  → no throw
 *   3. aggregation + explicit @onDelete: restrict + @required FK field → no throw
 *      (override avoids set-null entirely)
 */
import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../../src/expected-schema.js";
import { SetNullNotNullableError } from "../../src/errors.js";

async function loadDoc(doc: unknown) {
  const { root, errors } = await new MetaDataLoader().load([
    new InMemoryStringSource(JSON.stringify(doc)),
  ]);
  expect(errors).toHaveLength(0);
  return root;
}

// ---------------------------------------------------------------------------
// Helpers to build the test document
// ---------------------------------------------------------------------------

function makeDoc(options: {
  required: boolean;
  relationship: Record<string, unknown>;
}) {
  const fieldChildren: unknown[] = options.required
    ? [{ "validator.required": {} }]
    : [];

  return {
    "metadata.root": {
      package: "acme",
      children: [
        {
          "object.entity": {
            name: "Program",
            children: [
              { "field.long": { name: "id" } },
              { "identity.primary": { "name": "id", "@fields": "id" } },
            ],
          },
        },
        {
          "object.entity": {
            name: "Week",
            children: [
              { "field.long": { name: "id" } },
              {
                "field.long": {
                  name: "programId",
                  children: fieldChildren,
                },
              },
              options.relationship,
              {
                "identity.reference": {
                  name: "ref_program",
                  "@fields": ["programId"],
                  "@references": "Program",
                },
              },
              { "identity.primary": { "name": "id", "@fields": "id" } },
            ],
          },
        },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildExpectedSchema — set-null requires nullable FK columns", () => {
  test("aggregation default (set-null) + @required FK field → SetNullNotNullableError", async () => {
    const root = await loadDoc(
      makeDoc({
        required: true,
        relationship: {
          "relationship.aggregation": {
            name: "program",
            "@objectRef": "Program",
            "@cardinality": "one",
          },
        },
      }),
    );

    expect(() => buildExpectedSchema(root)).toThrow(SetNullNotNullableError);
  });

  test("SetNullNotNullableError message names entity, FK constraint, and offending field", async () => {
    const root = await loadDoc(
      makeDoc({
        required: true,
        relationship: {
          "relationship.aggregation": {
            name: "program",
            "@objectRef": "Program",
            "@cardinality": "one",
          },
        },
      }),
    );

    let caught: unknown;
    try {
      buildExpectedSchema(root);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(SetNullNotNullableError);
    const err = caught as SetNullNotNullableError;
    // Must name the entity
    expect(err.message).toContain("Week");
    // Must name the FK constraint
    expect(err.message).toContain("weeks_program_id_fk");
    // Must name the offending field
    expect(err.message).toContain("programId");
    // Must suggest a fix
    expect(err.message.toLowerCase()).toMatch(/@required|@ondelete|restrict|no-action/i);
  });

  test("aggregation default (set-null) + nullable FK field → no error", async () => {
    const root = await loadDoc(
      makeDoc({
        required: false,
        relationship: {
          "relationship.aggregation": {
            name: "program",
            "@objectRef": "Program",
            "@cardinality": "one",
          },
        },
      }),
    );

    // Must not throw
    expect(() => buildExpectedSchema(root)).not.toThrow();
  });

  test("aggregation + explicit @onDelete: restrict + @required FK field → no error (override avoids set-null)", async () => {
    const root = await loadDoc(
      makeDoc({
        required: true,
        relationship: {
          "relationship.aggregation": {
            name: "program",
            "@objectRef": "Program",
            "@cardinality": "one",
            "@onDelete": "restrict",
          },
        },
      }),
    );

    // The explicit override changes onDelete to restrict → no set-null → no error
    expect(() => buildExpectedSchema(root)).not.toThrow();
  });

  test("aggregation + explicit @onDelete: no-action + @required FK field → no error (override avoids set-null)", async () => {
    const root = await loadDoc(
      makeDoc({
        required: true,
        relationship: {
          "relationship.aggregation": {
            name: "program",
            "@objectRef": "Program",
            "@cardinality": "one",
            "@onDelete": "no-action",
          },
        },
      }),
    );

    // no-action normalizes to undefined in the FK descriptor → no set-null → no error
    expect(() => buildExpectedSchema(root)).not.toThrow();
  });

  test("composition (cascade) + @required FK field → no error (cascade is fine on NOT NULL)", async () => {
    const root = await loadDoc(
      makeDoc({
        required: true,
        relationship: {
          "relationship.composition": {
            name: "program",
            "@objectRef": "Program",
            "@cardinality": "one",
          },
        },
      }),
    );

    expect(() => buildExpectedSchema(root)).not.toThrow();
  });

  test("explicit @onDelete: set-null on composition + @required FK field → SetNullNotNullableError", async () => {
    // Explicit set-null on any relationship subtype should also be caught
    const root = await loadDoc(
      makeDoc({
        required: true,
        relationship: {
          "relationship.composition": {
            name: "program",
            "@objectRef": "Program",
            "@cardinality": "one",
            "@onDelete": "set-null",
          },
        },
      }),
    );

    expect(() => buildExpectedSchema(root)).toThrow(SetNullNotNullableError);
  });
});

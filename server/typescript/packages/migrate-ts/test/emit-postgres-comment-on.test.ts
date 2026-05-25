import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../src/expected-schema.js";
import { diff } from "../src/diff/index.js";
import { emit } from "../src/emit/index.js";

async function loadAndEmitPostgres(json: object): Promise<string> {
  const result = await new MetaDataLoader().load([
    new InMemoryStringSource(JSON.stringify(json)),
  ]);
  expect(result.errors).toEqual([]);
  const expected = buildExpectedSchema(result.root, { dialect: "postgres" });
  const actual = { tables: [], views: [] };
  const diffResult = await diff({ expected, actual });
  const sql = emit(diffResult.changes, { dialect: "postgres" });
  return sql.up;
}

describe("emit (postgres) — COMMENT ON from @description", () => {
  test("emits COMMENT ON TABLE from entity @description", async () => {
    const sql = await loadAndEmitPostgres({
      "metadata.root": {
        children: [
          {
            "object.entity": {
              name: "User",
              "@description": "A registered account holder.",
              children: [
                { "field.long": { name: "id" } },
                { "source.rdb": { name: "src", "@table": "users" } },
                { "identity.primary": { name: "pk", "@fields": "id" } },
              ],
            },
          },
        ],
      },
    });
    expect(sql).toContain(`COMMENT ON TABLE "users" IS 'A registered account holder.';`);
  });

  test("emits COMMENT ON COLUMN from field @description; escapes single quotes", async () => {
    const sql = await loadAndEmitPostgres({
      "metadata.root": {
        children: [
          {
            "object.entity": {
              name: "User",
              children: [
                { "field.long": { name: "id" } },
                { "field.string": { name: "email", "@description": "User's email." } },
                { "source.rdb": { name: "src", "@table": "users" } },
                { "identity.primary": { name: "pk", "@fields": "id" } },
              ],
            },
          },
        ],
      },
    });
    expect(sql).toContain(`COMMENT ON COLUMN "users"."email" IS 'User''s email.';`);
  });

  test("does NOT emit COMMENT ON when no @description anywhere", async () => {
    const sql = await loadAndEmitPostgres({
      "metadata.root": {
        children: [
          {
            "object.entity": {
              name: "User",
              children: [
                { "field.long": { name: "id" } },
                { "source.rdb": { name: "src", "@table": "users" } },
                { "identity.primary": { name: "pk", "@fields": "id" } },
              ],
            },
          },
        ],
      },
    });
    expect(sql).not.toContain("COMMENT ON");
  });

  test("schema-qualified table: COMMENT ON uses the same qualification", async () => {
    const sql = await loadAndEmitPostgres({
      "metadata.root": {
        children: [
          {
            "object.entity": {
              name: "AuditEvent",
              "@description": "Audit log.",
              children: [
                { "field.long": { name: "id" } },
                { "source.rdb": { name: "src", "@table": "audit_events", "@schema": "audit" } },
                { "identity.primary": { name: "pk", "@fields": "id" } },
              ],
            },
          },
        ],
      },
    });
    expect(sql).toContain(`COMMENT ON TABLE "audit"."audit_events" IS 'Audit log.';`);
  });

  test("SQLite: descriptions silently ignored — no COMMENT statements emitted", async () => {
    const result = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify({
      "metadata.root": {
        children: [
          {
            "object.entity": {
              name: "User",
              "@description": "Should not appear in SQLite.",
              children: [
                { "field.long": { name: "id" } },
                { "field.string": { name: "email", "@description": "Likewise." } },
                { "source.rdb": { name: "src", "@table": "users" } },
                { "identity.primary": { name: "pk", "@fields": "id" } },
              ],
            },
          },
        ],
      },
    }))]);
    expect(result.errors).toEqual([]);
    const expected = buildExpectedSchema(result.root, { dialect: "sqlite" });
    const actual = { tables: [], views: [] };
    const diffResult = await diff({ expected, actual });
    const sql = emit(diffResult.changes, { dialect: "sqlite" });
    expect(sql.up).not.toContain("COMMENT ON");
  });

  test("inherited @description (entity + field extends:) flows through to COMMENT", async () => {
    // Locks the effective-attr contract (.attr, not .ownAttr) on both buildTable and buildColumn.
    // A concrete entity extending an abstract base with @description must pick up the base's
    // description for COMMENT ON TABLE. Same contract for a field extending an abstract field.enum.
    const sql = await loadAndEmitPostgres({
      "metadata.root": {
        children: [
          {
            "object.entity": {
              name: "BaseRecord",
              "abstract": true,
              "@description": "Base record description (inherited).",
              children: [
                { "field.long": { name: "id" } },
                { "identity.primary": { name: "pk", "@fields": "id" } },
              ],
            },
          },
          {
            "field.enum": {
              name: "Status",
              "abstract": true,
              "@values": ["DRAFT", "PUBLISHED"],
              "@description": "Lifecycle status (inherited).",
            },
          },
          {
            "object.entity": {
              name: "Order",
              "extends": "BaseRecord",
              children: [
                { "field.enum": { name: "status", "extends": "Status" } },
                { "source.rdb": { name: "src", "@table": "orders" } },
              ],
            },
          },
        ],
      },
    });
    // Entity description inherited from BaseRecord:
    expect(sql).toContain(`COMMENT ON TABLE "orders" IS 'Base record description (inherited).';`);
    // Field description inherited from abstract Status enum:
    expect(sql).toContain(`COMMENT ON COLUMN "orders"."status" IS 'Lifecycle status (inherited).';`);
  });
});

// field.map codegen — an open-keyed map (Record<string, V>) stored in one jsonb
// column. Value type is a scalar (@valueType) or a value-object (@objectRef);
// keys are always strings. Exercises the Drizzle column ($type), the inferred
// type, and the Zod schema.

import { describe, test, expect } from "bun:test";
import { resolve } from "node:path";
import { MetaDataLoader } from "@metaobjectsdev/metadata";
import { FileSource } from "@metaobjectsdev/metadata/core";
import { renderDrizzleSchema } from "../src/templates/drizzle-schema.js";
import { renderEntityFile } from "../src/templates/entity-file.js";
import { makeRenderContext } from "../src/render-context.js";
import { buildPkMap } from "../src/pk-resolver.js";
import { buildRelationMap } from "../src/relation-resolver.js";

const FIXTURE = resolve(import.meta.dir, "fixtures/field-map.yaml");

async function load() {
  const loader = new MetaDataLoader();
  const res = await loader.load([new FileSource(FIXTURE)]);
  expect(res.errors).toEqual([]);
  const ctx = makeRenderContext({
    dialect: "postgres", loadedRoot: res.root, outDir: "/x", dbImport: "~/db",
    pkMap: buildPkMap(res.root), relationMap: buildRelationMap(res.root),
  });
  return { root: res.root, ctx };
}

describe("field.map codegen (postgres)", () => {
  test("Drizzle: single jsonb column .$type<Record<string, V>> — scalar + VO values, no .array()", async () => {
    const { root, ctx } = await load();
    const out = renderDrizzleSchema(root.findObject("Widget")!, ctx).toString();
    expect(out).toContain('labels: jsonb("labels").$type<Record<string, string>>()');
    expect(out).toContain('scores: jsonb("scores").$type<Record<string, number>>()');
    expect(out).toContain('tools: jsonb("tools").$type<Record<string, ToolSpec>>()');
    expect(out).not.toContain(".array()");
  });

  test("entity file: Zod z.record(z.string(), V) + inferred Record type", async () => {
    const { root, ctx } = await load();
    const out = renderEntityFile(root.findObject("Widget")!, ctx).toString();
    expect(out).toContain("z.record(z.string(), z.string())");   // labels
    expect(out).toContain("z.record(z.string(), z.number())");   // scores
    expect(out).toContain("z.record(z.string(), ToolSpecInsertSchema)"); // tools (VO value)
  });
});

describe("field.map loader validation", () => {
  async function loadInline(mapBody: string) {
    const yaml = `metadata:
  package: t
  children:
  - object.entity:
      name: W
      children:
      - source.rdb: { table: w }
      - field.long: { name: id }
      - field.map: { name: m, ${mapBody} }
      - identity.primary: { fields: [id], generation: increment }
  - object.value:
      name: ToolSpec
      children:
      - field.string: { name: kind }
`;
    const loader = new MetaDataLoader();
    const { writeFileSync, mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "fieldmap-"));
    const f = join(dir, "m.yaml");
    writeFileSync(f, yaml);
    return loader.load([new FileSource(f)]);
  }

  test("valid: exactly one of valueType / objectRef loads clean", async () => {
    expect((await loadInline("valueType: string")).errors).toEqual([]);
    expect((await loadInline("objectRef: ToolSpec")).errors).toEqual([]);
  });

  test("neither valueType nor objectRef → ERR_BAD_ATTR_VALUE", async () => {
    const res = await loadInline("required: true");
    expect(res.errors.some((e) => /must set exactly one/.test(String(e)))).toBe(true);
  });

  test("both valueType and objectRef → ERR_BAD_ATTR_VALUE", async () => {
    const res = await loadInline("valueType: string, objectRef: ToolSpec");
    expect(res.errors.some((e) => /both are set/.test(String(e)))).toBe(true);
  });

  test("non-scalar valueType → ERR_BAD_ATTR_VALUE", async () => {
    const res = await loadInline("valueType: object");
    expect(res.errors.some((e) => /not a scalar value subtype/.test(String(e)))).toBe(true);
  });
});

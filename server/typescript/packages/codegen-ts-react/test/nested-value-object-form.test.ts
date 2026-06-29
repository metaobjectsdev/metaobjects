// Issue #95 — nested value-object sub-forms in formFile.
//
// A `field.object` with an `@objectRef` to a value object is a nested sub-shape
// (commonly stored as jsonb). The form must NOT bind a single flat <input> to
// the nested object — it must recurse into the referenced value-object's fields
// and emit a labeled <fieldset> (a nested sub-form) with one bound control per
// sub-field, using react-hook-form nested field paths. Arrays of value objects
// get a useFieldArray-based repeatable group.

import { describe, test, expect } from "bun:test";
import {
  MetaDataLoader,
  InMemoryStringSource,
  type MetaObject,
  type MetaRoot,
} from "@metaobjectsdev/metadata";
import { renderFormFile } from "../src/templates/form-file.js";
import { makeRenderContext, buildPkMap, buildRelationMap } from "@metaobjectsdev/codegen-ts";

async function loadModel(): Promise<{ root: MetaRoot; agent: MetaObject }> {
  const loader = new MetaDataLoader();
  const { root, errors } = await loader.load([
    new InMemoryStringSource(
      JSON.stringify({
        "metadata.root": {
          package: "demo",
          children: [
            {
              "object.value": {
                name: "LlmConfig",
                children: [
                  { "field.string": { name: "model", "@required": true } },
                  { "field.double": { name: "temperature" } },
                ],
              },
            },
            {
              "object.value": {
                name: "Tool",
                children: [
                  { "field.string": { name: "toolName", "@required": true } },
                  { "field.boolean": { name: "enabled" } },
                ],
              },
            },
            {
              "object.entity": {
                name: "Agent",
                children: [
                  { "source.rdb": { "@table": "agents" } },
                  { "field.long": { name: "id" } },
                  { "identity.primary": { name: "id", "@fields": "id", "@generation": "increment" } },
                  { "field.string": { name: "name", "@required": true } },
                  { "field.object": { name: "llmConfig", "@objectRef": "LlmConfig" } },
                  { "field.object": { name: "tools", isArray: true, "@objectRef": "Tool" } },
                ],
              },
            },
          ],
        },
      }),
      { id: "agent.json" },
    ),
  ]);
  if (errors.length > 0) throw new Error(errors.map((e) => e.message).join("; "));
  const find = (n: string) => root.objects().find((o) => o.name === n)! as MetaObject;
  return { root, agent: find("Agent") };
}

function ctxFor(root: MetaRoot) {
  return makeRenderContext({
    dialect: "postgres",
    loadedRoot: root,
    outDir: "/x",
    dbImport: "../db",
    extStyle: "none",
    apiPrefix: "/api",
    pkMap: buildPkMap(root),
    relationMap: buildRelationMap(root),
  });
}

describe("issue #95 — nested value-object sub-forms", () => {
  test("a field.object @objectRef renders a <fieldset> sub-form, not a flat <input>", async () => {
    const { root, agent } = await loadModel();
    const out = renderFormFile(agent, ctxFor(root));

    // A scalar field is unchanged: still bound via form.input.<field>.
    expect(out).toContain("{...form.input.name}");

    // The nested value object renders as a labeled fieldset, NOT a flat input.
    expect(out).toContain("<fieldset");
    expect(out).toContain("<legend");
    expect(out).not.toContain("{...form.input.llmConfig}");

    // Each VO sub-field is bound via a react-hook-form nested path.
    expect(out).toContain('form.register("llmConfig.model")');
    expect(out).toContain('form.register("llmConfig.temperature")');
  });

  test("an array of value objects renders a useFieldArray repeatable group", async () => {
    const { root, agent } = await loadModel();
    const out = renderFormFile(agent, ctxFor(root));

    // No flat input bound to the object array.
    expect(out).not.toContain("{...form.input.tools}");

    // useFieldArray wiring + per-element registration via the indexed path.
    expect(out).toContain("useFieldArray");
    expect(out).toContain("toolName");
    expect(out).toContain("enabled");
    expect(out).toContain("tools.${index}.toolName");
  });
});

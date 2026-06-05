import { describe, test, expect } from "bun:test";
import { MetaDataLoader, TEMPLATE_SUBTYPE_PROMPT } from "@metaobjectsdev/metadata";
import { findTemplates } from "../src/templates/find-templates.js";

test("finds a template.prompt nested in an object.entity", async () => {
  const m = JSON.stringify({ "metadata.root": { package: "t::ai", children: [
    { "object.value": { name: "ReqVO", children: [{ "field.string": { name: "q" } }] } },
    { "object.entity": { name: "Call", children: [
      { "source.rdb": { "@table": "call", "@role": "primary" } },
      { "field.uuid": { name: "spanId" } },
      { "identity.primary": { "@fields": ["spanId"] } },
      { "template.prompt": { name: "CallPrompt", "@payloadRef": "ReqVO", "@textRef": "p/x", "@format": "xml" } },
    ] } },
  ] } });
  const r = await MetaDataLoader.fromString(m, "json");
  expect(r.errors).toEqual([]);
  const prompts = findTemplates(r.root, TEMPLATE_SUBTYPE_PROMPT);
  expect(prompts.map((p) => p.name)).toContain("CallPrompt");
});

test("finds a top-level template.prompt", async () => {
  const m = JSON.stringify({ "metadata.root": { package: "t::ai", children: [
    { "object.value": { name: "ReqVO", children: [{ "field.string": { name: "q" } }] } },
    { "template.prompt": { name: "TopLevel", "@payloadRef": "ReqVO", "@textRef": "p/x", "@format": "xml" } },
  ] } });
  const r = await MetaDataLoader.fromString(m, "json");
  expect(r.errors).toEqual([]);
  const prompts = findTemplates(r.root, TEMPLATE_SUBTYPE_PROMPT);
  expect(prompts.map((p) => p.name)).toContain("TopLevel");
});

test("returns both top-level and nested template.prompt nodes", async () => {
  const m = JSON.stringify({ "metadata.root": { package: "t::ai", children: [
    { "object.value": { name: "ReqVO", children: [{ "field.string": { name: "q" } }] } },
    { "template.prompt": { name: "TopLevel", "@payloadRef": "ReqVO", "@textRef": "p/x", "@format": "xml" } },
    { "object.entity": { name: "Call", children: [
      { "source.rdb": { "@table": "call", "@role": "primary" } },
      { "field.uuid": { name: "spanId" } },
      { "identity.primary": { "@fields": ["spanId"] } },
      { "template.prompt": { name: "Nested", "@payloadRef": "ReqVO", "@textRef": "p/y", "@format": "xml" } },
    ] } },
  ] } });
  const r = await MetaDataLoader.fromString(m, "json");
  expect(r.errors).toEqual([]);
  const names = findTemplates(r.root, TEMPLATE_SUBTYPE_PROMPT).map((p) => p.name);
  expect(names).toContain("TopLevel");
  expect(names).toContain("Nested");
  expect(names).toHaveLength(2);
});

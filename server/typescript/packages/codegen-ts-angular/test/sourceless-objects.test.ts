// Endpoint guards on the Angular generators (the 0.21.5 sourceless-objects class).
//
// tanstackQuery/tanstackGrid/tanstackGridHook/formFile were all fixed to gate on
// `servesReadApi`/`servesWriteApi` — a hook, grid or form is a client of a generated
// REST endpoint, and emitting one for an `object.value`, a sourceless entity or a
// sourceless projection produces output that can never compile. The Angular
// generators carried the identical defect (they predate the central guards) and are
// gated here on the same model the tanstack compile gate uses: a sourced entity
// (the control), a view-backed projection (must KEEP its read-only service — the
// row that stops an over-broad fix), an `object.value` baited with a dataGrid
// layout, a sourceless entity, and a sourceless projection.
import { describe, test, expect } from "bun:test";
import {
  angularServiceFile,
  angularFormFile,
  angularGridFile,
  barrel,
} from "../src/index.js";
import { makeRenderContext, buildPkMap, buildRelationMap } from "@metaobjectsdev/codegen-ts";
import type { GenContext, Generator } from "@metaobjectsdev/codegen-ts";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";

const META = JSON.stringify({
  "metadata.root": {
    package: "acme",
    children: [
      // Sourced entity — the control. Everything should be emitted for it.
      { "object.entity": { name: "Author", children: [
        { "source.rdb": { "@table": "authors" } },
        { "field.long": { name: "id" } },
        { "field.string": { name: "name", "@filterable": true, children: [{ "view.text": {} }] } },
        { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
        { "layout.dataGrid": { name: "default", "@columns": ["id", "name"] } },
      ] } },
      // View-backed projection — read endpoint exists, so the service stays; a form
      // (nothing to submit) and no write surface must NOT be emitted for it.
      { "object.projection": { name: "AuthorSummary", children: [
        { "source.rdb": { "@kind": "view", "@table": "v_author_summary" } },
        { "field.long": { name: "id", extends: "Author.id" } },
        { "field.string": { name: "name", extends: "Author.name" } },
        { "identity.primary": { name: "pk", extends: "Author.pk" } },
      ] } },
      // object.value — a pure shape (ADR-0028). The dataGrid layout is deliberate
      // bait for the grid generator.
      { "object.value": { name: "NotePayload", children: [
        { "field.string": { name: "text" } },
        { "layout.dataGrid": { name: "default", "@columns": ["text"] } },
      ] } },
      // Sourceless entity — no route, so no client for one.
      { "object.entity": { name: "Sourceless", children: [
        { "field.long": { name: "id" } },
        { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
      ] } },
      // Sourceless projection — the #210 payload re-host shape; never CRUD.
      { "object.projection": { name: "AuthorCard", children: [
        { "field.string": { name: "name" } },
      ] } },
    ],
  },
});

async function ctxFor(gen: Generator): Promise<GenContext> {
  const { root, errors } = await new MetaDataLoader().load([new InMemoryStringSource(META)]);
  expect(errors).toEqual([]);
  const entities = root.objects();
  const renderContext = makeRenderContext({
    dialect: "postgres",
    loadedRoot: root,
    outDir: "/tmp",
    dbImport: "./db",
    extStyle: "none",
    pkMap: buildPkMap(root),
    relationMap: buildRelationMap(root),
  });
  return {
    entities,
    loadedRoot: root,
    matches: (e) => gen.filter?.(e) ?? true,
    config: { outDir: "/tmp", extStyle: "none", dbImport: "./db", dialect: "postgres" },
    renderContext,
    warn: () => {},
  };
}

async function emittedPaths(gen: Generator): Promise<string[]> {
  const files = await gen.generate(await ctxFor(gen));
  return files.map((f) => f.path).sort();
}

describe("endpoint guards — no artifact without an endpoint", () => {
  test("angularServiceFile: sourced entity + view-backed projection only", async () => {
    expect(await emittedPaths(angularServiceFile())).toEqual([
      "Author.service.ts",
      "AuthorSummary.service.ts",
    ]);
  });

  test("angularFormFile: sourced writable entity only — never a value, sourceless object or projection", async () => {
    expect(await emittedPaths(angularFormFile())).toEqual(["Author.form.component.ts"]);
  });

  test("angularGridFile: dataGrid on a value does not tempt it", async () => {
    expect(await emittedPaths(angularGridFile())).toEqual(["Author.grid.component.ts"]);
  });

  test("barrel: every re-export line mirrors its generator's filter", async () => {
    const gen = barrel();
    const files = await gen.generate(await ctxFor(gen));
    expect(files.length).toBe(1);
    const content = files[0]!.content;
    // Emitted files are re-exported…
    expect(content).toContain('"./Author.service"');
    expect(content).toContain('"./Author.form.component"');
    expect(content).toContain('"./Author.grid.component"');
    expect(content).toContain('"./AuthorSummary.service"');
    // …and nothing else is: a re-export of a never-emitted file is a build break.
    expect(content).not.toContain("AuthorSummary.form");
    expect(content).not.toContain("NotePayload");
    expect(content).not.toContain("Sourceless");
    expect(content).not.toContain("AuthorCard");
  });
});

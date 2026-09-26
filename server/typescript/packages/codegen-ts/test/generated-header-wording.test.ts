// The header on a generated CODE file must tell the truth about editing it.
//
// It used to say `DO NOT EDIT.` while `meta gen` deliberately three-way-merges hand edits
// into the regenerated file and `meta verify --codegen` checks only the generated
// contribution — so the header forbade the very workflow the tool is built around (a cold
// external review of 1.0.9-rc.1 flagged the contradiction). This pins the wording on the
// real emitted output of every code tier that stamps it, not on the constant alone, so a
// site that keeps its own copy of the old string fails here.

import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource, type MetaObject } from "@metaobjectsdev/metadata";
import { GENERATED_HEADER, GENERATED_EDIT_NOTE } from "../src/constants.js";
import { entityFile } from "../src/generators/entity-file.js";
import { namesFile } from "../src/generators/names-file.js";
import { queriesFile } from "../src/generators/queries-file.js";
import { routesFile } from "../src/generators/routes-file.js";
import { routesFileHono } from "../src/generators/routes-file-hono.js";
import { barrel } from "../src/generators/barrel.js";
import { promptRender } from "../src/generators/prompt-render-file.js";
import { makeRenderContext } from "../src/render-context.js";
import { buildPkMap } from "../src/pk-resolver.js";
import { buildRelationMap } from "../src/relation-resolver.js";
import type { GenContext, Generator } from "../src/generator.js";

const MODEL = {
  "metadata.root": {
    package: "t",
    children: [
      {
        "object.entity": {
          name: "Book",
          children: [
            { "source.rdb": { "@table": "books" } },
            { "field.int": { name: "id" } },
            { "field.string": { name: "title" } },
            { "identity.primary": { name: "id", "@fields": "id" } },
          ],
        },
      },
      { "object.value": { name: "Line", children: [{ "field.int": { name: "rating" } }] } },
      {
        "object.value": {
          name: "Payload",
          children: [{ "field.object": { name: "lines", "@objectRef": "Line", isArray: true } }],
        },
      },
      { "template.output": { name: "Blurb", "@payloadRef": "Payload", "@textRef": "blurb" } },
    ],
  },
};

describe("generated code-file header wording", () => {
  test("the note states the merge + verify contract instead of forbidding edits", () => {
    expect(GENERATED_EDIT_NOTE).not.toContain("DO NOT EDIT");
    expect(GENERATED_EDIT_NOTE).toContain("three-way merge");
    expect(GENERATED_EDIT_NOTE).toContain("meta verify --codegen");
  });

  test("every emitted code file carries the truthful header", async () => {
    const result = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(MODEL))]);
    expect(result.errors.map((e) => e.message)).toEqual([]);
    const root = result.root;
    const renderContext = makeRenderContext({
      dialect: "postgres",
      loadedRoot: root,
      outDir: "/tmp/x",
      dbImport: "~/db",
      pkMap: buildPkMap(root),
      relationMap: buildRelationMap(root),
    });
    const genCtx = (g: Generator): GenContext => ({
      entities: root.objects(),
      loadedRoot: root,
      matches: (e: MetaObject) => g.filter?.(e) ?? true,
      projectRoot: "/tmp/x",
      config: { outDir: "/tmp/x", extStyle: "js", dbImport: "~/db", dialect: "postgres" } as never,
      renderContext,
      warn: () => {},
    });
    const generators: Generator[] = [
      entityFile(),
      namesFile(),
      queriesFile(),
      routesFile(),
      routesFileHono(),
      promptRender(),
      barrel(),
    ];
    const files = (await Promise.all(generators.map((g) => g.generate(genCtx(g))))).flat();
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) {
      expect(f.content).not.toContain("DO NOT EDIT");
      expect(f.content).toContain(`${GENERATED_HEADER} — ${GENERATED_EDIT_NOTE}`);
    }
  });
});

// A generated file must import each module ONCE — the fast in-process half of the
// duplicate-import defense.
//
// HISTORY: a real `meta gen` once emitted `import { eq } from "drizzle-orm";` THREE
// times into `<Entity>.queries.ts` (TS2300 on the adopter's first `npx tsc`) while
// this in-process render always produced ONE — because the bug was never in the
// template's imp() usage (ts-poet dedupes by module+name). ROOT CAUSE: with a
// globally-installed or linked CLI, the project tree and the CLI tree hold two
// physical ts-poet copies; the scaffolded generator's bare `import { joinCode } from
// "ts-poet"` bound the project copy while the engine's render*Fn built Code sections
// with the CLI copy, and ts-poet's `instanceof Code` placeholder detection fails
// across module instances — each section was stringified standalone WITH ITS OWN
// import header. A single-instance render (this file) can never exhibit that, which
// is exactly why the bug hid from it.
//
// The split-tree path is gated end-to-end (spawning `node <cli-bin> gen` against a
// project with a planted second ts-poet copy) by
// cli/test/gen-split-tree-single-import.test.ts, which pins both halves of the fix:
// templates importing the ts-poet combinators via @metaobjectsdev/codegen-ts, and
// the config loader aliasing bare "ts-poet" to the engine-adjacent copy for
// already-scaffolded projects.
//
// This gate stays because the invariant is right and cheap in-process: no module may
// be imported twice in a rendered queries file, both dialects. Note the other queries
// tests assert on SUBSTRINGS ("does the output contain findAuthorById"), and a
// duplicate import is invisible to a contains-check — you only see it by counting,
// or by compiling.
import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { makeRenderContext } from "../src/render-context.js";
import { buildPkMap } from "../src/pk-resolver.js";
import { buildRelationMap } from "../src/relation-resolver.js";
import { queriesFile } from "../src/reference/queries.js";

const META = JSON.stringify({ "metadata.root": { children: [
  { "object.entity": { name: "Author", children: [
    { "source.rdb": { "@table": "authors" } },
    { "field.long": { name: "id" } },
    { "field.string": { name: "name" } },
    { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
  ] } },
] } });

async function render(dialect: "sqlite" | "postgres"): Promise<string> {
  const { root, errors } = await new MetaDataLoader().load([new InMemoryStringSource(META)]);
  expect(errors).toEqual([]);
  const renderContext = makeRenderContext({
    dialect, loadedRoot: root, outDir: "/tmp/x", dbImport: "./db",
    pkMap: buildPkMap(root), relationMap: buildRelationMap(root),
  });
  const files = await queriesFile().generate({
    entities: root.objects(), loadedRoot: root, matches: () => true,
    config: { outDir: "/tmp/x", extStyle: "none", dbImport: "./db", dialect },
    renderContext, warn: () => {},
  } as never);
  return (files as { content: string }[])[0]!.content;
}

describe("generated queries file — no duplicate imports", () => {
  for (const dialect of ["sqlite", "postgres"] as const) {
    test(`every module is imported exactly once (${dialect})`, async () => {
      const content = await render(dialect);
      // Count every import statement's source module; none may repeat. Stated
      // generally rather than pinning `eq`, so the next symbol someone imports
      // per-renderer fails here too.
      const modules = [...content.matchAll(/^import\s+(?:type\s+)?[^;]*?from\s+"([^"]+)";/gm)]
        .map((m) => m[1]!);
      const dupes = modules.filter((m, i) => modules.indexOf(m) !== i);
      expect([...new Set(dupes)]).toEqual([]);
    });
  }
});

// A generated file must import each module ONCE.
//
// OPEN BUG, NOT CLOSED BY THIS GATE — read before trusting it.
//
// A real `meta gen` in a clean project (npm init -y → meta init → npm i → meta gen,
// against PUBLISHED packages) emits `import { eq } from "drizzle-orm";` THREE times
// into `<Entity>.queries.ts`, so the first `npx tsc` reports TS2300 "Duplicate
// identifier 'eq'". Reproduced on 0.21.5. That is a first-touch blocker.
//
// This gate does NOT currently reproduce it. Rendering the same generator from local
// source — before OR after hoisting the four `imp("eq@drizzle-orm")` calls to one
// module-level symbol — yields exactly ONE import, so ts-poet dedupes by module+name
// and the "separate symbol objects" theory is REFUTED. The scaffolded copy in the
// project is byte-identical to src/reference/queries.ts, so it is not template drift
// either. The cause is still unidentified; the difference is somewhere between this
// in-process render and a real `meta gen` run resolving @metaobjectsdev/codegen-ts
// from node_modules.
//
// The gate is kept because the invariant is right and cheap, and it is stated
// GENERALLY (no module may be imported twice) rather than pinned to `eq`, so it will
// catch the regression once someone renders through the path that actually exhibits
// it. Next step: run the assertion against the output of a real `meta gen`, not an
// in-process render.
//
// Note for whoever picks this up: the existing queries tests assert on SUBSTRINGS
// ("does the output contain findAuthorById"), and a duplicate import is invisible to
// a contains-check — you only see it by counting, or by compiling.
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

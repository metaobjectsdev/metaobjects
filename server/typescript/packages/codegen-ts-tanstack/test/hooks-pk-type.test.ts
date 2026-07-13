/**
 * The TanStack hooks template hardcoded `id: number` at every emission site — the
 * query-key `detail(id)` factory, `use<Entity>(id)`, and the update/delete mutation
 * variables — with nothing reading the entity's declared primary-key type.
 *
 * For a uuid/string PK (the normal case whenever `identity: "uuid"` is the project's
 * standard) the generated hooks therefore describe an `id: number` while the row's real
 * `<Entity>Row["id"]` is `string`. Application code calling
 * `useUpdate<Entity>().mutate({ id: someRealStringId, … })` is then a genuine `tsc` error
 * — the generated type is simply wrong for the data it describes, forcing consumers to
 * cast at every call site.
 *
 * codegen-ts already exports `getPkInfo(entity, ctx)` (the queries template uses it
 * correctly); the hooks template just never called it.
 *
 * Reported by a downstream consumer against 0.15.20.
 */
import { describe, test, expect } from "bun:test";
import { resolve } from "node:path";
import { tanstackQuery } from "../src/tanstack-query.js";
import { makeRenderContext, buildPkMap, buildRelationMap } from "@metaobjectsdev/codegen-ts";
import type { GenContext } from "@metaobjectsdev/codegen-ts";
import { MetaDataLoader } from "@metaobjectsdev/metadata";
import { FileSource } from "@metaobjectsdev/metadata/core";

/** Generate the hooks files for the fixture; returns path → content. */
async function generate(): Promise<Map<string, string>> {
  const loader = new MetaDataLoader();
  const { root } = await loader.load([
    new FileSource(resolve(import.meta.dir, "fixtures", "pk-types.json")),
  ]);
  const renderContext = makeRenderContext({
    dialect: "sqlite", loadedRoot: root, outDir: "/tmp",
    dbImport: "../db", extStyle: "none",
    pkMap: buildPkMap(root), relationMap: buildRelationMap(root),
  });
  const ctx: GenContext = {
    entities: root.objects(), loadedRoot: root,
    matches: () => true,
    config: { outDir: "/tmp", extStyle: "none", dbImport: "../db", dialect: "sqlite" },
    renderContext,
    warn: () => {},
  };
  const files = await tanstackQuery().generate(ctx);
  return new Map(files.map((f) => [f.path, f.content]));
}

describe("tanstack hooks — the id parameter follows the entity's real PK type", () => {
  test("uuid PK emits `id: string`, never `id: number`", async () => {
    const member = (await generate()).get("Member.hooks.ts")!;
    expect(member).toContain("id: string");
    expect(member).not.toContain("id: number");
  });

  test("uuid PK: the delete mutation's variable type is string, not number", async () => {
    const member = (await generate()).get("Member.hooks.ts")!;
    // useDeleteMember previously produced UseMutationResult<void, Error, number>
    expect(member).not.toMatch(/UseMutationResult<\s*void,\s*Error,\s*number\s*>/);
    expect(member).toMatch(/UseMutationResult<\s*void,\s*Error,\s*string\s*>/);
  });

  test("uuid PK: the update mutation's variables carry a string id", async () => {
    const member = (await generate()).get("Member.hooks.ts")!;
    expect(member).toContain("{ id: string; input: MemberUpdate }");
  });

  test("regression guard: an increment/long PK still emits `id: number`", async () => {
    const subscriber = (await generate()).get("Subscriber.hooks.ts")!;
    expect(subscriber).toContain("id: number");
    expect(subscriber).not.toContain("id: string");
  });
});

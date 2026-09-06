import { describe, test, expect } from "bun:test";
import { resolve } from "node:path";
import { tanstackQuery } from "../src/tanstack-query.js";
import { makeRenderContext, buildPkMap, buildRelationMap } from "@metaobjectsdev/codegen-ts";
import type { GenContext } from "@metaobjectsdev/codegen-ts";
import { MetaDataLoader } from "@metaobjectsdev/metadata";
import { FileSource } from "@metaobjectsdev/metadata/core";

const FIXTURE = resolve(import.meta.dir, "fixtures", "m2m.json");

async function buildCtx(): Promise<GenContext> {
  const loader = new MetaDataLoader();
  const { root, errors } = await loader.load([new FileSource(FIXTURE)]);
  expect(errors).toEqual([]);
  const entities = root.objects();
  const renderContext = makeRenderContext({
    dialect: "postgres",
    loadedRoot: root,
    outDir: "/tmp",
    dbImport: "../db",
    extStyle: "none",
    apiPrefix: "/api",
    pkMap: buildPkMap(root),
    relationMap: buildRelationMap(root),
  });
  return {
    entities,
    loadedRoot: root,
    matches: () => true,
    config: { outDir: "/tmp", extStyle: "none", dbImport: "../db", dialect: "postgres" },
    renderContext,
    warn: () => {},
  };
}

function fileFor(files: { path: string; content: string }[], name: string): string {
  const f = files.find((x) => x.path === name);
  if (!f) throw new Error(`expected ${name} in [${files.map((x) => x.path).join(", ")}]`);
  return f.content;
}

describe("tanstackQuery() — FR-018 M:N collection hook", () => {
  test("emits use<Source><Relation> for a hetero M:N relationship", async () => {
    const ctx = await buildCtx();
    const files = await tanstackQuery().generate(ctx);
    const post = fileFor(files, "Post.hooks.ts");
    // Hook named after Source + Relation (Post + tags → usePostTags).
    expect(post).toContain("export function usePostTags");
  });

  test("M:N hook takes a source id, fetches the sub-resource URL, returns typed Target[]", async () => {
    const ctx = await buildCtx();
    const files = await tanstackQuery().generate(ctx);
    const post = fileFor(files, "Post.hooks.ts");
    // Signature: (sourceId: number | undefined, opts?) and typed Target[] return.
    // The target row type is imported (aliased) as <Target>RelRow.
    expect(post).toMatch(/export function usePostTags\(\s*sourceId: number \| undefined/);
    expect(post).toContain("UseQueryResult<TagRelRow[]>");
    // Fetches GET /<source-plural>/{id}/<relationName>: $path + /${sourceId}/tags. The
    // base URL is prepended at runtime by the provider, so it is absent here by design.
    expect(post).toContain("${Post.$path}/${sourceId}/tags");
    // Typed via the target row type.
    expect(post).toContain("fetcher<TagRelRow[]>");
  });

  test("M:N hook is enabled only when the source id is present", async () => {
    const ctx = await buildCtx();
    const files = await tanstackQuery().generate(ctx);
    const post = fileFor(files, "Post.hooks.ts");
    // enabled gates on a present sourceId (and respects a caller-supplied opts.enabled).
    expect(post).toContain("enabled:");
    expect(post).toMatch(/sourceId\s*!=\s*null/);
  });

  test("M:N hook query key is scoped to the source id + relation", async () => {
    const ctx = await buildCtx();
    const files = await tanstackQuery().generate(ctx);
    const post = fileFor(files, "Post.hooks.ts");
    expect(post).toMatch(/queryKey:\s*postKeys\.relation\("tags", sourceId\)/);
    expect(post).toContain('relation:');
  });

  test("imports the target row type from the target entity module", async () => {
    const ctx = await buildCtx();
    const files = await tanstackQuery().generate(ctx);
    const post = fileFor(files, "Post.hooks.ts");
    // Tag row type imported (aliased) from ./Tag.
    expect(post).toMatch(/from "\.\/Tag"/);
  });

  test("symmetric self-join still emits a single collection hook", async () => {
    const ctx = await buildCtx();
    const files = await tanstackQuery().generate(ctx);
    const person = fileFor(files, "Person.hooks.ts");
    // Person + friends → usePersonFriends, returns the target collection.
    expect(person).toContain("export function usePersonFriends");
    expect(person).toContain("UseQueryResult<PersonRelRow[]>");
    expect(person).toContain("${Person.$path}/${sourceId}/friends");
    // Exactly one collection hook for the symmetric self-join.
    const matches = person.match(/export function usePersonFriends/g);
    expect(matches?.length).toBe(1);
  });

  test("entity without M:N relationships emits no M:N hook", async () => {
    const ctx = await buildCtx();
    const files = await tanstackQuery().generate(ctx);
    const tag = fileFor(files, "Tag.hooks.ts");
    expect(tag).not.toContain("sourceId");
  });
});

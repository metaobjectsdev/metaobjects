import { describe, test, expect } from "bun:test";
import { resolve } from "node:path";
import { FileMetaDataLoader } from "@metaobjects/metadata/core";
import { tanstackQuery } from "../src/tanstack-query.js";
import { makeRenderContext } from "@metaobjects/codegen-ts";
import { buildPkMap, buildRelationMap } from "@metaobjects/codegen-ts";
import type { GenContext } from "@metaobjects/codegen-ts";

const FIXTURE = resolve(import.meta.dir, "..", "..", "codegen-ts", "test", "fixtures", "filter-fixture.json");

async function buildCtx(): Promise<GenContext> {
  const loader = new FileMetaDataLoader();
  const { root } = await loader.loadFiles([FIXTURE]);
  const entities = root.objects();
  const renderContext = makeRenderContext({
    dialect: "sqlite",
    loadedRoot: root,
    outDir: "/tmp",
    dbImport: "../db",
    extStyle: "none",
    pkMap: buildPkMap(root),
    relationMap: buildRelationMap(root),
  });
  return {
    entities,
    loadedRoot: root,
    matches: () => true,
    config: { outDir: "/tmp", extStyle: "none", dbImport: "../db", dialect: "sqlite" },
    renderContext,
    warn: () => {},
  };
}

describe("tanstackQuery — useEntities accepts typed filter", () => {
  test("useSubscribers signature uses SubscriberFilter type", async () => {
    const ctx = await buildCtx();
    const files = await tanstackQuery().generate(ctx);
    const file = files.find((f) => f.path === "Subscriber.hooks.ts")!;
    expect(file.content).toMatch(/filter\?\s*:\s*SubscriberFilter/);
  });

  test("hooks file imports SubscriberFilter type", async () => {
    const ctx = await buildCtx();
    const files = await tanstackQuery().generate(ctx);
    const file = files.find((f) => f.path === "Subscriber.hooks.ts")!;
    // Type-import alongside the existing entity imports
    expect(file.content).toContain("SubscriberFilter");
  });

  test("hooks file uses buildFilterQs for serialization", async () => {
    const ctx = await buildCtx();
    const files = await tanstackQuery().generate(ctx);
    const file = files.find((f) => f.path === "Subscriber.hooks.ts")!;
    expect(file.content).toContain("buildFilterQs");
    expect(file.content).toContain("@metaobjects/runtime-ts-client");
  });

  test("query-key factory uses SubscriberFilter type", async () => {
    const ctx = await buildCtx();
    const files = await tanstackQuery().generate(ctx);
    const file = files.find((f) => f.path === "Subscriber.hooks.ts")!;
    // The list() method signature should accept SubscriberFilter
    expect(file.content).toMatch(/list\s*:\s*\(filter\?\s*:\s*SubscriberFilter\)/);
  });
});

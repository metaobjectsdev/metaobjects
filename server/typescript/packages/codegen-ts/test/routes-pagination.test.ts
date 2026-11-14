// `api.pagination` reaches every generated list mount: the packaged routes generators and the
// reference copies `meta eject` writes emit `pagination: { defaultLimit, maxLimit }` on each
// CRUD and projection list, never on a report (which keeps its own row ceiling), and emit
// nothing at all when the project sets no page size.

import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource, type MetaRoot } from "@metaobjectsdev/metadata";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGen } from "../src/runner.js";
import { defineConfig } from "../src/metaobjects-config.js";
import type { Generator } from "../src/generator.js";
import { routesFile } from "../src/generators/routes-file.js";
import { routesFileHono } from "../src/generators/routes-file-hono.js";
import { routesFile as referenceRoutes } from "../src/reference/routes.js";
import { routesFileHono as referenceRoutesHono } from "../src/reference/routes-hono.js";
import { paginationLine } from "../src/api-surface.js";

const MODEL = {
  "metadata.root": {
    package: "acme::shop",
    children: [
      {
        "object.entity": {
          name: "Product",
          children: [
            { "source.rdb": { "@table": "products" } },
            { "field.long": { name: "id" } },
            { "field.string": { name: "title" } },
            { "identity.primary": { name: "id", "@fields": "id", "@generation": "increment" } },
          ],
        },
      },
    ],
  },
};

async function loadRoot(): Promise<MetaRoot> {
  const res = await new MetaDataLoader().load([
    new InMemoryStringSource(JSON.stringify(MODEL), { id: "meta.json", format: "json" }),
  ]);
  expect(res.errors).toEqual([]);
  return res.root;
}

function allFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? allFiles(p) : [p];
  });
}

async function routesSource(generator: Generator, page: { defaultLimit: number; maxLimit: number } | undefined): Promise<string> {
  const root = await loadRoot();
  if (page !== undefined) root.apiPagination = page;
  const tmp = mkdtempSync(join(tmpdir(), "routes-pagination-"));
  try {
    await runGen({
      config: defineConfig({ outDir: join(tmp, "src"), extStyle: "none", dbImport: "../db", dialect: "sqlite", generators: [generator] }),
      metadata: root, projectRoot: tmp,
    });
    return allFiles(join(tmp, "src")).filter((f) => /Product.*routes/i.test(f)).map((f) => readFileSync(f, "utf8")).join("\n");
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

const GENERATORS: Array<[string, () => Generator]> = [
  ["routesFile", () => routesFile()],
  ["routesFileHono", () => routesFileHono()],
  ["reference routes", () => referenceRoutes()],
  ["reference routes-hono", () => referenceRoutesHono()],
];

describe("generated list routes carry the project's page size", () => {
  for (const [name, make] of GENERATORS) {
    test(`${name}: api.pagination is emitted on the list mount`, async () => {
      const src = await routesSource(make(), { defaultLimit: 50, maxLimit: 1000 });
      expect(src).toContain("pagination: { defaultLimit: 50, maxLimit: 1000 }");
    });
    test(`${name}: no api.pagination emits no option`, async () => {
      const src = await routesSource(make(), undefined);
      expect(src.length).toBeGreaterThan(0);
      expect(src).not.toContain("pagination");
    });
  }
});

describe("paginationLine", () => {
  test("reads the loaded root, and is empty without a page size", async () => {
    const root = await loadRoot();
    const product = root.objects()[0]!;
    expect(paginationLine(product, "  ")).toBe("");
    root.apiPagination = { defaultLimit: 20, maxLimit: 200 };
    expect(paginationLine(product, "  ")).toBe("\n  pagination: { defaultLimit: 20, maxLimit: 200 },");
  });
});

// `api.unknownFields` reaches every generated write mount. Under `reject` (the default, also
// when the project sets nothing) the packaged routes generators and the reference copies
// `meta eject` writes pass `knownFields`, the entity's declared fields, so the runtime refuses
// any other body key; under `drop` they pass nothing and undeclared keys are ignored. A TPH
// subtype's routes know every field of the hierarchy, so a sibling's column is dropped there,
// not refused.

import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource, type MetaRoot, type MetaObject } from "@metaobjectsdev/metadata";
import { FileSource } from "@metaobjectsdev/metadata/core";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runGen } from "../src/runner.js";
import { defineConfig } from "../src/metaobjects-config.js";
import type { Generator } from "../src/generator.js";
import { routesFile } from "../src/generators/routes-file.js";
import { routesFileHono } from "../src/generators/routes-file-hono.js";
import { routesFile as referenceRoutes } from "../src/reference/routes.js";
import { routesFileHono as referenceRoutesHono } from "../src/reference/routes-hono.js";
import { knownFieldNames, tphHierarchy } from "../src/api-surface.js";

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
            { "field.string": { name: "sku", "@readOnly": true } },
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

async function routesSource(generator: Generator, mode: "reject" | "drop" | undefined): Promise<string> {
  const root = await loadRoot();
  if (mode !== undefined) root.apiUnknownFields = mode;
  const tmp = mkdtempSync(join(tmpdir(), "routes-known-fields-"));
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

// The declared fields, server-owned ones (`id`, the readOnly `sku`) included: known, so they
// are dropped rather than refused.
const PRODUCT_KNOWN = 'knownFields: ["id", "title", "sku"]';

describe("generated write routes carry the unknown-field rule", () => {
  for (const [name, make] of GENERATORS) {
    test(`${name}: no setting means reject, and the declared fields are passed`, async () => {
      expect(await routesSource(make(), undefined)).toContain(PRODUCT_KNOWN);
    });
    test(`${name}: reject passes the declared fields`, async () => {
      expect(await routesSource(make(), "reject")).toContain(PRODUCT_KNOWN);
    });
    test(`${name}: drop passes none`, async () => {
      const src = await routesSource(make(), "drop");
      expect(src.length).toBeGreaterThan(0);
      expect(src).not.toContain("knownFields");
    });
  }
});

describe("knownFieldNames on a single-table hierarchy", () => {
  test("every subtype knows the base's and every sibling's fields", async () => {
    const tphMeta = resolve(import.meta.dir, "../../../../../fixtures/api-contract-conformance/tph/meta.json");
    const res = await new MetaDataLoader().load([new FileSource(tphMeta)]);
    expect(res.errors).toEqual([]);
    const bridge = res.root.objects().find((o) => o.name === "BridgeAuth") as MetaObject;
    expect(knownFieldNames(tphHierarchy(bridge, res.root))).toEqual([
      "id", "type", "reference", "issuedCurrency", "autoCreatedAt", "autoUpdatedAt",
      "quantity", "copayAmount", "approver",
    ]);
  });
});

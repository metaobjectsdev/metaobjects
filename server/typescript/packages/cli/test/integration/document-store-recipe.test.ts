/**
 * The document-store recipe (docs/recipes/document-graph-and-wide-column-stores.md) must keep
 * working, because it tells an adopter on MongoDB (or Cassandra, Neo4j, a remote API) to copy
 * docs/recipes/generators/typescript/mongo-repository.ts. This gate does exactly that:
 *
 *   - a model whose `Order` is a SOURCELESS entity (identity, no `source.*`);
 *   - `meta eject entity`, then the example generator copied in verbatim and wired;
 *   - a strict typecheck of both generators, `meta gen`, and `meta verify --codegen`.
 *
 * It pins the two halves the recipe depends on: the entity module gives a sourceless entity
 * its create/PATCH schemas and allowlists (and no table), and the example generator picks it
 * out with `isSourcelessEntity` and reads the author's `@mongo` property bag.
 *
 * The generated repository imports `mongodb`, which this workspace does not install, so its
 * output is checked by content here; the recipe records the end-to-end run against MongoDB.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CLI_ROOT, meta, requireFreshDist } from "./support/built-cli.js";
import { newShopProject, typecheckGenerators, writeModel } from "./support/generator-project.js";

const EXAMPLE = resolve(CLI_ROOT, "..", "..", "..", "..", "docs", "recipes", "generators", "typescript", "mongo-repository.ts");

const MODEL = {
  metadata: {
    package: "shop",
    children: [
      {
        "object.value": {
          name: "LineItem",
          children: [
            { "field.string": { name: "sku", "@required": true } },
            { "field.int": { name: "qty", "@required": true } },
          ],
        },
      },
      {
        "object.entity": {
          name: "Order",
          "@mongo": { collection: "orders" },
          children: [
            { "field.uuid": { name: "id" } },
            { "field.string": { name: "customerEmail", "@required": true, "@filterable": true } },
            { "field.enum": { name: "status", "@required": true, "@values": ["NEW", "SHIPPED"], "@filterable": true } },
            { "field.object": { name: "items", "@objectRef": "LineItem", isArray: true } },
            { "identity.primary": { name: "id", "@fields": "id", "@generation": "uuid" } },
          ],
        },
      },
    ],
  },
};

beforeAll(requireFreshDist);

let root = "";
afterAll(() => {
  if (root !== "") rmSync(root, { recursive: true, force: true });
});

describe("document-store recipe", () => {
  test("a sourceless entity + the copied mongo-repository generator typecheck, generate and verify", async () => {
    root = await newShopProject("doc-store-");
    writeModel(root, MODEL);

    expect(await meta(root, "eject", "entity")).toMatchObject({ exit: 0 });
    copyFileSync(EXAMPLE, join(root, "codegen", "generators", "mongo-repository.ts"));

    // The wiring the recipe documents.
    const configPath = join(root, "metaobjects.config.ts");
    const config = readFileSync(configPath, "utf8")
      .replace(
        'import { defineConfig } from "@metaobjectsdev/cli";',
        'import { defineConfig } from "@metaobjectsdev/cli";\n' +
          'import { entityFile } from "./codegen/generators/entity.js";\n' +
          'import { mongoRepositoryGenerator } from "./codegen/generators/mongo-repository.js";',
      )
      .replace("generators: [],", "generators: [entityFile(), mongoRepositoryGenerator()],");
    expect(config).toContain("mongoRepositoryGenerator()");
    writeFileSync(configPath, config);

    const tsc = await typecheckGenerators(root, ["codegen/generators/entity.ts", "codegen/generators/mongo-repository.ts"]);
    expect({ step: "tsc", ...tsc }).toMatchObject({ step: "tsc", exit: 0 });

    expect(await meta(root, "gen")).toMatchObject({ exit: 0 });

    const out = join(root, "src", "generated");
    const order = readFileSync(join(out, "Order.ts"), "utf8");
    for (const symbol of ["OrderInsertSchema", "OrderUpdateSchema", "OrderFilterAllowlist", "OrderPatch"]) {
      expect(order).toMatch(new RegExp(`export (const|type) ${symbol}\\b`));
    }
    expect(order).not.toContain("drizzle-orm");

    const repo = readFileSync(join(out, "Order.repository.ts"), "utf8");
    expect(repo).toContain('db.collection<OrderDoc>("orders")');
    expect(repo).toContain("export function orderRepository(db: Db)");
    expect(repo).toContain("crypto.randomUUID()");
    // The value object is not a record: no repository.
    expect(existsSync(join(out, "LineItem.repository.ts"))).toBe(false);

    const verified = await meta(root, "verify", "--codegen");
    expect({ step: "verify", ...verified }).toMatchObject({ step: "verify", exit: 0 });
  }, 180_000);
});

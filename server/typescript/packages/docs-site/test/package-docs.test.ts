import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadModel } from "../src/load";
import { LinkGraph } from "../src/link-graph";
import { harvestPackageDocs, keyEntities } from "../src/package-docs";

const DIRS = [join(import.meta.dir, "fixture/input/acme")];

test("package docs parsed from _package.yaml; key entities ranked by inbound refs", async () => {
  const docs = harvestPackageDocs(DIRS);
  const shop = docs.get("acme::shop");
  expect(shop?.title).toBe("Shop");                    // fixture _package.yaml (Task 12)
  expect(shop?.description).toContain("orders");
  const g = new LinkGraph(await loadModel(DIRS));
  const keys = keyEntities("acme::shop", g);
  expect(keys[0]?.name).toBe("Customer");              // most-referenced in fixture
  expect(keys.every((k) => k.inbound >= (keys[keys.length - 1]?.inbound ?? 0))).toBe(true);
});

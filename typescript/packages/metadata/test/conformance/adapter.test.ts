// adapter.test.ts — exercises the TS ConformanceAdapter against a real
// fixture in the conformance corpus.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { UnknownCapabilityError } from "@metaobjects/conformance";
import { tsAdapter } from "./adapter.js";

// test/conformance/adapter.test.ts is 5 levels below the repo root:
//   <repo>/typescript/packages/metadata/test/conformance/adapter.test.ts
const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..", "..");

// `loader-basic-single-entity` declares one object.entity "Product" with
// fields id/name and a primary identity — a minimal real fixture.
const FIXTURE_INPUT = join(
  REPO_ROOT,
  "fixtures",
  "conformance",
  "loader-basic-single-entity",
  "input",
);
const CORE_PROVIDERS = ["metaobjects-core-types"];

describe("TS ConformanceAdapter", () => {
  test("reports language 'typescript'", () => {
    expect(tsAdapter.language).toBe("typescript");
  });

  test("loadFixture + navigate resolves the Product object node", async () => {
    const outcome = await tsAdapter.loadFixture(FIXTURE_INPUT, CORE_PROVIDERS);
    expect(outcome.errorCodes).toEqual([]);
    expect(outcome.tree).toBeDefined();

    const node = tsAdapter.navigate(outcome.tree, ["object:Product"]);
    expect(node).toBeDefined();
  });

  test("invoke object.effective-fields returns a names result", async () => {
    const outcome = await tsAdapter.loadFixture(FIXTURE_INPUT, CORE_PROVIDERS);
    const node = tsAdapter.navigate(outcome.tree, ["object:Product"]);
    expect(node).toBeDefined();

    const result = tsAdapter.invoke(node, "object.effective-fields", {});
    expect(result).toEqual({ names: ["id", "name"] });
  });

  test("invoke with an unbound capability id throws UnknownCapabilityError", async () => {
    const outcome = await tsAdapter.loadFixture(FIXTURE_INPUT, CORE_PROVIDERS);
    const node = tsAdapter.navigate(outcome.tree, ["object:Product"]);
    expect(node).toBeDefined();

    expect(() => tsAdapter.invoke(node, "object.no-such-capability", {})).toThrow(
      UnknownCapabilityError,
    );
  });
});

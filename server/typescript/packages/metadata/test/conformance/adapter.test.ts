// adapter.test.ts — exercises the TS ConformanceAdapter against a real
// fixture in the conformance corpus.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { UnknownCapabilityError } from "@metaobjectsdev/conformance";
import { tsAdapter } from "./adapter.js";

// test/conformance/adapter.test.ts is 5 levels below the repo root:
//   <repo>/typescript/packages/metadata/test/conformance/adapter.test.ts
const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..", "..", "..");

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
    expect(outcome.tree).toBeDefined();
    const node = tsAdapter.navigate(outcome.tree, ["object:Product"]);
    expect(node).toBeDefined();

    const result = tsAdapter.invoke(node, "object.effective-fields", {});
    expect(result).toEqual({ names: ["id", "name"] });
  });

  test("invoke object.own-fields returns a names result", async () => {
    const outcome = await tsAdapter.loadFixture(FIXTURE_INPUT, CORE_PROVIDERS);
    expect(outcome.tree).toBeDefined();
    const node = tsAdapter.navigate(outcome.tree, ["object:Product"]);
    expect(node).toBeDefined();

    const result = tsAdapter.invoke(node, "object.own-fields", {});
    expect(result).toEqual({ names: ["id", "name"] });
  });

  test("invoke object.find-field with existing name returns {name}", async () => {
    const outcome = await tsAdapter.loadFixture(FIXTURE_INPUT, CORE_PROVIDERS);
    expect(outcome.tree).toBeDefined();
    const node = tsAdapter.navigate(outcome.tree, ["object:Product"]);
    expect(node).toBeDefined();

    const result = tsAdapter.invoke(node, "object.find-field", { name: "id" });
    expect(result).toEqual({ name: "id" });
  });

  test("invoke object.find-field with absent name returns {absent:true}", async () => {
    const outcome = await tsAdapter.loadFixture(FIXTURE_INPUT, CORE_PROVIDERS);
    expect(outcome.tree).toBeDefined();
    const node = tsAdapter.navigate(outcome.tree, ["object:Product"]);
    expect(node).toBeDefined();

    const result = tsAdapter.invoke(node, "object.find-field", { name: "nonexistent" });
    expect(result).toEqual({ absent: true });
  });

  test("invoke object.primary-identity returns {subtype: 'primary'}", async () => {
    const outcome = await tsAdapter.loadFixture(FIXTURE_INPUT, CORE_PROVIDERS);
    expect(outcome.tree).toBeDefined();
    const node = tsAdapter.navigate(outcome.tree, ["object:Product"]);
    expect(node).toBeDefined();

    const result = tsAdapter.invoke(node, "object.primary-identity", {});
    expect(result).toEqual({ subtype: "primary" });
  });

  test("invoke field.is-required on 'id' returns {scalar: boolean}", async () => {
    const outcome = await tsAdapter.loadFixture(FIXTURE_INPUT, CORE_PROVIDERS);
    expect(outcome.tree).toBeDefined();
    const node = tsAdapter.navigate(outcome.tree, ["object:Product", "field:id"]);
    expect(node).toBeDefined();

    const result = tsAdapter.invoke(node, "field.is-required", {});
    expect(result).toEqual({ scalar: false });
  });

  test("invoke field.max-length on 'id' returns {absent:true} (no maxLength on long)", async () => {
    const outcome = await tsAdapter.loadFixture(FIXTURE_INPUT, CORE_PROVIDERS);
    expect(outcome.tree).toBeDefined();
    const node = tsAdapter.navigate(outcome.tree, ["object:Product", "field:id"]);
    expect(node).toBeDefined();

    const result = tsAdapter.invoke(node, "field.max-length", {});
    expect(result).toEqual({ absent: true });
  });

  test("invoke field.effective-validators on 'id' returns {names: []}", async () => {
    const outcome = await tsAdapter.loadFixture(FIXTURE_INPUT, CORE_PROVIDERS);
    expect(outcome.tree).toBeDefined();
    const node = tsAdapter.navigate(outcome.tree, ["object:Product", "field:id"]);
    expect(node).toBeDefined();

    const result = tsAdapter.invoke(node, "field.effective-validators", {});
    expect(result).toEqual({ names: [] });
  });

  test("invoke field.effective-tree on 'id' returns serialized subtree", async () => {
    const outcome = await tsAdapter.loadFixture(FIXTURE_INPUT, CORE_PROVIDERS);
    expect(outcome.tree).toBeDefined();
    const node = tsAdapter.navigate(outcome.tree, ["object:Product", "field:id"]);
    expect(node).toBeDefined();

    const result = tsAdapter.invoke(node, "field.effective-tree", {});
    expect(result).toHaveProperty("effective-tree");
    expect(typeof (result as { "effective-tree": string })["effective-tree"]).toBe("string");
    // The serialized form includes the field type/subtype key and the name
    expect((result as { "effective-tree": string })["effective-tree"]).toContain("field.long");
    expect((result as { "effective-tree": string })["effective-tree"]).toContain("id");
  });

  test("invoke with an unbound capability id throws UnknownCapabilityError", async () => {
    const outcome = await tsAdapter.loadFixture(FIXTURE_INPUT, CORE_PROVIDERS);
    expect(outcome.tree).toBeDefined();
    const node = tsAdapter.navigate(outcome.tree, ["object:Product"]);
    expect(node).toBeDefined();

    expect(() => tsAdapter.invoke(node, "object.no-such-capability", {})).toThrow(
      UnknownCapabilityError,
    );
  });
});

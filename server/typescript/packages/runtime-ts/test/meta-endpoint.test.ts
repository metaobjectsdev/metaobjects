import { describe, test, expect } from "bun:test";
import { canonicalSerializeEffective } from "@metaobjectsdev/metadata";
import { META_ROUTE_PATH, metaJson } from "../src/meta-endpoint.js";
import { loadTestModel } from "./helpers/load-test-model.js";

describe("meta-endpoint", () => {
  test("the route path is the cross-port contract value", () => {
    expect(META_ROUTE_PATH).toBe("/_meta");
  });

  test("metaJson returns the EFFECTIVE canonical serialization", async () => {
    const root = await loadTestModel();
    expect(metaJson(root)).toBe(canonicalSerializeEffective(root));
  });

  test("metaJson inlines a member inherited via extends", async () => {
    const root = await loadTestModel();
    // The effective form materializes the super-chain merge, so an inherited
    // field appears in the child's own children array.
    const parsed = JSON.parse(metaJson(root)) as Record<string, unknown>;
    expect(JSON.stringify(parsed)).toContain("createdAt");
  });
});

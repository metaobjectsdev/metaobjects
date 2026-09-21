import { describe, test, expect } from "bun:test";
import { canonicalSerializeEffective, canonicalSerialize, TYPE_OBJECT, TYPE_FIELD } from "@metaobjectsdev/metadata";
import { OBJECT_SUBTYPE_ENTITY, FIELD_SUBTYPE_STRING } from "@metaobjectsdev/metadata/constants";
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

  test("metaJson inlines a member inherited via extends (effective ≠ raw)", async () => {
    const root = await loadTestModel();

    // The effective form materializes the super-chain merge, so inherited
    // fields (like createdAt from BaseEntity) appear in Subscriber's children.
    // The raw form does not inline inherited members. This test verifies that
    // metaJson calls canonicalSerializeEffective, not canonicalSerialize.

    const effectiveStr = metaJson(root);
    const rawStr = canonicalSerialize(root);
    const effectiveParsed = JSON.parse(effectiveStr) as Record<string, unknown>;
    const rawParsed = JSON.parse(rawStr) as Record<string, unknown>;

    // Helper to find entity by name and get its children array
    const getEntityChildren = (model: Record<string, unknown>, entityName: string) => {
      const root = model["metadata.root"] as Record<string, unknown>;
      const children = root.children as Array<Record<string, Record<string, unknown>>>;
      const entityObj = children.find(c => {
        const entity = c[`${TYPE_OBJECT}.${OBJECT_SUBTYPE_ENTITY}`];
        return entity && entity.name === entityName;
      });
      if (!entityObj) return [];
      const entity = entityObj[`${TYPE_OBJECT}.${OBJECT_SUBTYPE_ENTITY}`];
      if (!entity || typeof entity !== "object") return [];
      return ((entity as Record<string, unknown>).children || []) as Array<Record<string, Record<string, unknown>>>;
    };

    const effectiveSubscriberChildren = getEntityChildren(effectiveParsed, "Subscriber");
    const rawSubscriberChildren = getEntityChildren(rawParsed, "Subscriber");

    // Effective form should have createdAt (inherited from BaseEntity)
    const effectiveHasCreatedAt = effectiveSubscriberChildren.some(c => {
      const fieldObj = c[`${TYPE_FIELD}.${FIELD_SUBTYPE_STRING}`];
      return fieldObj && fieldObj.name === "createdAt";
    });
    expect(effectiveHasCreatedAt, "effective Subscriber should inherit createdAt").toBe(true);

    // Raw form should NOT have createdAt (only direct children: email)
    const rawHasCreatedAt = rawSubscriberChildren.some(c => {
      const fieldObj = c[`${TYPE_FIELD}.${FIELD_SUBTYPE_STRING}`];
      return fieldObj && fieldObj.name === "createdAt";
    });
    expect(rawHasCreatedAt, "raw Subscriber should not have createdAt").toBe(false);
  });
});

import { describe, test, expect } from "bun:test";
import { TypeId, TYPE_OBJECT, TYPE_FIELD, TYPE_IDENTITY,
         FIELD_SUBTYPE_LONG,
         IDENTITY_SUBTYPE_PRIMARY,
         OBJECT_SUBTYPE_ENTITY } from "@metaobjects/metadata";
import { meta, metaRoot } from "./_meta-build.js";
import { buildPkMap, type PkInfo } from "../src/pk-resolver.js";

describe("buildPkMap", () => {
  test("maps entity name → PK field info", () => {
    const root = metaRoot();
    const user = meta(new TypeId(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY), "User");
    const userId = meta(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_LONG), "id");
    user.addChild(userId);
    const userIdentity = meta(new TypeId(TYPE_IDENTITY, IDENTITY_SUBTYPE_PRIMARY), "primary");
    userIdentity.setAttr("fields", ["id"]);
    userIdentity.setAttr("generation", "increment");
    user.addChild(userIdentity);
    root.addChild(user);

    const pkMap = buildPkMap(root);
    const info = pkMap.get("User");
    expect(info).toBeDefined();
    expect(info!.fieldName).toBe("id");
    expect(info!.fieldSubType).toBe(FIELD_SUBTYPE_LONG);
    expect(info!.generation).toBe("increment");
  });

  test("entity without primary identity has undefined entry", () => {
    const root = metaRoot();
    const widget = meta(new TypeId(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY), "Widget");
    root.addChild(widget);
    const pkMap = buildPkMap(root);
    expect(pkMap.has("Widget")).toBe(false);
  });
});

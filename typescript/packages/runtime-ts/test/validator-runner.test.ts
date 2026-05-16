import { describe, test, expect } from "bun:test";
import type { MetaModel } from "@metaobjects/metadata";
import { TypeId, TYPE_OBJECT, TYPE_FIELD, TYPE_VALIDATOR,
         FIELD_SUBTYPE_STRING, FIELD_SUBTYPE_INT, FIELD_SUBTYPE_LONG, FIELD_SUBTYPE_BOOLEAN,
         VALIDATOR_SUBTYPE_REQUIRED, VALIDATOR_SUBTYPE_LENGTH, VALIDATOR_SUBTYPE_REGEX,
         OBJECT_SUBTYPE_ENTITY } from "@metaobjects/metadata";
import { meta } from "./_meta-build.js";
import { runValidators } from "../src/validator-runner.js";

function makeEntity(buildFields: (e: MetaModel) => void): MetaModel {
  const e = meta(new TypeId(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY), "Post");
  buildFields(e);
  return e;
}

describe("runValidators — required", () => {
  test("validator.required: missing field → error", () => {
    const e = makeEntity((post) => {
      const title = meta(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_STRING), "title");
      title.addChild(meta(new TypeId(TYPE_VALIDATOR, VALIDATOR_SUBTYPE_REQUIRED), "required"));
      post.addChild(title);
    });
    const result = runValidators(e, {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.field).toBe("title");
      expect(result.errors[0]?.rule).toBe("required");
    }
  });

  test("@required attr shortcut", () => {
    const e = makeEntity((post) => {
      const title = meta(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_STRING), "title");
      title.setAttr("required", true);
      post.addChild(title);
    });
    const result = runValidators(e, {});
    expect(result.ok).toBe(false);
  });

  test("required + provided → ok", () => {
    const e = makeEntity((post) => {
      const title = meta(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_STRING), "title");
      title.setAttr("required", true);
      post.addChild(title);
    });
    expect(runValidators(e, { title: "hello" }).ok).toBe(true);
  });
});

describe("runValidators — length", () => {
  test("string longer than max → error", () => {
    const e = makeEntity((post) => {
      const title = meta(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_STRING), "title");
      const v = meta(new TypeId(TYPE_VALIDATOR, VALIDATOR_SUBTYPE_LENGTH), "len");
      v.setAttr("max", 5);
      title.addChild(v);
      post.addChild(title);
    });
    const result = runValidators(e, { title: "way too long" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.rule).toBe("length");
  });

  test("string shorter than min → error", () => {
    const e = makeEntity((post) => {
      const title = meta(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_STRING), "title");
      const v = meta(new TypeId(TYPE_VALIDATOR, VALIDATOR_SUBTYPE_LENGTH), "len");
      v.setAttr("min", 3);
      title.addChild(v);
      post.addChild(title);
    });
    expect(runValidators(e, { title: "ab" }).ok).toBe(false);
  });

  test("@maxLength attr shortcut", () => {
    const e = makeEntity((post) => {
      const title = meta(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_STRING), "title");
      title.setAttr("maxLength", 5);
      post.addChild(title);
    });
    expect(runValidators(e, { title: "way too long" }).ok).toBe(false);
  });
});

describe("runValidators — regex", () => {
  test("non-matching string → error", () => {
    const e = makeEntity((post) => {
      const slug = meta(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_STRING), "slug");
      const v = meta(new TypeId(TYPE_VALIDATOR, VALIDATOR_SUBTYPE_REGEX), "fmt");
      v.setAttr("pattern", "^[a-z0-9-]+$");
      slug.addChild(v);
      post.addChild(slug);
    });
    expect(runValidators(e, { slug: "Has Spaces" }).ok).toBe(false);
  });

  test("matching string → ok", () => {
    const e = makeEntity((post) => {
      const slug = meta(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_STRING), "slug");
      const v = meta(new TypeId(TYPE_VALIDATOR, VALIDATOR_SUBTYPE_REGEX), "fmt");
      v.setAttr("pattern", "^[a-z0-9-]+$");
      slug.addChild(v);
      post.addChild(slug);
    });
    expect(runValidators(e, { slug: "valid-slug-123" }).ok).toBe(true);
  });

  test("invalid pattern → structured error, never throws", () => {
    const e = makeEntity((post) => {
      const slug = meta(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_STRING), "slug");
      const v = meta(new TypeId(TYPE_VALIDATOR, VALIDATOR_SUBTYPE_REGEX), "fmt");
      v.setAttr("pattern", "[unterminated");
      slug.addChild(v);
      post.addChild(slug);
    });
    const result = runValidators(e, { slug: "anything" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.rule).toBe("regex");
      expect(result.errors[0]?.message).toContain("invalid validator pattern");
    }
  });
});

describe("runValidators — type checks (basic)", () => {
  test("int field with non-number value → error", () => {
    const e = makeEntity((post) => {
      post.addChild(meta(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_INT), "count"));
    });
    expect(runValidators(e, { count: "not a number" }).ok).toBe(false);
  });

  test("boolean field with non-boolean value → error", () => {
    const e = makeEntity((post) => {
      post.addChild(meta(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_BOOLEAN), "active"));
    });
    expect(runValidators(e, { active: "yes" }).ok).toBe(false);
  });

  test("nullable fields skip type-check on null", () => {
    const e = makeEntity((post) => {
      post.addChild(meta(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_INT), "count"));
    });
    expect(runValidators(e, { count: null }).ok).toBe(true);
  });
});

describe("runValidators — multiple failures", () => {
  test("collects all failures across fields", () => {
    const e = makeEntity((post) => {
      const title = meta(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_STRING), "title");
      title.setAttr("required", true);
      title.setAttr("maxLength", 5);
      post.addChild(title);
      const count = meta(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_INT), "count");
      count.setAttr("required", true);
      post.addChild(count);
    });
    const result = runValidators(e, { title: "way too long", count: "bad" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThanOrEqual(2); // length + type
    }
  });
});

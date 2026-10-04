import { describe, test, expect } from "bun:test";
import type { MetaData } from "@metaobjectsdev/metadata";
import { TypeId, TYPE_OBJECT, TYPE_FIELD, TYPE_VALIDATOR, TYPE_IDENTITY, IDENTITY_SUBTYPE_PRIMARY,
         FIELD_SUBTYPE_URI, FIELD_SUBTYPE_INET, VALIDATOR_SUBTYPE_NUMERIC, VALIDATOR_SUBTYPE_ARRAY,
         FIELD_SUBTYPE_STRING, FIELD_SUBTYPE_INT, FIELD_SUBTYPE_LONG, FIELD_SUBTYPE_BOOLEAN,
         FIELD_SUBTYPE_CURRENCY, FIELD_SUBTYPE_DOUBLE,
         VALIDATOR_SUBTYPE_REQUIRED, VALIDATOR_SUBTYPE_LENGTH, VALIDATOR_SUBTYPE_REGEX,
         OBJECT_SUBTYPE_ENTITY } from "@metaobjectsdev/metadata";
import { meta } from "./_meta-build.js";
import { runValidators } from "../src/validator-runner.js";

function makeEntity(buildFields: (e: MetaData) => void): MetaData {
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

  test("FR-036 Pin 1: a present empty string on a @required field → error; whitespace-only → ok", () => {
    const e = makeEntity((post) => {
      const title = meta(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_STRING), "title");
      title.setAttr("required", true);
      post.addChild(title);
    });
    // Non-empty floor: "" is rejected (matches the generated Zod .min(1)) …
    const empty = runValidators(e, { title: "" });
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.errors[0]?.rule).toBe("length");
    // … but whitespace-only is accepted (Ruling 1 — never trim).
    expect(runValidators(e, { title: "   " }).ok).toBe(true);
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

describe("runValidators — int64 write contract (field.long / field.currency)", () => {
  // A full int64 (> 2^53) cannot survive a JS `number`; the runtime accepts a
  // numeric string OR a bigint on write for field.long / field.currency so the
  // wire BIGINT round-trips exactly. (field.int/double/float stay JS-safe → number.)
  test("field.long accepts a numeric string (full int64 max)", () => {
    const e = makeEntity((post) => {
      post.addChild(meta(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_LONG), "lVal"));
    });
    expect(runValidators(e, { lVal: "9223372036854775807" }).ok).toBe(true);
  });

  test("field.long accepts a bigint", () => {
    const e = makeEntity((post) => {
      post.addChild(meta(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_LONG), "lVal"));
    });
    expect(runValidators(e, { lVal: 9223372036854775807n }).ok).toBe(true);
  });

  test("field.long still accepts an in-band number", () => {
    const e = makeEntity((post) => {
      post.addChild(meta(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_LONG), "lVal"));
    });
    expect(runValidators(e, { lVal: 42 }).ok).toBe(true);
  });

  test("field.long rejects a non-numeric string", () => {
    const e = makeEntity((post) => {
      post.addChild(meta(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_LONG), "lVal"));
    });
    expect(runValidators(e, { lVal: "not a number" }).ok).toBe(false);
  });

  test("field.currency accepts a numeric string (full int64 minor units)", () => {
    const e = makeEntity((post) => {
      post.addChild(meta(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_CURRENCY), "moneyVal"));
    });
    expect(runValidators(e, { moneyVal: "9223372036854775807" }).ok).toBe(true);
  });

  test("field.currency rejects a non-numeric string", () => {
    const e = makeEntity((post) => {
      post.addChild(meta(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_CURRENCY), "moneyVal"));
    });
    expect(runValidators(e, { moneyVal: "1.5" }).ok).toBe(false);
  });

  test("field.double still requires a number (no string fidelity hatch)", () => {
    const e = makeEntity((post) => {
      post.addChild(meta(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_DOUBLE), "dVal"));
    });
    expect(runValidators(e, { dVal: "0.125" }).ok).toBe(false);
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

// A scalar array (`field.string isArray`) was type-checked as ONE string, so every write of a
// string/number array through the ObjectManager failed `tags: type` on every dialect. Each
// element is now checked against the element rules, and an element error names its index.
describe("runValidators — scalar arrays", () => {
  const load = async () => {
    const { MetaDataLoader, InMemoryStringSource } = await import("@metaobjectsdev/metadata");
    const r = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify({
      "metadata.root": { package: "p", children: [{ "object.entity": { name: "A", children: [
        { "field.string": { name: "tags", isArray: true, "@maxLength": 3 } },
        { "field.int": { name: "scores", isArray: true } },
      ] } }] },
    }))]);
    expect(r.errors).toEqual([]);
    return r.root.objects()[0]!;
  };

  test("an array of valid elements passes", async () => {
    expect(runValidators(await load(), { tags: ["a", "bc"], scores: [1, 2] })).toEqual({ ok: true });
  });

  test("a non-array value is a type error", async () => {
    const r = runValidators(await load(), { tags: "a" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatchObject({ field: "tags", rule: "type", expected: "array" });
  });

  test("an element error names its index", async () => {
    const r = runValidators(await load(), { tags: ["ok", "toolong"], scores: [1, "x"] });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.map((e) => `${e.field}:${e.rule}`)).toEqual(["tags[1]:length", "scores[1]:type"]);
    }
  });
});

// ── Rules the validation-conformance corpus requires of the run-time runner ──────────────

function fieldOf(subType: string, name: string, attrs: Record<string, string | number | boolean> = {}): MetaData {
  const f = meta(new TypeId(TYPE_FIELD, subType), name);
  for (const [k, v] of Object.entries(attrs)) f.setAttr(k, v);
  return f;
}

function validatorOf(subType: string, attrs: Record<string, string | number | boolean> = {}): MetaData {
  const v = meta(new TypeId(TYPE_VALIDATOR, subType), subType);
  for (const [k, val] of Object.entries(attrs)) v.setAttr(k, val);
  return v;
}

function entityWith(...fields: MetaData[]): MetaData {
  return makeEntity((e) => { for (const f of fields) e.addChild(f); });
}

function errorsOf(e: MetaData, data: Record<string, unknown>, opts = {}) {
  const r = runValidators(e, data, opts);
  return r.ok ? [] : r.errors;
}

describe("runValidators — validator.numeric", () => {
  const score = () => {
    const f = fieldOf(FIELD_SUBTYPE_INT, "score");
    f.addChild(validatorOf(VALIDATOR_SUBTYPE_NUMERIC, { min: 0, max: 100 }));
    return entityWith(f);
  };

  test("bounds are inclusive", () => {
    expect(errorsOf(score(), { score: 0 })).toEqual([]);
    expect(errorsOf(score(), { score: 100 })).toEqual([]);
  });

  test("below @min → numeric failure with the bound and the value", () => {
    expect(errorsOf(score(), { score: -1 })).toEqual([{
      field: "score", rule: "numeric", message: "'score' must be at least 0 (got -1)",
      expected: { min: 0 }, received: -1,
    }]);
  });

  test("above @max → numeric failure", () => {
    expect(errorsOf(score(), { score: 101 })).toEqual([{
      field: "score", rule: "numeric", message: "'score' must be at most 100 (got 101)",
      expected: { max: 100 }, received: 101,
    }]);
  });

  test("an int64 numeric string is compared as an integer and echoed as given", () => {
    const f = fieldOf(FIELD_SUBTYPE_LONG, "total");
    f.addChild(validatorOf(VALIDATOR_SUBTYPE_NUMERIC, { min: 10 }));
    const e = entityWith(f);
    expect(errorsOf(e, { total: "9223372036854775807" })).toEqual([]);
    expect(errorsOf(e, { total: 12n })).toEqual([]);
    expect(errorsOf(e, { total: "5" })).toEqual([{
      field: "total", rule: "numeric", message: "'total' must be at least 10 (got 5)",
      expected: { min: 10 }, received: "5",
    }]);
  });

  test("validator.numeric on a string field is ignored", () => {
    const f = fieldOf(FIELD_SUBTYPE_STRING, "code");
    f.addChild(validatorOf(VALIDATOR_SUBTYPE_NUMERIC, { min: 5 }));
    expect(errorsOf(entityWith(f), { code: "1" })).toEqual([]);
  });
});

describe("runValidators — validator.array", () => {
  const tags = () => {
    const f = fieldOf(FIELD_SUBTYPE_STRING, "tags");
    f.isArray = true;
    f.addChild(validatorOf(VALIDATOR_SUBTYPE_ARRAY, { min: 1, max: 3 }));
    return entityWith(f);
  };

  test("too few elements", () => {
    expect(errorsOf(tags(), { tags: [] })).toEqual([{
      field: "tags", rule: "array", message: "'tags' must have at least 1 items (got 0)",
      expected: { min: 1 }, received: 0,
    }]);
  });

  test("too many elements", () => {
    expect(errorsOf(tags(), { tags: ["a", "b", "c", "d"] })).toEqual([{
      field: "tags", rule: "array", message: "'tags' must have at most 3 items (got 4)",
      expected: { max: 3 }, received: 4,
    }]);
  });

  test("element errors are still reported alongside a size failure", () => {
    const errors = errorsOf(tags(), { tags: ["a", "b", "c", 4] });
    expect(errors.map((e) => `${e.field}:${e.rule}`)).toEqual(["tags:array", "tags[3]:type"]);
  });

  test("validator.array on a non-array field is ignored", () => {
    const f = fieldOf(FIELD_SUBTYPE_STRING, "name");
    f.addChild(validatorOf(VALIDATOR_SUBTYPE_ARRAY, { min: 2 }));
    expect(errorsOf(entityWith(f), { name: "x" })).toEqual([]);
  });
});

describe("runValidators — length precedence", () => {
  test("@maxLength × validator.length @max is strictest-wins", () => {
    const f = fieldOf(FIELD_SUBTYPE_STRING, "label", { maxLength: 8 });
    f.addChild(validatorOf(VALIDATOR_SUBTYPE_LENGTH, { max: 4 }));
    const e = entityWith(f);
    expect(errorsOf(e, { label: "1234" })).toEqual([]);
    expect(errorsOf(e, { label: "12345" })[0]?.expected).toEqual({ max: 4 });
  });

  test("an authored validator.length @min: 0 opts a required string out of the non-empty floor", () => {
    const f = fieldOf(FIELD_SUBTYPE_STRING, "note", { required: true });
    f.addChild(validatorOf(VALIDATOR_SUBTYPE_LENGTH, { min: 0 }));
    const e = entityWith(f);
    expect(errorsOf(e, { note: "" })).toEqual([]);
    expect(errorsOf(e, {}).map((x) => x.rule)).toEqual(["required"]);
  });

  test("length counts UTF-16 code units", () => {
    const e = entityWith(fieldOf(FIELD_SUBTYPE_STRING, "icon", { maxLength: 1 }));
    expect(errorsOf(e, { icon: "\u{1F600}" })[0]?.received).toBe(2);
  });
});

describe("runValidators — field.uri / field.inet format", () => {
  const e = () => entityWith(
    fieldOf(FIELD_SUBTYPE_URI, "website"),
    fieldOf(FIELD_SUBTYPE_INET, "sourceIp"),
    fieldOf(FIELD_SUBTYPE_URI, "citationUrl", { lenient: true }),
    fieldOf(FIELD_SUBTYPE_INET, "reportedIp", { lenient: true }),
  );

  test("strict uri accepts an absolute URI, padded or not", () => {
    for (const website of ["https://a.com", "  https://a.com  ", "mailto:a@b.com", "urn:isbn:0451450523"]) {
      expect(errorsOf(e(), { website })).toEqual([]);
    }
  });

  test("strict uri rejects a scheme-less value, an empty authority and a bare scheme", () => {
    for (const website of ["example.com", "/path/only", "not a url", "http://", "http:", ""]) {
      expect(errorsOf(e(), { website })).toEqual([{
        field: "website", rule: "format", message: "'website' must be an absolute URI",
        expected: "uri", received: website,
      }]);
    }
  });

  test("strict inet accepts IPv4 and IPv6 literals only", () => {
    for (const sourceIp of ["192.168.0.1", "::1", "2001:db8::1", "::ffff:1.2.3.4"]) {
      expect(errorsOf(e(), { sourceIp })).toEqual([]);
    }
    expect(errorsOf(e(), { sourceIp: "192.168.01.1" })).toEqual([{
      field: "sourceIp", rule: "format", message: "'sourceIp' must be an IPv4 or IPv6 address",
      expected: "inet", received: "192.168.01.1",
    }]);
  });

  test("@lenient accepts any string", () => {
    expect(errorsOf(e(), { citationUrl: "not a url", reportedIp: "example.com" })).toEqual([]);
  });

  test("a non-string value is a type failure, lenient or not", () => {
    expect(errorsOf(e(), { website: 5, reportedIp: 5 }).map((x) => `${x.field}:${x.rule}`))
      .toEqual(["website:type", "reportedIp:type"]);
  });
});

describe("runValidators — assigned primary key", () => {
  const ledger = (generation?: string, codeAttrs: Record<string, string> = {}) => {
    const pk = meta(new TypeId(TYPE_IDENTITY, IDENTITY_SUBTYPE_PRIMARY), "pk");
    pk.setAttr("fields", "code");
    if (generation !== undefined) pk.setAttr("generation", generation);
    const e = entityWith(fieldOf(FIELD_SUBTYPE_STRING, "code", codeAttrs), fieldOf(FIELD_SUBTYPE_STRING, "label"));
    e.addChild(pk);
    return e;
  };

  test("is required on insert whatever @required says", () => {
    expect(errorsOf(ledger(), { label: "x" })).toEqual([
      { field: "code", rule: "required", message: "'code' is required" },
    ]);
    expect(errorsOf(ledger(), { code: "L-1" })).toEqual([]);
  });

  test("a generated key is not demanded", () => {
    expect(errorsOf(ledger("increment"), {})).toEqual([]);
    expect(errorsOf(ledger("uuid"), {})).toEqual([]);
  });

  test("a key with a @default may be omitted", () => {
    expect(errorsOf(ledger(undefined, { default: "L-0" }), {})).toEqual([]);
  });

  test("partial mode leaves an absent key alone but rejects a present null", () => {
    expect(errorsOf(ledger(), {}, { partial: true })).toEqual([]);
    expect(errorsOf(ledger(), { code: null }, { partial: true }).map((x) => x.rule)).toEqual(["required"]);
  });

  test("a store-filled key is exempt when absent", () => {
    expect(errorsOf(ledger(), {}, { storeFilled: ["code"] })).toEqual([]);
  });

  test("presence only — the non-empty floor belongs to a declared @required", () => {
    expect(errorsOf(ledger(), { code: "" })).toEqual([]);
  });
});

describe("runValidators — value-object @objectRef resolution", () => {
  test("a package-qualified ref picks the object in that package, not the first of that name", async () => {
    const { MetaDataLoader, InMemoryStringSource } = await import("@metaobjectsdev/metadata");
    const file = (pkg: string, children: unknown[]) =>
      new InMemoryStringSource(JSON.stringify({ "metadata.root": { package: pkg, children } }));
    const r = await new MetaDataLoader().load([
      file("shipping", [{ "object.value": { name: "Address", children: [
        { "field.string": { name: "zip", "@required": true } },
      ] } }]),
      file("billing", [{ "object.value": { name: "Address", children: [
        { "field.string": { name: "city", "@required": true } },
      ] } }]),
      file("orders", [{ "object.entity": { name: "Order", children: [
        { "field.object": { name: "addr", "@objectRef": "billing::Address" } },
      ] } }]),
    ]);
    expect(r.errors).toEqual([]);
    const order = r.root.objects().find((o) => o.name === "Order")!;
    expect(errorsOf(order, { addr: { city: "NYC" } })).toEqual([]);
    expect(errorsOf(order, { addr: { zip: "12345" } }).map((e) => e.field)).toEqual(["addr.city"]);
  });
});

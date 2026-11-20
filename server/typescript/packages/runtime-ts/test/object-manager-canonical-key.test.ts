/**
 * A numeric primary key is read only from its canonical spelling.
 *
 * `Number()` reads `0x1`, `1e0`, `0b1`, ` 1 `, `+1` and the empty string as numbers, so a path
 * parameter or ref string that is no key named row 1 (or row 0). ObjectManager refuses such text
 * with `InvalidKeyError` (a `ValidationError`), which the mounts answer `400 {"error":"invalid_id"}`.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import Fastify from "fastify";
import type { MetaData } from "@metaobjectsdev/metadata";
import { TypeId, TYPE_OBJECT, TYPE_FIELD, TYPE_IDENTITY, FIELD_SUBTYPE_LONG, FIELD_SUBTYPE_DECIMAL, FIELD_SUBTYPE_STRING,
         IDENTITY_SUBTYPE_PRIMARY, OBJECT_SUBTYPE_ENTITY, IDENTITY_ATTR_FIELDS } from "@metaobjectsdev/metadata";
import { z } from "zod";
import { meta } from "./_meta-build.js";
import { ObjectManager } from "../src/object-manager.js";
import { inMemoryDriver } from "../src/drivers/in-memory-driver.js";
import { InvalidKeyError, ValidationError } from "../src/errors.js";
import { isCanonicalDecimal, isCanonicalInteger } from "../src/canonical-key.js";
import { mountCrudRoutes } from "../src/fastify/index.js";
import { coerceIdForColumn, parseId, rawIdLiteral } from "../src/drizzle-fastify/util.js";

function entity(name: string, pkSubtype: string): MetaData {
  const e = meta(new TypeId(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY), name);
  e.addChild(meta(new TypeId(TYPE_FIELD, pkSubtype), "id"));
  e.addChild(meta(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_STRING), "title"));
  const primary = meta(new TypeId(TYPE_IDENTITY, IDENTITY_SUBTYPE_PRIMARY), "primary");
  primary.setAttr(IDENTITY_ATTR_FIELDS, ["id"]);
  e.addChild(primary);
  return e;
}

function root(...entities: MetaData[]): MetaData {
  const r = meta(new TypeId("metadata", "base"), "");
  for (const e of entities) r.addChild(e);
  return r;
}

const NOT_KEYS = ["0x1", "0X1", "0b1", "0o1", "1e0", "1E0", "+1", " 1", "1 ", "", "01", "-0", "1.", "1.0", "abc"];

let om: ObjectManager;

beforeEach(() => {
  const driver = inMemoryDriver({
    seed: { posts: [{ id: 1, title: "One" }, { id: 0, title: "Zero" }], prices: [{ id: 1.5, title: "Cheap" }] },
    pkFields: { posts: ["id"], prices: ["id"] },
  });
  om = new ObjectManager({ metadata: root(entity("Post", FIELD_SUBTYPE_LONG), entity("Price", FIELD_SUBTYPE_DECIMAL)), driver });
});

describe("canonical key text", () => {
  test("an integer is an optional minus and digits with no leading zero", () => {
    for (const ok of ["0", "1", "42", "-7", "1000"]) expect(isCanonicalInteger(ok)).toBe(true);
    for (const bad of [...NOT_KEYS.filter((t) => t !== "1.0" && t !== "1."), "1.0", "1.", "1.5", "--1", "-", "٣"]) {
      expect(isCanonicalInteger(bad)).toBe(false);
    }
  });

  test("a canonical integer that is not one exact JS number is no key", () => {
    expect(isCanonicalInteger("9007199254740991")).toBe(true);
    expect(isCanonicalInteger("-9007199254740991")).toBe(true);
    expect(isCanonicalInteger("9007199254740992")).toBe(false);
    expect(isCanonicalInteger("9007199254740993")).toBe(false);
    expect(isCanonicalDecimal("9007199254740991")).toBe(true);
    expect(isCanonicalDecimal("9007199254740992")).toBe(false);
    expect(isCanonicalDecimal("9007199254740993")).toBe(false);
    expect(isCanonicalDecimal("1" + "0".repeat(400))).toBe(false);
    expect(isCanonicalDecimal("1" + "0".repeat(400) + ".5")).toBe(false);
  });

  test("a decimal adds an optional fraction of at least one digit", () => {
    for (const ok of ["0", "1.5", "-0.25", "10.50", "7"]) expect(isCanonicalDecimal(ok)).toBe(true);
    for (const bad of ["1.", ".5", "1e3", "0x1", " 1.5", "+1.5", "-0.0", "01.5", "1.5.2", ""]) {
      expect(isCanonicalDecimal(bad)).toBe(false);
    }
  });
});

describe("ObjectManager — an integer key must be canonical decimal integer text", () => {
  test("a canonical id is read, including 0", async () => {
    expect((await om.findById("Post", "1"))?.title).toBe("One");
    expect((await om.findById("Post", "0"))?.title).toBe("Zero");
  });

  for (const text of NOT_KEYS) {
    test(`findById, update and delete refuse ${JSON.stringify(text)}`, async () => {
      await expect(om.findById("Post", text)).rejects.toBeInstanceOf(InvalidKeyError);
      await expect(om.update("Post", text, { title: "x" })).rejects.toBeInstanceOf(InvalidKeyError);
      await expect(om.delete("Post", text)).rejects.toBeInstanceOf(InvalidKeyError);
      expect((await om.findById("Post", "1"))?.title).toBe("One");
    });
  }

  test("a ref string carrying non-canonical key text is refused", async () => {
    await expect(om.load(`Post:${"0x1"}`)).rejects.toBeInstanceOf(InvalidKeyError);
  });

  test("the error is a ValidationError that names the entity, the field and the rule", async () => {
    const err = await om.findById("Post", "0x1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as InvalidKeyError).entity).toBe("Post");
    expect((err as InvalidKeyError).errors[0]?.field).toBe("id");
    expect((err as InvalidKeyError).errors[0]?.rule).toBe("invalid_key");
  });
});

describe("ObjectManager — a decimal key must be canonical decimal text", () => {
  test("a canonical decimal is read", async () => {
    expect((await om.findById("Price", "1.5"))?.title).toBe("Cheap");
  });

  for (const text of ["0x1", "1e0", "1.", ".5", "+1.5", " 1.5", ""]) {
    test(`findById refuses ${JSON.stringify(text)}`, async () => {
      await expect(om.findById("Price", text)).rejects.toBeInstanceOf(InvalidKeyError);
    });
  }
});

describe("ObjectManager — a decimal key past 2^53 is no key", () => {
  for (const text of ["9007199254740992", "9007199254740993"]) {
    test(`findById refuses ${text}`, async () => {
      await expect(om.findById("Price", text)).rejects.toBeInstanceOf(InvalidKeyError);
      await expect(om.findById("Post", text)).rejects.toBeInstanceOf(InvalidKeyError);
    });
  }
});

describe("HTTP mounts answer a non-canonical id 400 invalid_id", () => {
  test("the ObjectManager mount, on GET, PATCH and DELETE", async () => {
    const app = Fastify();
    const schema = z.object({ title: z.string().optional() });
    mountCrudRoutes({
      fastify: app, path: "/posts", entity: "Post", om: () => om,
      insertSchema: schema, updateSchema: schema,
    } as never);
    for (const [method, payload] of [["GET", undefined], ["PATCH", { title: "x" }], ["DELETE", undefined]] as const) {
      const res = await app.inject({ method, url: "/posts/0x1", ...(payload ? { payload } : {}) });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: "invalid_id" });
    }
    expect((await app.inject({ method: "GET", url: "/posts/1" })).statusCode).toBe(200);
    await app.close();
  });

  test("a numeric column id is read the same way", () => {
    const col = { dataType: "number" };
    expect(coerceIdForColumn(col, "1")).toBe(1);
    for (const text of ["0x1", "1e0", " 1", "+1", "", "1."]) expect(coerceIdForColumn(col, text)).toBeUndefined();
    for (const text of ["9007199254740992", "9007199254740993"]) expect(coerceIdForColumn(col, text)).toBeUndefined();
    expect(coerceIdForColumn(col, "9007199254740991")).toBe(9007199254740991);
  });

  test("parseId never turns text past 2^53 into a rounded number", () => {
    for (const text of ["9007199254740992", "9007199254740993"]) expect(parseId(text)).toBe(text);
    expect(parseId("9007199254740991")).toBe(9007199254740991);
  });
});

// A raw-SQL view has no column type to say a key is text, and SQLite converts a quoted `'01'` or
// `'1e0'` compared with an integer column back to a number: such text must not become a literal.
describe("rawIdLiteral on a raw-SQL view", () => {
  test("canonical numbers stay unquoted, other text is a quoted literal", () => {
    expect(rawIdLiteral("1")).toBe("1");
    expect(rawIdLiteral("-7")).toBe("-7");
    expect(rawIdLiteral("abc")).toBe("'abc'");
    expect(rawIdLiteral("o'neil")).toBe("'o''neil'");
    expect(rawIdLiteral("6f9619ff-8b86-d011-b42d-00c04fc964ff")).toBe("'6f9619ff-8b86-d011-b42d-00c04fc964ff'");
  });

  test("text that reads as a number without being its canonical spelling is no id", () => {
    for (const text of ["01", "1e0", "0x1", "+1", " 1", "1 ", "1.", "-0", "9007199254740992", "9007199254740993"]) {
      expect(rawIdLiteral(text)).toBeUndefined();
    }
  });
});

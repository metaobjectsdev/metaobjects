import { describe, test, expect } from "bun:test";
import { Loader } from "@metaobjects/metadata";
import {
  inferViewKind,
  zodTypeFor,
  currencyMetaFor,
  labelFor,
} from "../../src/templates/field-meta.js";

function loadField(json: unknown) {
  const result = new Loader().loadJson(JSON.stringify({
    metadata: { children: [
      { object: { name: "X", subType: "entity", children: [json] }}
    ]}
  }));
  return result.root.children()[0]!.children()[0]!;
}

describe("inferViewKind", () => {
  test("string field → 'text'", () => {
    expect(inferViewKind(loadField({ field: { name: "f", subType: "string" }}))).toBe("text");
  });
  test("boolean field → 'checkbox'", () => {
    expect(inferViewKind(loadField({ field: { name: "f", subType: "boolean" }}))).toBe("checkbox");
  });
  test("int field → 'number'", () => {
    expect(inferViewKind(loadField({ field: { name: "f", subType: "int" }}))).toBe("number");
  });
  test("currency field → 'currency'", () => {
    expect(inferViewKind(loadField({ field: { name: "f", subType: "currency" }}))).toBe("currency");
  });
  test("date field → 'date'", () => {
    expect(inferViewKind(loadField({ field: { name: "f", subType: "date" }}))).toBe("date");
  });
  test("time field → 'date'", () => {
    expect(inferViewKind(loadField({ field: { name: "f", subType: "time" }}))).toBe("date");
  });
  test("timestamp field → 'date'", () => {
    expect(inferViewKind(loadField({ field: { name: "f", subType: "timestamp" }}))).toBe("date");
  });
  test("long field → 'number'", () => {
    expect(inferViewKind(loadField({ field: { name: "f", subType: "long" }}))).toBe("number");
  });
  test("double field → 'number'", () => {
    expect(inferViewKind(loadField({ field: { name: "f", subType: "double" }}))).toBe("number");
  });
  test("unknown subtype falls back to 'text'", () => {
    expect(inferViewKind(loadField({ field: { name: "f", subType: "string" }}))).toBe("text");
  });
  test("explicit view child overrides default", () => {
    expect(inferViewKind(loadField({
      field: { name: "f", subType: "string",
        children: [{ view: { subType: "textarea" }}]
      }
    }))).toBe("textarea");
  });
});

describe("zodTypeFor", () => {
  test("string → z.string()", () => {
    expect(zodTypeFor(loadField({ field: { name: "f", subType: "string" }}))).toBe("z.string()");
  });
  test("int → z.number().int()", () => {
    expect(zodTypeFor(loadField({ field: { name: "f", subType: "int" }}))).toBe("z.number().int()");
  });
  test("long → z.number().int()", () => {
    expect(zodTypeFor(loadField({ field: { name: "f", subType: "long" }}))).toBe("z.number().int()");
  });
  test("currency → z.number().int() (same as int/long)", () => {
    expect(zodTypeFor(loadField({ field: { name: "f", subType: "currency" }}))).toBe("z.number().int()");
  });
  test("boolean → z.boolean()", () => {
    expect(zodTypeFor(loadField({ field: { name: "f", subType: "boolean" }}))).toBe("z.boolean()");
  });
  test("double → z.number()", () => {
    expect(zodTypeFor(loadField({ field: { name: "f", subType: "double" }}))).toBe("z.number()");
  });
  test("date → z.string() (ISO format)", () => {
    expect(zodTypeFor(loadField({ field: { name: "f", subType: "date" }}))).toBe("z.string()");
  });
  test("timestamp → z.string() (ISO format)", () => {
    expect(zodTypeFor(loadField({ field: { name: "f", subType: "timestamp" }}))).toBe("z.string()");
  });
});

describe("currencyMetaFor", () => {
  test("currency field with @currency='EUR' and view@locale='de-DE'", () => {
    const f = loadField({ field: { name: "f", subType: "currency", "@currency": "EUR",
      children: [{ view: { subType: "currency", "@locale": "de-DE" }}]
    }});
    expect(currencyMetaFor(f)).toEqual({ currency: "EUR", locale: "de-DE" });
  });
  test("currency field with no attrs → USD/en-US defaults", () => {
    expect(currencyMetaFor(loadField({ field: { name: "f", subType: "currency" }})))
      .toEqual({ currency: "USD", locale: "en-US" });
  });
  test("non-currency field → null", () => {
    expect(currencyMetaFor(loadField({ field: { name: "f", subType: "string" }}))).toBeNull();
  });
  test("currency field with explicit @currency only uses default locale", () => {
    expect(currencyMetaFor(loadField({ field: { name: "f", subType: "currency", "@currency": "GBP" }})))
      .toEqual({ currency: "GBP", locale: "en-US" });
  });
});

describe("labelFor", () => {
  test("uses @label attr on view child if present", () => {
    const f = loadField({ field: { name: "firstName", subType: "string",
      children: [{ view: { subType: "text", "@label": "First Name" }}]
    }});
    expect(labelFor(f)).toBe("First Name");
  });
  test("falls back to humanized field name", () => {
    expect(labelFor(loadField({ field: { name: "firstName", subType: "string" }})))
      .toBe("First Name");
  });
  test("PascalCase-style single word is capitalized", () => {
    expect(labelFor(loadField({ field: { name: "email", subType: "string" }})))
      .toBe("Email");
  });
  test("multi-word camelCase → space-separated Title Case", () => {
    expect(labelFor(loadField({ field: { name: "lastName", subType: "string" }})))
      .toBe("Last Name");
  });
});

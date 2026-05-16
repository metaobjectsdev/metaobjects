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
    "metadata.root": { children: [
      { "object.entity": { name: "X", children: [json] }}
    ]}
  }));
  if (result.errors.length > 0) {
    throw new Error(result.errors.map((e) => e.message).join("\n"));
  }
  return result.root.children()[0]!.children()[0]!;
}

describe("inferViewKind", () => {
  test("string field → 'text'", () => {
    expect(inferViewKind(loadField({ "field.string": { name: "f" }}))).toBe("text");
  });
  test("boolean field → 'checkbox'", () => {
    expect(inferViewKind(loadField({ "field.boolean": { name: "f" }}))).toBe("checkbox");
  });
  test("int field → 'number'", () => {
    expect(inferViewKind(loadField({ "field.int": { name: "f" }}))).toBe("number");
  });
  test("currency field → 'currency'", () => {
    expect(inferViewKind(loadField({ "field.currency": { name: "f" }}))).toBe("currency");
  });
  test("date field → 'date'", () => {
    expect(inferViewKind(loadField({ "field.date": { name: "f" }}))).toBe("date");
  });
  test("time field → 'date'", () => {
    expect(inferViewKind(loadField({ "field.time": { name: "f" }}))).toBe("date");
  });
  test("timestamp field → 'date'", () => {
    expect(inferViewKind(loadField({ "field.timestamp": { name: "f" }}))).toBe("date");
  });
  test("long field → 'number'", () => {
    expect(inferViewKind(loadField({ "field.long": { name: "f" }}))).toBe("number");
  });
  test("double field → 'number'", () => {
    expect(inferViewKind(loadField({ "field.double": { name: "f" }}))).toBe("number");
  });
  test("unknown subtype falls back to 'text'", () => {
    expect(inferViewKind(loadField({ "field.string": { name: "f" }}))).toBe("text");
  });
  test("explicit view child overrides default", () => {
    expect(inferViewKind(loadField({
      "field.string": { name: "f",
        children: [{ "view.textarea": {}}]
      }
    }))).toBe("textarea");
  });
});

describe("zodTypeFor", () => {
  test("string → z.string()", () => {
    expect(zodTypeFor(loadField({ "field.string": { name: "f" }}))).toBe("z.string()");
  });
  test("int → z.number().int()", () => {
    expect(zodTypeFor(loadField({ "field.int": { name: "f" }}))).toBe("z.number().int()");
  });
  test("long → z.number().int()", () => {
    expect(zodTypeFor(loadField({ "field.long": { name: "f" }}))).toBe("z.number().int()");
  });
  test("currency → z.number().int() (same as int/long)", () => {
    expect(zodTypeFor(loadField({ "field.currency": { name: "f" }}))).toBe("z.number().int()");
  });
  test("boolean → z.boolean()", () => {
    expect(zodTypeFor(loadField({ "field.boolean": { name: "f" }}))).toBe("z.boolean()");
  });
  test("double → z.number()", () => {
    expect(zodTypeFor(loadField({ "field.double": { name: "f" }}))).toBe("z.number()");
  });
  test("date → z.string() (ISO format)", () => {
    expect(zodTypeFor(loadField({ "field.date": { name: "f" }}))).toBe("z.string()");
  });
  test("timestamp → z.string() (ISO format)", () => {
    expect(zodTypeFor(loadField({ "field.timestamp": { name: "f" }}))).toBe("z.string()");
  });
});

describe("currencyMetaFor", () => {
  test("currency field with @currency='EUR' and view@locale='de-DE'", () => {
    const f = loadField({ "field.currency": { name: "f", "@currency": "EUR",
      children: [{ "view.currency": { "@locale": "de-DE" }}]
    }});
    expect(currencyMetaFor(f)).toEqual({ currency: "EUR", locale: "de-DE" });
  });
  test("currency field with no attrs → USD/en-US defaults", () => {
    expect(currencyMetaFor(loadField({ "field.currency": { name: "f" }})))
      .toEqual({ currency: "USD", locale: "en-US" });
  });
  test("non-currency field → null", () => {
    expect(currencyMetaFor(loadField({ "field.string": { name: "f" }}))).toBeNull();
  });
  test("currency field with explicit @currency only uses default locale", () => {
    expect(currencyMetaFor(loadField({ "field.currency": { name: "f", "@currency": "GBP" }})))
      .toEqual({ currency: "GBP", locale: "en-US" });
  });
});

describe("labelFor", () => {
  test("uses @label attr on view child if present", () => {
    const f = loadField({ "field.string": { name: "firstName",
      children: [{ "view.text": { "@label": "First Name" }}]
    }});
    expect(labelFor(f)).toBe("First Name");
  });
  test("falls back to humanized field name", () => {
    expect(labelFor(loadField({ "field.string": { name: "firstName" }})))
      .toBe("First Name");
  });
  test("PascalCase-style single word is capitalized", () => {
    expect(labelFor(loadField({ "field.string": { name: "email" }})))
      .toBe("Email");
  });
  test("multi-word camelCase → space-separated Title Case", () => {
    expect(labelFor(loadField({ "field.string": { name: "lastName" }})))
      .toBe("Last Name");
  });
});

import { describe, test, expect } from "bun:test";
import type { MetaField } from "@metaobjectsdev/metadata";
import { MetaDataLoader, InMemorySource } from "@metaobjectsdev/metadata";
import {
  inferViewKind,
  zodTypeFor,
  currencyMetaFor,
  labelFor,
} from "../../src/templates/field-meta.js";

async function loadField(json: unknown): Promise<MetaField> {
  const result = await new MetaDataLoader().load([new InMemorySource(JSON.stringify({
    "metadata.root": { children: [
      { "object.entity": { name: "X", children: [json] }}
    ]}
  }))]);
  if (result.errors.length > 0) {
    throw new Error(result.errors.map((e) => e.message).join("\n"));
  }
  return result.root.objects()[0]!.ownFields()[0]!;
}

describe("inferViewKind", () => {
  test("string field → 'text'", async () => {
    expect(inferViewKind(await loadField({ "field.string": { name: "f" }}))).toBe("text");
  });
  test("boolean field → 'checkbox'", async () => {
    expect(inferViewKind(await loadField({ "field.boolean": { name: "f" }}))).toBe("checkbox");
  });
  test("int field → 'number'", async () => {
    expect(inferViewKind(await loadField({ "field.int": { name: "f" }}))).toBe("number");
  });
  test("currency field → 'currency'", async () => {
    expect(inferViewKind(await loadField({ "field.currency": { name: "f" }}))).toBe("currency");
  });
  test("date field → 'date'", async () => {
    expect(inferViewKind(await loadField({ "field.date": { name: "f" }}))).toBe("date");
  });
  test("time field → 'date'", async () => {
    expect(inferViewKind(await loadField({ "field.time": { name: "f" }}))).toBe("date");
  });
  test("timestamp field → 'date'", async () => {
    expect(inferViewKind(await loadField({ "field.timestamp": { name: "f" }}))).toBe("date");
  });
  test("long field → 'number'", async () => {
    expect(inferViewKind(await loadField({ "field.long": { name: "f" }}))).toBe("number");
  });
  test("double field → 'number'", async () => {
    expect(inferViewKind(await loadField({ "field.double": { name: "f" }}))).toBe("number");
  });
  test("unknown subtype falls back to 'text'", async () => {
    expect(inferViewKind(await loadField({ "field.string": { name: "f" }}))).toBe("text");
  });
  test("explicit view child overrides default", async () => {
    expect(inferViewKind(await loadField({
      "field.string": { name: "f",
        children: [{ "view.textarea": {}}]
      }
    }))).toBe("textarea");
  });
});

describe("zodTypeFor", () => {
  test("string → z.string()", async () => {
    expect(zodTypeFor(await loadField({ "field.string": { name: "f" }}))).toBe("z.string()");
  });
  test("int → z.number().int()", async () => {
    expect(zodTypeFor(await loadField({ "field.int": { name: "f" }}))).toBe("z.number().int()");
  });
  test("long → z.number().int()", async () => {
    expect(zodTypeFor(await loadField({ "field.long": { name: "f" }}))).toBe("z.number().int()");
  });
  test("currency → z.number().int() (same as int/long)", async () => {
    expect(zodTypeFor(await loadField({ "field.currency": { name: "f" }}))).toBe("z.number().int()");
  });
  test("boolean → z.boolean()", async () => {
    expect(zodTypeFor(await loadField({ "field.boolean": { name: "f" }}))).toBe("z.boolean()");
  });
  test("double → z.number()", async () => {
    expect(zodTypeFor(await loadField({ "field.double": { name: "f" }}))).toBe("z.number()");
  });
  test("date → z.string() (ISO format)", async () => {
    expect(zodTypeFor(await loadField({ "field.date": { name: "f" }}))).toBe("z.string()");
  });
  test("timestamp → z.string() (ISO format)", async () => {
    expect(zodTypeFor(await loadField({ "field.timestamp": { name: "f" }}))).toBe("z.string()");
  });
});

describe("currencyMetaFor", () => {
  test("currency field with @currency='EUR' and view@locale='de-DE'", async () => {
    const f = await loadField({ "field.currency": { name: "f", "@currency": "EUR",
      children: [{ "view.currency": { "@locale": "de-DE" }}]
    }});
    expect(currencyMetaFor(f)).toEqual({ currency: "EUR", locale: "de-DE" });
  });
  test("currency field with no attrs → USD/en-US defaults", async () => {
    expect(currencyMetaFor(await loadField({ "field.currency": { name: "f" }})))
      .toEqual({ currency: "USD", locale: "en-US" });
  });
  test("non-currency field → null", async () => {
    expect(currencyMetaFor(await loadField({ "field.string": { name: "f" }}))).toBeNull();
  });
  test("currency field with explicit @currency only uses default locale", async () => {
    expect(currencyMetaFor(await loadField({ "field.currency": { name: "f", "@currency": "GBP" }})))
      .toEqual({ currency: "GBP", locale: "en-US" });
  });
});

describe("labelFor", () => {
  test("uses @label attr on view child if present", async () => {
    const f = await loadField({ "field.string": { name: "firstName",
      children: [{ "view.text": { "@label": "First Name" }}]
    }});
    expect(labelFor(f)).toBe("First Name");
  });
  test("falls back to humanized field name", async () => {
    expect(labelFor(await loadField({ "field.string": { name: "firstName" }})))
      .toBe("First Name");
  });
  test("PascalCase-style single word is capitalized", async () => {
    expect(labelFor(await loadField({ "field.string": { name: "email" }})))
      .toBe("Email");
  });
  test("multi-word camelCase → space-separated Title Case", async () => {
    expect(labelFor(await loadField({ "field.string": { name: "lastName" }})))
      .toBe("Last Name");
  });
});

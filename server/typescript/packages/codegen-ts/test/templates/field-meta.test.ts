import { describe, test, expect } from "bun:test";
import type { MetaField } from "@metaobjectsdev/metadata";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import {
  inferViewKind,
  zodTypeFor,
  currencyMetaFor,
  labelFor,
} from "../../src/templates/field-meta.js";
import { VIEW_CONTEXT_FORM, VIEW_CONTEXT_GRID } from "../../src/view-context.js";

async function loadField(json: unknown): Promise<MetaField> {
  const result = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify({
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
    expect(inferViewKind(await loadField({ "field.string": { name: "f" }}), VIEW_CONTEXT_FORM)).toBe("text");
  });
  test("boolean field → 'checkbox'", async () => {
    expect(inferViewKind(await loadField({ "field.boolean": { name: "f" }}), VIEW_CONTEXT_FORM)).toBe("checkbox");
  });
  test("int field → 'number'", async () => {
    expect(inferViewKind(await loadField({ "field.int": { name: "f" }}), VIEW_CONTEXT_FORM)).toBe("number");
  });
  test("currency field → 'currency'", async () => {
    expect(inferViewKind(await loadField({ "field.currency": { name: "f" }}), VIEW_CONTEXT_FORM)).toBe("currency");
  });
  test("date field → 'date'", async () => {
    expect(inferViewKind(await loadField({ "field.date": { name: "f" }}), VIEW_CONTEXT_FORM)).toBe("date");
  });
  test("time field → 'date'", async () => {
    expect(inferViewKind(await loadField({ "field.time": { name: "f" }}), VIEW_CONTEXT_FORM)).toBe("date");
  });
  test("timestamp field → 'date'", async () => {
    expect(inferViewKind(await loadField({ "field.timestamp": { name: "f" }}), VIEW_CONTEXT_FORM)).toBe("date");
  });
  test("long field → 'number'", async () => {
    expect(inferViewKind(await loadField({ "field.long": { name: "f" }}), VIEW_CONTEXT_FORM)).toBe("number");
  });
  test("double field → 'number'", async () => {
    expect(inferViewKind(await loadField({ "field.double": { name: "f" }}), VIEW_CONTEXT_FORM)).toBe("number");
  });
  test("unknown subtype falls back to 'text'", async () => {
    expect(inferViewKind(await loadField({ "field.string": { name: "f" }}), VIEW_CONTEXT_FORM)).toBe("text");
  });
  test("explicit view child overrides default", async () => {
    expect(inferViewKind(await loadField({
      "field.string": { name: "f",
        children: [{ "view.textarea": {}}]
      }
    }), VIEW_CONTEXT_FORM)).toBe("textarea");
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
  test("enum field with @values → z.enum([...]) form", async () => {
    const result = zodTypeFor(await loadField({
      "field.enum": { name: "status", "@values": ["DRAFT", "PUBLISHED", "ARCHIVED"] }
    }));
    expect(result).toBe('z.enum(["DRAFT", "PUBLISHED", "ARCHIVED"])');
  });
});

describe("currencyMetaFor", () => {
  test("currency field with @currency='EUR' and view@locale='de-DE'", async () => {
    const f = await loadField({ "field.currency": { name: "f", "@currency": "EUR",
      children: [{ "view.currency": { "@locale": "de-DE" }}]
    }});
    expect(currencyMetaFor(f, VIEW_CONTEXT_FORM)).toEqual({ currency: "EUR", locale: "de-DE" });
  });
  test("currency field with no attrs → USD/en-US defaults", async () => {
    expect(currencyMetaFor(await loadField({ "field.currency": { name: "f" }}), VIEW_CONTEXT_FORM))
      .toEqual({ currency: "USD", locale: "en-US" });
  });
  test("non-currency field → null", async () => {
    expect(currencyMetaFor(await loadField({ "field.string": { name: "f" }}), VIEW_CONTEXT_FORM)).toBeNull();
  });
  test("currency field with explicit @currency only uses default locale", async () => {
    expect(currencyMetaFor(await loadField({ "field.currency": { name: "f", "@currency": "GBP" }}), VIEW_CONTEXT_FORM))
      .toEqual({ currency: "GBP", locale: "en-US" });
  });
});

describe("labelFor", () => {
  // Was: `@label` on the view, expecting "First Name" — VACUOUS twice over. `@label` is
  // registered by no provider (#353, so the override branch could never fire), and
  // humanize("firstName") is ALSO "First Name", so the assertion passed on the fallback
  // whatever the override did. The registered attr is `@title`, and the expected value is
  // now one humanize cannot produce.
  test("uses @title attr on the view child if present", async () => {
    const f = await loadField({ "field.string": { name: "firstName",
      children: [{ "view.text": { "@title": "Given name" }}]
    }});
    expect(labelFor(f, VIEW_CONTEXT_FORM)).toBe("Given name");
  });
  test("falls back to humanized field name", async () => {
    expect(labelFor(await loadField({ "field.string": { name: "firstName" }}), VIEW_CONTEXT_FORM))
      .toBe("First Name");
  });
  test("PascalCase-style single word is capitalized", async () => {
    expect(labelFor(await loadField({ "field.string": { name: "email" }}), VIEW_CONTEXT_FORM))
      .toBe("Email");
  });
  test("multi-word camelCase → space-separated Title Case", async () => {
    expect(labelFor(await loadField({ "field.string": { name: "lastName" }}), VIEW_CONTEXT_FORM))
      .toBe("Last Name");
  });
});

// ---------------------------------------------------------------------------
// #356 — the surface, not the declaration order, decides which view is read.
// ---------------------------------------------------------------------------

describe("#356 multi-view selection", () => {
  /** The issue's repro shape: an enum declaring a form control and a grid cell. */
  const twoViews = (first: unknown, second: unknown) => ({
    "field.enum": {
      name: "outcome",
      "@values": ["PASS", "FAIL"],
      children: [first, second],
    },
  });
  const FORM_VIEW = { "view.dropdown": { name: "form", "@title": "Outcome control" } };
  const GRID_VIEW = { "view.text": { name: "grid", "@title": "Result" } };

  test("inferViewKind reads the view named for its own surface", async () => {
    const f = await loadField(twoViews(FORM_VIEW, GRID_VIEW));
    expect(inferViewKind(f, VIEW_CONTEXT_FORM)).toBe("dropdown");
    expect(inferViewKind(f, VIEW_CONTEXT_GRID)).toBe("text");
  });

  test("swapping the two declarations changes nothing", async () => {
    // The whole defect: two lines of JSON reordered, no semantic change, and the
    // generated form lost its <select>. Both orderings must agree, per surface.
    const declared = await loadField(twoViews(FORM_VIEW, GRID_VIEW));
    const swapped = await loadField(twoViews(GRID_VIEW, FORM_VIEW));
    for (const ctx of [VIEW_CONTEXT_FORM, VIEW_CONTEXT_GRID]) {
      expect(inferViewKind(swapped, ctx)).toBe(inferViewKind(declared, ctx));
      expect(labelFor(swapped, ctx)).toBe(labelFor(declared, ctx));
    }
  });

  test("labelFor takes @title from its own surface's view", async () => {
    const f = await loadField(twoViews(FORM_VIEW, GRID_VIEW));
    expect(labelFor(f, VIEW_CONTEXT_FORM)).toBe("Outcome control");
    expect(labelFor(f, VIEW_CONTEXT_GRID)).toBe("Result");
  });

  test("a currency field resolves @locale from its own surface's view", async () => {
    const f = await loadField({ "field.currency": { name: "price", "@currency": "EUR",
      children: [
        { "view.currency": { name: "form", "@locale": "de-DE" } },
        { "view.currency": { name: "grid", "@locale": "fr-FR" } },
      ],
    }});
    expect(currencyMetaFor(f, VIEW_CONTEXT_FORM)).toEqual({ currency: "EUR", locale: "de-DE" });
    expect(currencyMetaFor(f, VIEW_CONTEXT_GRID)).toEqual({ currency: "EUR", locale: "fr-FR" });
  });

  test("a surface with no currency view of its own keeps the field's authored @locale", async () => {
    // Pre-#356 behaviour, retained: an authored @locale anywhere on the field beats
    // the en-US default rather than being discarded.
    const f = await loadField({ "field.currency": { name: "price", "@currency": "EUR",
      children: [
        { "view.text": { name: "form" } },
        { "view.currency": { name: "grid", "@locale": "fr-FR" } },
      ],
    }});
    expect(currencyMetaFor(f, VIEW_CONTEXT_FORM)).toEqual({ currency: "EUR", locale: "fr-FR" });
  });

  test("several views, none named for the surface → throws naming field, views and surface", async () => {
    const f = await loadField(twoViews(
      { "view.text": { name: "compact" } },
      { "view.textarea": { name: "detail" } },
    ));
    expect(() => inferViewKind(f, VIEW_CONTEXT_FORM)).toThrow(/declares 2 views/);
    expect(() => inferViewKind(f, VIEW_CONTEXT_FORM)).toThrow(/X\.outcome/);
    expect(() => inferViewKind(f, VIEW_CONTEXT_FORM)).toThrow(/none is named "form"/);
  });
});

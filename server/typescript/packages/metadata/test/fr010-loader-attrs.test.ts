// FR-010 metamodel attrs — cross-port parity.
//
// Registers the FR-010 field-teaching + prompt-presentation vocabulary in the TS
// loader, matching the Java pilot / C# port:
//   - @promptStyle  : closed enum (guide|inline|exampleOnly) on template.output ONLY,
//                     enforced via allowedValues like @format. Default "guide".
//   - @example      : free-text string on any field (commonFieldAttrs).
//   - @instruction  : free-text string on any field (commonFieldAttrs).
//   - @enumAlias    : properties (map) on field.enum — off-vocab → canonical member.
//   - @enumDoc      : properties (map) on field.enum — member → human doc.

import { describe, it, expect } from "bun:test";
import { MetaDataLoader } from "../src/loader/meta-data-loader.js";
import { InMemoryStringSource } from "../src/loader/meta-data-source.js";
import { composeRegistry } from "../src/provider.js";
import { coreProviders } from "../src/core-types.js";
import { MetaObject } from "../src/core/object/meta-object.js";
import { MetaField } from "../src/core/field/meta-field.js";
import {
  TYPE_FIELD,
  TYPE_TEMPLATE,
  TEMPLATE_SUBTYPE_OUTPUT,
  TEMPLATE_SUBTYPE_PROMPT,
  TEMPLATE_ATTR_PROMPT_STYLE,
  PROMPT_STYLE_GUIDE,
  PROMPT_STYLE_INLINE,
  PROMPT_STYLE_EXAMPLE_ONLY,
  PROMPT_STYLE_DEFAULT,
  FIELD_SUBTYPE_ENUM,
  FIELD_SUBTYPE_STRING,
  FIELD_ATTR_ENUM_ALIAS,
  FIELD_ATTR_ENUM_DOC,
  FIELD_ATTR_EXAMPLE,
  FIELD_ATTR_INSTRUCTION,
  ATTR_SUBTYPE_STRING,
  ATTR_SUBTYPE_PROPERTIES,
} from "../src/index.js";

async function load(doc: unknown) {
  const loader = new MetaDataLoader();
  return loader.load([new InMemoryStringSource(JSON.stringify(doc), { id: "meta.ai.json" })]);
}

function registry() {
  return composeRegistry(coreProviders);
}

function codes(errors: readonly unknown[]): (string | undefined)[] {
  return errors.map((e) => (e as { code?: string }).code);
}

// ---------------------------------------------------------------------------
// @promptStyle — registered on template.output, closed enum, default guide.
// ---------------------------------------------------------------------------

describe("FR-010 @promptStyle — template.output", () => {
  it("is registered as a closed enum with default 'guide'", () => {
    const def = registry().find(TYPE_TEMPLATE, TEMPLATE_SUBTYPE_OUTPUT);
    expect(def).toBeDefined();
    const ps = def!.attributes.find((a) => a.name === TEMPLATE_ATTR_PROMPT_STYLE);
    expect(ps).toBeDefined();
    expect(ps!.required).toBe(false);
    expect(ps!.default).toBe(PROMPT_STYLE_DEFAULT);
    expect(new Set(ps!.allowedValues)).toEqual(
      new Set([PROMPT_STYLE_GUIDE, PROMPT_STYLE_INLINE, PROMPT_STYLE_EXAMPLE_ONLY]),
    );
  });

  it("is NOT carried by template.prompt (the prompt fragment is an output concern)", () => {
    const def = registry().find(TYPE_TEMPLATE, TEMPLATE_SUBTYPE_PROMPT);
    expect(def).toBeDefined();
    expect(def!.attributes.map((a) => a.name)).not.toContain(TEMPLATE_ATTR_PROMPT_STYLE);
  });

  it("loads template.output with a valid @promptStyle", async () => {
    const { root, errors } = await load({
      "metadata.root": {
        package: "acme::ai",
        children: [
          {
            "object.value": {
              name: "AnswerPayload",
              children: [{ "field.string": { name: "text" } }],
            },
          },
          {
            "template.output": {
              name: "answer",
              "@payloadRef": "AnswerPayload",
              "@textRef": "ai/answer",
              "@format": "json",
              "@promptStyle": "inline",
            },
          },
        ],
      },
    });
    expect(errors).toHaveLength(0);
    const tmpl = root
      .ownChildren()
      .find((c) => c.type === TYPE_TEMPLATE && c.subType === TEMPLATE_SUBTYPE_OUTPUT);
    expect(tmpl).toBeDefined();
    expect(tmpl!.ownAttr(TEMPLATE_ATTR_PROMPT_STYLE)).toBe(PROMPT_STYLE_INLINE);
  });

  it("emits ERR_BAD_ATTR_VALUE for a bad @promptStyle value", async () => {
    const { errors } = await load({
      "metadata.root": {
        package: "acme::ai",
        children: [
          {
            "object.value": {
              name: "AnswerPayload",
              children: [{ "field.string": { name: "text" } }],
            },
          },
          {
            "template.output": {
              name: "answer",
              "@payloadRef": "AnswerPayload",
              "@textRef": "ai/answer",
              "@format": "json",
              "@promptStyle": "bogus",
            },
          },
        ],
      },
    });
    const err = errors.find(
      (e) =>
        (e as { code?: string }).code === "ERR_BAD_ATTR_VALUE" &&
        (e as { message?: string }).message?.includes("promptStyle"),
    );
    expect(err).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// @enumAlias / @enumDoc — properties maps on field.enum.
// @example / @instruction — strings on any field.
// ---------------------------------------------------------------------------

describe("FR-010 field-teaching attrs — registration", () => {
  it("registers @enumAlias / @enumDoc (properties) + @example / @instruction (string) on field.enum", () => {
    const def = registry().find(TYPE_FIELD, FIELD_SUBTYPE_ENUM);
    expect(def).toBeDefined();
    const byName = new Map(def!.attributes.map((a) => [a.name, a]));
    expect(byName.get(FIELD_ATTR_ENUM_ALIAS)?.valueType).toBe(ATTR_SUBTYPE_PROPERTIES);
    expect(byName.get(FIELD_ATTR_ENUM_DOC)?.valueType).toBe(ATTR_SUBTYPE_PROPERTIES);
    expect(byName.get(FIELD_ATTR_EXAMPLE)?.valueType).toBe(ATTR_SUBTYPE_STRING);
    expect(byName.get(FIELD_ATTR_INSTRUCTION)?.valueType).toBe(ATTR_SUBTYPE_STRING);
  });

  it("registers @example / @instruction on a plain string field (they live on commonFieldAttrs)", () => {
    const def = registry().find(TYPE_FIELD, FIELD_SUBTYPE_STRING);
    expect(def).toBeDefined();
    const names = new Set(def!.attributes.map((a) => a.name));
    expect(names).toContain(FIELD_ATTR_EXAMPLE);
    expect(names).toContain(FIELD_ATTR_INSTRUCTION);
  });

  it("does NOT register @enumAlias / @enumDoc on a non-enum field", () => {
    const def = registry().find(TYPE_FIELD, FIELD_SUBTYPE_STRING);
    const names = new Set(def!.attributes.map((a) => a.name));
    expect(names).not.toContain(FIELD_ATTR_ENUM_ALIAS);
    expect(names).not.toContain(FIELD_ATTR_ENUM_DOC);
  });
});

describe("FR-010 field-teaching attrs — loading + round-trip", () => {
  it("loads a field.enum with @enumAlias / @enumDoc / @example / @instruction", async () => {
    const { root, errors } = await load({
      "metadata.root": {
        package: "acme::ai",
        children: [
          {
            "object.value": {
              name: "AnswerPayload",
              children: [
                {
                  "field.enum": {
                    name: "confidence",
                    "@values": ["HIGH", "LOW"],
                    "@enumAlias": { hi: "HIGH", lo: "LOW" },
                    "@enumDoc": { HIGH: "Directly supported.", LOW: "A guess." },
                    "@example": "HIGH",
                    "@instruction": "Pick one.",
                  },
                },
              ],
            },
          },
        ],
      },
    });
    expect(errors).toHaveLength(0);

    const obj = root.ownChildren().find((c) => c.name === "AnswerPayload") as MetaObject;
    const field = obj.findField("confidence");
    expect(field).toBeInstanceOf(MetaField);
    expect(field!.subType).toBe(FIELD_SUBTYPE_ENUM);

    const alias = field!.ownAttr(FIELD_ATTR_ENUM_ALIAS) as Record<string, unknown>;
    expect(alias.hi).toBe("HIGH");
    expect(alias.lo).toBe("LOW");

    const doc = field!.ownAttr(FIELD_ATTR_ENUM_DOC) as Record<string, unknown>;
    expect(doc.HIGH).toBe("Directly supported.");
    expect(doc.LOW).toBe("A guess.");

    expect(field!.ownAttr(FIELD_ATTR_EXAMPLE)).toBe("HIGH");
    expect(field!.ownAttr(FIELD_ATTR_INSTRUCTION)).toBe("Pick one.");
  });

  it("emits ERR_BAD_ATTR_VALUE when @enumAlias is not a map", async () => {
    const { errors } = await load({
      "metadata.root": {
        package: "acme::ai",
        children: [
          {
            "object.value": {
              name: "AnswerPayload",
              children: [
                {
                  "field.enum": {
                    name: "confidence",
                    "@values": ["HIGH", "LOW"],
                    "@enumAlias": "not-a-map",
                  },
                },
              ],
            },
          },
        ],
      },
    });
    const err = errors.find(
      (e) =>
        (e as { code?: string }).code === "ERR_BAD_ATTR_VALUE" &&
        (e as { message?: string }).message?.includes("enumAlias"),
    );
    expect(err).toBeDefined();
    expect(codes(errors)).toContain("ERR_BAD_ATTR_VALUE");
  });
});

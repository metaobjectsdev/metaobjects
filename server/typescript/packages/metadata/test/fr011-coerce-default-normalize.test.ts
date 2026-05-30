// FR-011 metamodel attrs — cross-port parity (recover hardening).
//
// Registers the FR-011 enum-recover vocabulary in the TS loader:
//   - @coerceDefault : string member symbol on field.enum ONLY. Must be one of
//                      the field's @values (loader-validated → ERR_BAD_ATTR_VALUE).
//                      Drives the tolerant recover present-but-garbage fallback.
//   - @normalize     : closed enum (none|collapse|strip) on field.enum (per-field)
//                      AND object.value (default for its enum fields). Default "strip".
//
// Mirrors fr010-loader-attrs.test.ts EXACTLY — same load/registry/codes helpers.

import { describe, it, expect } from "bun:test";
import { MetaDataLoader } from "../src/loader/meta-data-loader.js";
import { InMemoryStringSource } from "../src/loader/meta-data-source.js";
import { composeRegistry } from "../src/provider.js";
import { coreProviders } from "../src/core-types.js";
import { MetaObject } from "../src/core/object/meta-object.js";
import { MetaField } from "../src/core/field/meta-field.js";
import {
  TYPE_FIELD,
  TYPE_OBJECT,
  OBJECT_SUBTYPE_VALUE,
  FIELD_SUBTYPE_ENUM,
  FIELD_SUBTYPE_STRING,
  FIELD_ATTR_COERCE_DEFAULT,
  FIELD_ATTR_NORMALIZE,
  NORMALIZE_MODES,
  NORMALIZE_DEFAULT,
  ATTR_SUBTYPE_STRING,
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
// Registration — @coerceDefault + @normalize on field.enum; @normalize on object.value.
// ---------------------------------------------------------------------------

describe("FR-011 @coerceDefault / @normalize — registration", () => {
  it("registers @coerceDefault (string) + @normalize (closed enum, default strip) on field.enum", () => {
    const def = registry().find(TYPE_FIELD, FIELD_SUBTYPE_ENUM);
    expect(def).toBeDefined();
    const byName = new Map(def!.attributes.map((a) => [a.name, a]));

    const cd = byName.get(FIELD_ATTR_COERCE_DEFAULT);
    expect(cd).toBeDefined();
    expect(cd!.valueType).toBe(ATTR_SUBTYPE_STRING);
    expect(cd!.required).toBe(false);

    const norm = byName.get(FIELD_ATTR_NORMALIZE);
    expect(norm).toBeDefined();
    expect(norm!.valueType).toBe(ATTR_SUBTYPE_STRING);
    expect(norm!.required).toBe(false);
    expect(norm!.default).toBe(NORMALIZE_DEFAULT);
    expect(new Set(norm!.allowedValues)).toEqual(new Set(NORMALIZE_MODES));
  });

  it("registers @normalize (closed enum) on object.value as the object-level default carrier", () => {
    const def = registry().find(TYPE_OBJECT, OBJECT_SUBTYPE_VALUE);
    expect(def).toBeDefined();
    const norm = def!.attributes.find((a) => a.name === FIELD_ATTR_NORMALIZE);
    expect(norm).toBeDefined();
    expect(norm!.valueType).toBe(ATTR_SUBTYPE_STRING);
    expect(norm!.required).toBe(false);
    expect(new Set(norm!.allowedValues)).toEqual(new Set(NORMALIZE_MODES));
  });

  it("does NOT register @coerceDefault on a non-enum field", () => {
    const def = registry().find(TYPE_FIELD, FIELD_SUBTYPE_STRING);
    const names = new Set(def!.attributes.map((a) => a.name));
    expect(names).not.toContain(FIELD_ATTR_COERCE_DEFAULT);
  });
});

// ---------------------------------------------------------------------------
// Loading + round-trip + resolution (field-level else owning object).
// ---------------------------------------------------------------------------

describe("FR-011 @coerceDefault / @normalize — loading + round-trip", () => {
  it("loads object.value @normalize=strip + field.enum @coerceDefault=LOW; resolves @normalize", async () => {
    const { root, errors } = await load({
      "metadata.root": {
        package: "acme::ai",
        children: [
          {
            "object.value": {
              name: "AnswerPayload",
              "@normalize": "strip",
              children: [
                {
                  "field.enum": {
                    name: "confidence",
                    "@values": ["HIGH", "OK", "LOW"],
                    "@coerceDefault": "LOW",
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
    expect(obj.subType).toBe(OBJECT_SUBTYPE_VALUE);
    expect(obj.ownAttr(FIELD_ATTR_NORMALIZE)).toBe("strip");

    const field = obj.findField("confidence");
    expect(field).toBeInstanceOf(MetaField);
    expect(field!.subType).toBe(FIELD_SUBTYPE_ENUM);
    expect(field!.ownAttr(FIELD_ATTR_COERCE_DEFAULT)).toBe("LOW");

    // Resolved @normalize: field-level if present, else the owning object's.
    const resolved = field!.ownAttr(FIELD_ATTR_NORMALIZE) ?? obj.ownAttr(FIELD_ATTR_NORMALIZE);
    expect(resolved).toBe("strip");
  });

  it("emits ERR_BAD_ATTR_VALUE when @coerceDefault is not one of @values", async () => {
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
                    "@values": ["HIGH", "OK", "LOW"],
                    "@coerceDefault": "BOGUS",
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
        (e as { message?: string }).message?.includes("coerceDefault"),
    );
    expect(err).toBeDefined();
    expect(codes(errors)).toContain("ERR_BAD_ATTR_VALUE");
  });

  it("emits ERR_BAD_ATTR_VALUE for a bad @normalize value on field.enum", async () => {
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
                    "@values": ["HIGH", "OK", "LOW"],
                    "@normalize": "nope",
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
        (e as { message?: string }).message?.includes("normalize"),
    );
    expect(err).toBeDefined();
    expect(codes(errors)).toContain("ERR_BAD_ATTR_VALUE");
  });

  it("emits ERR_BAD_ATTR_VALUE for a bad @normalize value on object.value", async () => {
    const { errors } = await load({
      "metadata.root": {
        package: "acme::ai",
        children: [
          {
            "object.value": {
              name: "AnswerPayload",
              "@normalize": "nope",
              children: [{ "field.string": { name: "text" } }],
            },
          },
        ],
      },
    });
    const err = errors.find(
      (e) =>
        (e as { code?: string }).code === "ERR_BAD_ATTR_VALUE" &&
        (e as { message?: string }).message?.includes("normalize"),
    );
    expect(err).toBeDefined();
  });
});

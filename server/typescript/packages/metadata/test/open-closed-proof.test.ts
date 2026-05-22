// Open-Closed proof — the executable definition of done for the typed-node
// refactor. Registering a brand-new attr subtype (and field subtype) must cost
// ONLY a new class + a registration line: ZERO edits to any central file (no
// DataType union arm, no convertToDataType case, no attr-schema subtype-set, no
// AttrValue union arm, no ATTR_DATA_TYPE / FIELD_DATA_TYPE map entry).
//
// The registration mechanism (post-Task-4): attr value classes self-register via
// the dependency-free leaf `src/attr-class-map.ts` (`registerAttrClass(subType,
// ctor)`), which the parser/serializer/setAttr read back through. A new subtype
// therefore needs (a) one `registerAttrClass(...)` line so the value behavior
// resolves to the new class, and (b) one `registry.register({...})` def so the
// loader can find the subtype's TypeDefinition + factory. Both lines live here
// (or in a consumer's provider) — never in a central metadata file.
//
// HONEST surface notes (see the per-test comments + the trailer at end):
//   * Attr value class via the `attr.<subType>` child-node form: TRUE zero
//     central edits — the subtype is fused into the wrapper key and resolved
//     straight from the registry factory, so `validateValue`/`coerce` dispatch
//     to the new class with no central typing involved.
//   * Field subtype: registering a `field.<subType>` def is likewise zero edits
//     to FIELD_SUBTYPES or the co-located FIELD_DATA_TYPE map — the def carries
//     its own `dataType`, applied via `node.setDataType(...)` in the factory.
//   * The ONE central typing surface is `AttrSchema.valueType: AttrSubType`: to
//     DECLARE `@fizz` on an owner's schema (so the loader's attr-schema pass
//     runs `FizzAttr.validateValue` during load), the closed `AttrSubType` union
//     would need `"fizz"` admitted. That is a one-token edit to a closed-set
//     constant — documented honestly below rather than papered over.

import { describe, it, expect } from "bun:test";
import { TypeId, TypeRegistry, type AttrSchema } from "../src/registry.js";
import { registerCoreTypes } from "../src/core-types.js";
import { MetaAttr, type ValueError } from "../src/core/attr/meta-attr.js";
import { MetaField } from "../src/core/field/meta-field.js";
import { registerAttrClass } from "../src/attr-class-map.js";
import { MetaDataLoader } from "../src/loader/meta-data-loader.js";
import { InMemorySource } from "../src/loader/meta-data-source.js";
import { canonicalSerialize } from "../src/serializer-json.js";
import { TYPE_ATTR, TYPE_FIELD, TYPE_OBJECT, type AttrSubType } from "../src/index.js";
import { DATA_TYPE_STRING, type DataType } from "../src/data-type.js";
import type { AttrValue } from "../src/shared/meta-data.js";

// ===========================================================================
// The ENTIRE cost of a new value-shaped attr subtype: one class.
// FizzAttr overrides only what differs from the base MetaAttr — its DataType,
// how it coerces a raw value, and how it validates a stored value. A 'fizz'
// value must be the literal string "fizz" or "buzz".
// ===========================================================================
const ATTR_SUBTYPE_FIZZ = "fizz"; // throwaway test subtype — OK as a literal
const FIELD_SUBTYPE_FIZZ = "fizz";

class FizzAttr extends MetaAttr {
  override get dataType(): DataType {
    return DATA_TYPE_STRING;
  }
  override coerce(raw: unknown): AttrValue {
    return String(raw);
  }
  override validateValue(value: AttrValue): ValueError[] {
    return value === "fizz" || value === "buzz"
      ? []
      : [{ message: `attribute '@${this.name}' must be 'fizz' or 'buzz'` }];
  }
}

// The ENTIRE cost of a new field subtype: one class. FizzField inherits all
// MetaField behavior; its DataType comes from the registered def below (applied
// via setDataType in the factory), so it need not even override dataType.
class FizzField extends MetaField {}

// --- registration line #1: the attr-class-map self-registration seam --------
// In a real provider this lives at module load inside the FizzAttr file (the
// same `registerAttrClass(ATTR_SUBTYPE_X, XAttr)` call meta-attr-filter.ts etc.
// make). Running it here (idempotent — Map.set) wires `@fizz` value behavior to
// FizzAttr for the inline `@fizz` materialization path (setAttr → attrClassFor).
registerAttrClass(ATTR_SUBTYPE_FIZZ, FizzAttr);

/** A fresh registry with the core types plus the two throwaway fizz defs. The
 *  two `registry.register` calls are the ONLY registration surface — no central
 *  file is touched. */
function registryWithFizz(extraFieldAttrs: AttrSchema[] = []): TypeRegistry {
  const registry = new TypeRegistry();
  registerCoreTypes(registry);

  // --- registration line #2: the attr.fizz TypeDefinition ------------------
  // The factory builds a FizzAttr; the def carries its own dataType. No edit to
  // ATTR_SUBTYPES, BASE_ATTR_DATA_TYPE, data-converter, or AttrValue.
  registry.register({
    typeId: new TypeId(TYPE_ATTR, ATTR_SUBTYPE_FIZZ),
    description: "throwaway fizz attr",
    factory: (id, name) => new FizzAttr(id, name),
    childRules: [],
    attributes: [],
    dataType: DATA_TYPE_STRING,
  });

  // --- registration line #3: the field.fizz TypeDefinition -----------------
  // The factory builds a FizzField; the def carries dataType, applied via
  // node.setDataType(...) inside the registry's def() factory. No edit to
  // FIELD_SUBTYPES or the co-located FIELD_DATA_TYPE map.
  registry.register({
    typeId: new TypeId(TYPE_FIELD, FIELD_SUBTYPE_FIZZ),
    description: "throwaway fizz field",
    factory: (id, name) => {
      const node = new FizzField(id, name);
      node.setDataType(DATA_TYPE_STRING);
      return node;
    },
    childRules: [],
    attributes: extraFieldAttrs,
    dataType: DATA_TYPE_STRING,
  });

  return registry;
}

describe("Open-Closed proof: a new subtype costs one class + one registration line", () => {
  it("loads, coerces, validates, and canonically serializes attr.fizz + field.fizz (TRUE zero central edits)", async () => {
    const registry = registryWithFizz();

    // `attr.fizz` is authored as a child node: { "attr.fizz": { name, value } }.
    // This is the genuinely zero-central-edit path — the subtype is fused into
    // the wrapper key and resolved straight from the registry factory, so the
    // value coerces + validates via FizzAttr without any AttrSchema typing.
    const doc = JSON.stringify({
      "metadata.root": {
        package: "acme",
        children: [
          {
            "object.entity": {
              name: "Demo",
              children: [
                {
                  "field.fizz": {
                    name: "label",
                    children: [{ "attr.fizz": { name: "fizz", value: "buzz" } }],
                  },
                },
                { "identity.primary": { "@fields": ["label"] } },
              ],
            },
          },
        ],
      },
    });

    const loader = new MetaDataLoader({ registry, freeze: false });
    const { root, errors } = await loader.load([
      new InMemorySource(doc, { id: "demo.json", format: "json" }),
    ]);
    expect(errors).toEqual([]);

    // The field materialized as the new FizzField with the registered DataType.
    const obj = root.ownChildByTypeAndName(TYPE_OBJECT, "Demo")!;
    const field = obj.ownChildByTypeAndName(TYPE_FIELD, "label")! as FizzField;
    expect(field).toBeInstanceOf(FizzField);
    expect(field.subType).toBe(FIELD_SUBTYPE_FIZZ);
    expect(field.dataType).toBe(DATA_TYPE_STRING);

    // The @fizz attr materialized as a FizzAttr instance, coerced via the class.
    const fizzAttr = field.ownMetaAttr("fizz")!;
    expect(fizzAttr).toBeInstanceOf(FizzAttr);
    expect(fizzAttr.value).toBe("buzz");

    // The class's own validateValue is exercised end-to-end.
    expect(fizzAttr.validateValue("buzz")).toEqual([]);
    expect(fizzAttr.validateValue("fizz")).toEqual([]);
    expect(fizzAttr.validateValue("nope").length).toBeGreaterThan(0);

    // The class's own coerce stringifies a non-string raw value.
    expect(fizzAttr.coerce(42)).toBe("42");

    // Canonical serialize emits @fizz inline (D5) and the field.fizz wrapper —
    // the serializer is fully type-agnostic, reading type/subType + the value
    // map off the node, so a new subtype round-trips with no serializer edit.
    const json = canonicalSerialize(root);
    expect(json).toContain('"@fizz": "buzz"');
    expect(json).toContain('"field.fizz"');
  });

  it("rejects an invalid fizz value via the loader's attr-schema pass (one declared @fizz on the field schema)", async () => {
    // To make the loader's attr-schema pass invoke FizzAttr.validateValue during
    // load (rather than calling it directly), the owner field's schema must
    // DECLARE @fizz with valueType: "fizz". Functionally this is one AttrSchema
    // entry. The one honest CENTRAL typing surface: `AttrSchema.valueType` is
    // typed `AttrSubType` (a closed union of known attr subtypes), so a
    // production provider would add "fizz" to the ATTR_SUBTYPES const for this
    // line to typecheck. We localize that single narrowing here as
    // `ATTR_SUBTYPE_FIZZ as AttrSubType` — equivalent to a one-token edit to a
    // closed-set constant, NOT a structural central-file change.
    const fizzSchema: AttrSchema = {
      name: "fizz",
      valueType: ATTR_SUBTYPE_FIZZ as AttrSubType,
      required: false,
      description: "fizz or buzz",
    };
    const registry = registryWithFizz([fizzSchema]);

    // Inline @fizz on a field whose schema declares it → the parser resolves the
    // declared valueType "fizz", materializes a FizzAttr, and the attr-schema
    // pass runs FizzAttr.validateValue, surfacing ERR_BAD_ATTR_VALUE for "nope".
    const doc = JSON.stringify({
      "metadata.root": {
        package: "acme",
        children: [
          {
            "object.entity": {
              name: "Demo",
              children: [
                { "field.fizz": { name: "label", "@fizz": "nope" } },
                { "identity.primary": { "@fields": ["label"] } },
              ],
            },
          },
        ],
      },
    });

    const loader = new MetaDataLoader({ registry, freeze: false });
    const { errors } = await loader.load([
      new InMemorySource(doc, { id: "demo.json", format: "json" }),
    ]);
    expect(
      errors.some((e) => (e as { code?: string }).code === "ERR_BAD_ATTR_VALUE"),
    ).toBe(true);
  });

  it("accepts a valid declared @fizz value through the same pipeline", async () => {
    const fizzSchema: AttrSchema = {
      name: "fizz",
      valueType: ATTR_SUBTYPE_FIZZ as AttrSubType,
      required: false,
      description: "fizz or buzz",
    };
    const registry = registryWithFizz([fizzSchema]);
    const doc = JSON.stringify({
      "metadata.root": {
        package: "acme",
        children: [
          {
            "object.entity": {
              name: "Demo",
              children: [
                { "field.fizz": { name: "label", "@fizz": "fizz" } },
                { "identity.primary": { "@fields": ["label"] } },
              ],
            },
          },
        ],
      },
    });

    const loader = new MetaDataLoader({ registry, freeze: false });
    const { root, errors } = await loader.load([
      new InMemorySource(doc, { id: "demo.json", format: "json" }),
    ]);
    expect(errors).toEqual([]);

    const obj = root.ownChildByTypeAndName(TYPE_OBJECT, "Demo")!;
    const field = obj.ownChildByTypeAndName(TYPE_FIELD, "label")! as FizzField;
    const fizzAttr = field.ownMetaAttr("fizz")!;
    expect(fizzAttr).toBeInstanceOf(FizzAttr);
    expect(fizzAttr.value).toBe("fizz");
  });
});

// ===========================================================================
// Documented invariant — the property this refactor exists to create.
//
// Registering attr.fizz + field.fizz above required editing ZERO central files:
//   * NO arm added to the DataType union (data-type.ts).
//   * NO case added to convertToDataType (data-converter.ts).
//   * NO subtype-set edited in attr-schema-validate.ts (value-shape knowledge
//     lives on FizzAttr.validateValue).
//   * NO arm added to the AttrValue union (meta-data.ts).
//   * NO entry added to BASE_ATTR_DATA_TYPE (meta-attr.ts) or FIELD_DATA_TYPE
//     (meta-field.ts) — each def carries its own dataType.
//   * NO entry hard-coded in core-types.ts — the attr-class-map self-registration
//     seam (registerAttrClass) wires value behavior; the registry defs supply the
//     factories.
//
// The single HONEST central typing surface is `AttrSchema.valueType: AttrSubType`
// (a closed union): to DECLARE a new attr on an owner's schema typesafely, a
// production provider adds the subtype string to the ATTR_SUBTYPES const — a
// one-token edit to a closed-set constant, not a structural change. The attr's
// VALUE BEHAVIOR (dataType/coerce/validate) and the field subtype are fully
// described by their class + registration. THAT is Open-Closed.
// ===========================================================================

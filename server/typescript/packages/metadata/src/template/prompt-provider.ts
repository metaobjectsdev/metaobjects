// promptProvider — the prompt / AI + serialization MetaDataTypeProvider
// (FR-004/006/010/011). EXTENDS the core-registered field types with the
// AI-domain markers that are NOT core field properties:
//   - every field subtype: @xmlText (XML text-content extract), @example,
//     @instruction (FR-010 field-teaching prompt fragment);
//   - field.enum only: @enumAlias / @enumDoc / @coerceDefault / @normalize
//     (FR-010/FR-011 tolerant-extract overlays);
//   - object.value only: @normalize (the object-level default normalization mode
//     for its enum fields' tolerant extract).
//
// FR-033 S1-field-A re-homes the field-teaching + tolerant-extract attrs out of
// the core field definition (spec/metamodel/field.json) and object.value
// (object.json) into this concern provider — and renames the provider id from
// `metaobjects-template` to `metaobjects-prompt`. Pure ownership move: the same
// attrs land on the same subtypes, so the composed registry manifest stays
// byte-identical. Mirrors the dbProvider (db-provider.ts) extension pattern and
// Java's TemplateTypesMetaDataProvider field extension.

import type { MetaDataTypeProvider } from "../provider.js";
import type { AttrSchema, TypeRegistry } from "../registry.js";
import { TYPE_FIELD, TYPE_OBJECT } from "../shared/base-types.js";
import { FIELD_SUBTYPES, FIELD_SUBTYPE_ENUM } from "../core/field/field-constants.js";
import { OBJECT_SUBTYPE_VALUE } from "../core/object/object-constants.js";
import { ATTR_SUBTYPE_BOOLEAN } from "../core/attr/attr-constants.js";
import { FIELD_ATTR_XML_TEXT } from "./template-constants.js";
import {
  promptFieldAttrs,
  promptEnumAttrs,
  normalizeSchema,
} from "./prompt-schema.js";

/** `@xmlText` — when true, the field receives its element's XML text content during tolerant
 *  extract instead of a same-named child. On every field subtype. No effect for JSON. */
export const xmlTextSchema: AttrSchema = {
  name: FIELD_ATTR_XML_TEXT,
  valueType: ATTR_SUBTYPE_BOOLEAN,
  required: false,
  description:
    "When true, this field receives its element's XML TEXT CONTENT during tolerant extract " +
    "(JAXB @XmlValue / Jackson @JacksonXmlText / .NET [XmlText]) instead of a same-named child. " +
    "No effect for @format: json.",
};

export const promptProvider: MetaDataTypeProvider = {
  id: "metaobjects-prompt",
  dependencies: ["metaobjects-core-types"],
  description:
    "Prompt / AI + serialization domain — @xmlText / @example / @instruction field markers on every field subtype, the @enumAlias/@enumDoc/@coerceDefault/@normalize tolerant-extract overlays on field.enum, and the object-level @normalize default on object.value.",
  registerTypes(registry: TypeRegistry): void {
    for (const subType of FIELD_SUBTYPES) {
      const attributes: AttrSchema[] = [xmlTextSchema, ...promptFieldAttrs];
      // field.enum carries the FR-010/FR-011 tolerant-extract overlays.
      if (subType === FIELD_SUBTYPE_ENUM) attributes.push(...promptEnumAttrs);
      registry.extend(TYPE_FIELD, subType, { attributes });
    }
    // object.value — the object-level @normalize default for its enum fields.
    registry.extend(TYPE_OBJECT, OBJECT_SUBTYPE_VALUE, {
      attributes: [normalizeSchema],
    });
  },
};

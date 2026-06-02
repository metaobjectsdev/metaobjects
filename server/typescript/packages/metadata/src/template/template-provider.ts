// templateProvider — the template/output (serialization) MetaDataTypeProvider.
// Registers the @xmlText field marker (XML text-content extraction) by EXTENDING the
// core-registered field types. @xmlText is an output/extract concern, NOT a core field
// property, so it lives here — mirroring Java's TemplateTypesMetaDataProvider field
// extension and the dbProvider (db-provider.ts) pattern.

import type { MetaDataTypeProvider } from "../provider.js";
import type { AttrSchema, TypeRegistry } from "../registry.js";
import { TYPE_FIELD } from "../shared/base-types.js";
import { FIELD_SUBTYPES } from "../core/field/field-constants.js";
import { ATTR_SUBTYPE_BOOLEAN } from "../core/attr/attr-constants.js";
import { FIELD_ATTR_XML_TEXT } from "./template-constants.js";

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

export const templateProvider: MetaDataTypeProvider = {
  id: "metaobjects-template",
  dependencies: ["metaobjects-core-types"],
  description:
    "Template/output domain — @xmlText field marker for XML text-content extraction (template.output @format=xml).",
  registerTypes(registry: TypeRegistry): void {
    for (const subType of FIELD_SUBTYPES) {
      registry.extend(TYPE_FIELD, subType, { attributes: [xmlTextSchema] });
    }
  },
};

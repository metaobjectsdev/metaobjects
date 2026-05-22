// PropertiesAttr — attr subtype `properties`. Object-shaped value (a string
// bag / arbitrary JSON object). No desugar (identity); object validation.

import { MetaAttr, type ValueError, runtimeTypeName } from "./meta-attr.js";
import { type AttrValue } from "./meta-data.js";
import { DATA_TYPE_OBJECT, type DataType } from "../data-type.js";
import { registerAttrClass } from "../attr-class-map.js";
import { ATTR_SUBTYPE_PROPERTIES } from "../constants.js";

export class PropertiesAttr extends MetaAttr {
  override get dataType(): DataType {
    return DATA_TYPE_OBJECT;
  }

  override coerce(raw: unknown): AttrValue {
    return raw as AttrValue;
  }

  override validateValue(value: AttrValue): ValueError[] {
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? []
      : [{ message: `attribute '@${this.name}' must be of type 'properties' but got ${runtimeTypeName(value)}` }];
  }
}

registerAttrClass(ATTR_SUBTYPE_PROPERTIES, PropertiesAttr);

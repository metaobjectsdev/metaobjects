// StringArrayAttr — attr subtype `stringarray`. A bare string is the degenerate
// one-element authoring form (`"@fields": "id"`); coerce wraps it into a
// one-element array so the loaded tree always holds a real string[]. Moved here
// from parser-core.ts `normalizeStringArrayAttr`.

import { MetaAttr, type ValueError, runtimeTypeName } from "./meta-attr.js";
import { type AttrValue } from "../../shared/meta-data.js";
import { DATA_TYPE_STRING, type DataType } from "../../data-type.js";
import { registerAttrClass } from "../../attr-class-map.js";
import { ATTR_SUBTYPE_STRINGARRAY } from "./attr-constants.js";

export class StringArrayAttr extends MetaAttr {
  override get dataType(): DataType {
    return DATA_TYPE_STRING;
  }

  override coerce(raw: unknown): AttrValue {
    if (Array.isArray(raw)) return raw.map((el) => String(el));
    if (typeof raw === "string") return [raw];
    // Non-string scalar (number/boolean) → leave as-is so validateValue flags it.
    return raw as AttrValue;
  }

  override validateValue(value: AttrValue): ValueError[] {
    return Array.isArray(value) && value.every((el) => typeof el === "string")
      ? []
      : [{ message: `attribute '@${this.name}' must be a string[] but got ${runtimeTypeName(value)}` }];
  }
}

registerAttrClass(ATTR_SUBTYPE_STRINGARRAY, StringArrayAttr);

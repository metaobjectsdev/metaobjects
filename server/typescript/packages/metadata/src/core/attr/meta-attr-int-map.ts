// IntMapAttr — attr subtype `intMap`. Object-shaped value whose members must
// all be integers (e.g. field.enum's @intValueMap). No desugar; validates
// shape (object, not array) and every value's type (integer). A consumer's
// own semantic rules (key-set membership, uniqueness) are validated by that
// consumer, not here — mirrors how StringArrayAttr validates shape while
// field.enum's own content-rule pass validates its @values semantics.

import { MetaAttr, type ValueError, runtimeTypeName } from "./meta-attr.js";
import { type AttrValue } from "../../shared/meta-data.js";
import { DATA_TYPE_OBJECT, type DataType } from "../../data-type.js";
import { registerAttrClass } from "../../attr-class-map.js";
import { ATTR_SUBTYPE_INT_MAP } from "./attr-constants.js";

export class IntMapAttr extends MetaAttr {
  override get dataType(): DataType {
    return DATA_TYPE_OBJECT;
  }

  override coerce(raw: unknown): AttrValue {
    return raw as AttrValue;
  }

  override validateValue(value: AttrValue): ValueError[] {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return [{ message: `attribute '@${this.name}' must be of type 'intMap' but got ${runtimeTypeName(value)}` }];
    }
    const errors: ValueError[] = [];
    for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
      if (typeof member !== "number" || !Number.isInteger(member)) {
        errors.push({
          message: `attribute '@${this.name}' member '${key}' has value '${String(member)}' which is not an integer`,
        });
      }
    }
    return errors;
  }
}

registerAttrClass(ATTR_SUBTYPE_INT_MAP, IntMapAttr);

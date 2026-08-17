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

// 32-bit signed integer bounds (inclusive) — the eventual DB column for an
// int-backed enum is a 32-bit Postgres/SQLite `integer` (design doc D5).
const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

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
      } else if (member < INT32_MIN || member > INT32_MAX) {
        // The eventual DB column for an int-backed enum is a 32-bit Postgres/
        // SQLite `integer` (design doc D5; matches field.int's existing
        // 32-bit mapping in expected-schema.ts) — mirrors Java's
        // IntMapAttribute#setValueAsString bound check exactly (inclusive at
        // both ends) so a value that could never be persisted fails at load
        // time, not silently, on every port.
        errors.push({
          message: `attribute '@${this.name}' member '${key}' has value '${member}' which is outside the 32-bit signed integer range`,
        });
      }
    }
    return errors;
  }
}

registerAttrClass(ATTR_SUBTYPE_INT_MAP, IntMapAttr);

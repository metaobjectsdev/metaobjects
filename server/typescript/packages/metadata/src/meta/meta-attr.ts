// MetaAttr — concrete node class for type=attr nodes.
//
// Every attribute in the loaded model is a MetaAttr instance (inline @-syntax is
// parse-time sugar; see parser-core.ts). The base class owns value behavior —
// dataType / coerce / validateValue / desugar — resolved by this.subType.
// Subclasses (StringArrayAttr, FilterAttr, PropertiesAttr) override only what
// differs. Adding a new value-shaped attr subtype is one subclass + one
// registration line in core-types.ts (ATTR_CLASS_MAP) — zero central edits.

import { MetaData, type AttrValue } from "./meta-data.js";
import {
  type DataType,
  type DataTypeAware,
  DATA_TYPE_STRING,
  DATA_TYPE_INT,
  DATA_TYPE_LONG,
  DATA_TYPE_DOUBLE,
  DATA_TYPE_BOOLEAN,
} from "../data-type.js";
import { convertToDataType, toAttrValue } from "../data-converter.js";
import { registerFallbackAttrClass } from "../attr-class-map.js";
import { SUBTYPE_BASE } from "../shared/base-types.js";
import { RESERVED_KEY_VALUE } from "../shared/structural.js";
import {
  ATTR_SUBTYPE_STRING,
  ATTR_SUBTYPE_CLASS,
  ATTR_SUBTYPE_INT,
  ATTR_SUBTYPE_LONG,
  ATTR_SUBTYPE_DOUBLE,
  ATTR_SUBTYPE_BOOLEAN,
} from "../core/attr/attr-constants.js";

/** A value-level validation finding, surfaced by the attr-schema pass. */
export interface ValueError {
  message: string;
}

/** Base-subtype → DataType. Each MetaAttr subclass owns its own DataType: the
 *  base covers the scalar/string subtypes; object/array subtypes override
 *  `get dataType()`. This replaces the central ATTR_DATA_TYPE map. */
const BASE_ATTR_DATA_TYPE: Readonly<Record<string, DataType>> = {
  [SUBTYPE_BASE]: DATA_TYPE_STRING,
  [ATTR_SUBTYPE_STRING]: DATA_TYPE_STRING,
  [ATTR_SUBTYPE_CLASS]: DATA_TYPE_STRING,
  [ATTR_SUBTYPE_INT]: DATA_TYPE_INT,
  [ATTR_SUBTYPE_LONG]: DATA_TYPE_LONG,
  [ATTR_SUBTYPE_DOUBLE]: DATA_TYPE_DOUBLE,
  [ATTR_SUBTYPE_BOOLEAN]: DATA_TYPE_BOOLEAN,
};

export class MetaAttr extends MetaData implements DataTypeAware {
  /** This attribute's coerced value (stored on the instance under RESERVED_KEY_VALUE). */
  get value(): AttrValue | undefined {
    return this.ownAttr(RESERVED_KEY_VALUE);
  }

  /** The coarse value-type classification for this attribute's subtype. */
  get dataType(): DataType {
    return BASE_ATTR_DATA_TYPE[this.subType] ?? DATA_TYPE_STRING;
  }

  /**
   * Coerce a raw parsed value toward this attr's value shape. The base handles
   * the scalar subtypes (string / class / int / long / double / boolean) by
   * delegating to convertToDataType. Subclasses override for array/object shapes.
   *
   * SUBTYPE_BASE is the polymorphic/unconstrained marker (e.g. an `attr.base`
   * child node, or an untyped `@default`): the value is stored type-preserved,
   * never stringified — mirroring validateValue, which accepts any type for base.
   */
  coerce(raw: unknown): AttrValue {
    if (this.subType === SUBTYPE_BASE) {
      return toAttrValue(raw);
    }
    return convertToDataType(this.dataType, raw);
  }

  /**
   * Desugar a coerced value to its canonical stored form. Default identity;
   * FilterAttr overrides to normalize `{ field: value }` → `{ field: { op: value } }`.
   */
  desugar(value: AttrValue): AttrValue {
    return value;
  }

  /**
   * Validate a stored value against this attr's value shape. Returns [] when
   * valid. The base checks the scalar/string subtypes; subclasses override for
   * array/object shapes. Replaces the central valueMatchesType + subtype-sets.
   */
  validateValue(value: AttrValue): ValueError[] {
    const dt = this.dataType;
    if (dt === DATA_TYPE_STRING) {
      return typeof value === "string" ? [] : [this._typeError("string", value)];
    }
    if (dt === DATA_TYPE_INT || dt === DATA_TYPE_LONG || dt === DATA_TYPE_DOUBLE) {
      return typeof value === "number" ? [] : [this._typeError("number", value)];
    }
    if (dt === DATA_TYPE_BOOLEAN) {
      return typeof value === "boolean" ? [] : [this._typeError("boolean", value)];
    }
    // SUBTYPE_BASE / unconstrained — accept anything.
    return [];
  }

  protected _typeError(_expected: string, value: AttrValue): ValueError {
    return {
      message:
        `attribute '@${this.name}' must be of type '${this.subType}' ` +
        `but got ${runtimeTypeName(value)}`,
    };
  }
}

/** Human-readable runtime type of an attr value, for error messages. */
export function runtimeTypeName(value: AttrValue): string {
  if (Array.isArray(value)) return "array";
  if (value !== null && typeof value === "object") return "object";
  return typeof value;
}

// Register the base MetaAttr as the fallback for unmapped (scalar/string) attr
// subtypes. Subclasses register their own subtype in their module (see
// meta-attr-stringarray / -filter / -properties).
registerFallbackAttrClass(MetaAttr);

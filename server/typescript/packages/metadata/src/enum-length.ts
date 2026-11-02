// The column length of a string-stored field.enum: the field's @maxLength, else the
// project's default (`enums.maxLength` in .metaobjects/config.json, carried on the loaded
// root beside the naming rules), else none — an unbounded text column, as before.

import type { MetaData } from "./shared/meta-data.js";
import { MetaModelError } from "./errors.js";
import {
  FIELD_ATTR_INT_VALUE_MAP,
  FIELD_ATTR_MAX_LENGTH,
  FIELD_ATTR_VALUES,
  FIELD_SUBTYPE_ENUM,
} from "./core/field/field-constants.js";
import { TYPE_OBJECT } from "./shared/base-types.js";

/** The `enums` block in `.metaobjects/config.json`. */
export const ENUMS_KEY_MAX_LENGTH = "maxLength";

/** The project's enum storage defaults: `enums` in `.metaobjects/config.json`. */
export interface EnumDefaults {
  /** The column length of a string-stored enum that declares no @maxLength. */
  readonly maxLength?: number | undefined;
}

/** No project default: an enum with no @maxLength is an unbounded text column. */
export const DEFAULT_ENUM_DEFAULTS: EnumDefaults = Object.freeze({});

/** The enum defaults for the tree `node` belongs to: what its root carries, else none. */
export function enumDefaultsOf(node: MetaData): EnumDefaults {
  const defaults = (node.root() as { enumDefaults?: EnumDefaults }).enumDefaults;
  return defaults ?? DEFAULT_ENUM_DEFAULTS;
}

/**
 * The column length of `field`, a string-stored `field.enum`: its @maxLength (ADR-0039 —
 * resolving, it may be inherited), else the project default, else undefined. Undefined for
 * an @intValueMap enum, whose column is an integer, and for any other field.
 *
 * The loader refuses an @maxLength a member does not fit; it does not see the project
 * config, so a member longer than the project DEFAULT is refused here, by every consumer
 * that sizes the column (`meta migrate`, the generated bindings).
 */
export function resolveEnumMaxLength(field: MetaData): number | undefined {
  if (field.subType !== FIELD_SUBTYPE_ENUM || field.attr(FIELD_ATTR_INT_VALUE_MAP) !== undefined) return undefined;
  const own = field.attr(FIELD_ATTR_MAX_LENGTH);
  if (typeof own === "number") return own;
  const fallback = enumDefaultsOf(field).maxLength;
  if (fallback === undefined) return undefined;
  const values = field.attr(FIELD_ATTR_VALUES);
  const longest = (Array.isArray(values) ? values : [])
    .filter((v): v is string => typeof v === "string")
    .reduce<string | undefined>((a, v) => (a === undefined || v.length > a.length ? v : a), undefined);
  if (longest !== undefined && longest.length > fallback) {
    const owner = field.parent;
    const label = owner !== undefined && owner.type === TYPE_OBJECT ? `${owner.name}.${field.name}` : field.name;
    throw new MetaModelError(
      `field.enum "${label}" has the member "${longest}" (${longest.length} characters), longer than ` +
      `the project's enums.maxLength ${fallback}. Give the field its own @maxLength of at least ` +
      `${longest.length}, raise enums.maxLength, or shorten the member.`,
      { code: "ERR_ENUM_VALUE_EXCEEDS_MAX_LENGTH" },
    );
  }
  return fallback;
}

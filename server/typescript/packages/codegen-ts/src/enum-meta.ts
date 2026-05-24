// Shared field.enum metadata helpers — consumed by zod-validators.ts,
// field-meta.ts, inferred-types.ts, and column-mapper.ts so the @values
// extraction and the z.enum([...]) expression are derived in exactly one place.

import type { MetaField } from "@metaobjectsdev/metadata";
import { FIELD_ATTR_VALUES } from "@metaobjectsdev/metadata";

/**
 * Effective enum member values (`@values`) for a field, as strings.
 * Returns undefined when the field declares no `@values` array — callers then
 * fall back to the untyped `z.string()` / `text` representation.
 *
 * `attr()` already returns the effective (own-winning-else-inherited) value, so
 * a field that inherits `@values` from an abstract `field.enum` super resolves
 * here too.
 */
export function enumValues(field: MetaField): string[] | undefined {
  const values = field.attr(FIELD_ATTR_VALUES);
  if (!Array.isArray(values)) return undefined;
  return values.map((v) => String(v));
}

/** Build the Zod expression for a set of enum members, e.g. `z.enum(["A", "B"])`. */
export function zodEnumExpr(values: string[]): string {
  return `z.enum([${values.map((v) => JSON.stringify(v)).join(", ")}])`;
}

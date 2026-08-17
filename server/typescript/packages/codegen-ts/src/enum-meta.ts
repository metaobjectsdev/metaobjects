// Shared field.enum metadata helpers — consumed by zod-validators.ts,
// field-meta.ts, inferred-types.ts, and column-mapper.ts so the @values
// extraction and the z.enum([...]) expression are derived in exactly one place.

import type { MetaField } from "@metaobjectsdev/metadata";
import { FIELD_ATTR_VALUES, FIELD_ATTR_INT_VALUE_MAP } from "@metaobjectsdev/metadata";

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

/**
 * The effective `@intValueMap` (member symbol → integer) for an int-backed enum,
 * or undefined when the enum is string-backed. Its PRESENCE is the whole trigger
 * for integer persistence (design D5) — there is no separate flag or config.
 *
 * ADR-0039: RESOLVING (`attr`, not `ownAttr`), and this is load-bearing rather
 * than incidental. Post-#246 an own `@intValueMap` declared against a shared
 * (root-level abstract) enum is `ERR_ENUM_EXTENDS_VALUES_CONFLICT`, so the map
 * lives on the SHARED DECLARATION and every consuming field INHERITS it. An
 * own-only read would therefore see undefined on exactly the shape adopters are
 * steered toward, and silently emit a string codec into an integer column.
 */
export function intValueMapOf(field: MetaField): Record<string, number> | undefined {
  const raw = field.attr(FIELD_ATTR_INT_VALUE_MAP);
  if (raw === undefined || raw === null || typeof raw !== "object") return undefined;
  return raw as Record<string, number>;
}

/**
 * The integer a member symbol persists as, for an int-backed enum. Throws when the
 * member has no mapping — the loader pins key-set-equals-`@values` (Check 5b) in
 * every port, so a miss is unreachable and must not be papered over: emitting the
 * symbol instead would fail only at INSERT time, against a live database.
 */
export function intValueForMember(
  intMap: Record<string, number>,
  member: string,
  context: string,
): number {
  const n = intMap[member];
  if (typeof n !== "number") {
    throw new Error(`@intValueMap has no integer for member '${member}' (${context}).`);
  }
  return n;
}

/** Build the Zod expression for a set of enum members, e.g. `z.enum(["A", "B"])`. */
export function zodEnumExpr(values: string[]): string {
  return `z.enum([${values.map((v) => JSON.stringify(v)).join(", ")}])`;
}

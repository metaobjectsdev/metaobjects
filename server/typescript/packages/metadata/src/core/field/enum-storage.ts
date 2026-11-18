// rc.21 — the string a string-stored field.enum member is stored as: its @stringValueMap entry,
// else the member itself. ONE definition every consumer that writes a member into the database
// (a CHECK, a column length, a DEFAULT, a @condition literal, a converter) reads, so none can
// spell a member the database does not hold.

import type { MetaData } from "../../shared/meta-data.js";
import { FIELD_ATTR_STRING_VALUE_MAP, FIELD_ATTR_VALUES } from "./field-constants.js";

/** The effective (ADR-0039: resolving, it may be inherited) `@stringValueMap`, or undefined. */
export function stringValueMapOf(field: MetaData): Readonly<Record<string, string>> | undefined {
  const raw = field.attr(FIELD_ATTR_STRING_VALUE_MAP);
  if (raw === undefined || raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  return raw as Record<string, string>;
}

/** The string `member` is stored as: its @stringValueMap entry, else the member. */
export function storedEnumValue(field: MetaData, member: string): string {
  const map = stringValueMapOf(field);
  const stored = map?.[member];
  return typeof stored === "string" ? stored : member;
}

/** Every member of @values (ADR-0039: resolving), as stored, in declaration order. */
export function storedEnumValues(field: MetaData): string[] {
  const values = field.attr(FIELD_ATTR_VALUES);
  return (Array.isArray(values) ? values : [])
    .filter((v): v is string => typeof v === "string")
    .map((v) => storedEnumValue(field, v));
}

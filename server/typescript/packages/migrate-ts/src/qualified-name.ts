// The ONE qualified-physical-name form: `<schema>.<name>`, with an absent schema
// normalized to the Postgres default.
//
// Three things must key DB objects identically or the diff silently disagrees with
// itself: `diff`'s table/view identity maps, the declared-`@unmanaged` exclusion set
// (`collectUnmanagedNames`), and the out-of-scope exclusion set (`scopeExpectedSchema`).
// The last two are ACT-side suppressions matched against the first, so a name built a
// second way — a different default schema, a different separator — reads as "not
// suppressed" and the object it names comes back as a proposed DROP. One function.
//
// SQLite has no schema concept, so every SQLite object normalizes to the same prefix.
// That is harmless: it is a constant, and the un-prefixed names were already unique.

import { DEFAULT_DB_SCHEMA_POSTGRES } from "@metaobjectsdev/metadata";

/** `<schema>.<name>`; an absent schema is the Postgres default (`public`). The
 *  parameter accepts an EXPLICIT `undefined` schema (not only an omitted key) so a
 *  caller holding a `string | undefined` can pass it straight through under
 *  `exactOptionalPropertyTypes` — the two spell the same thing here. */
export function qualifiedDbName(obj: { name: string; schema?: string | undefined }): string {
  return `${obj.schema ?? DEFAULT_DB_SCHEMA_POSTGRES}.${obj.name}`;
}

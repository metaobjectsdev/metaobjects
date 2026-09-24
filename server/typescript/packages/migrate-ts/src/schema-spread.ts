/**
 * Build the optional-schema spread used when constructing Change records. Required because
 * `exactOptionalPropertyTypes: true` rejects explicit `undefined` for an optional field —
 * we either include the key or we don't. Its own leaf module so the diff and the rename
 * heuristic can both use it without importing each other (the same reason as
 * column-default.ts; the heuristic cannot import the diff hub, which imports it).
 */
export function schemaSpread(schema: string | undefined): { schema?: string } {
  return schema !== undefined ? { schema } : {};
}

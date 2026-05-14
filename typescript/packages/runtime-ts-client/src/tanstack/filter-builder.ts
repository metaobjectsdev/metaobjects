import qs from "qs";

/**
 * Build a bracketed qs URL fragment from a filter object.
 *
 * Output shape (qs's default bracketed style):
 *   ?filter[email][like]=%25@x.com&filter[subscribed]=true&sort=createdAt:desc&limit=25
 *
 * Top-level `limit`, `offset`, and `sort` are emitted at the top level (not
 * under `filter`). All other keys go inside `filter`. The `or` / `and` keys
 * (if present) move inside `filter` so they nest correctly for the server's
 * parser.
 */
export function buildFilterQs(filter: Record<string, unknown>): string {
  const { limit, offset, sort, or, and, ...fields } = filter as any;
  return qs.stringify(
    {
      ...(limit  !== undefined ? { limit }  : {}),
      ...(offset !== undefined ? { offset } : {}),
      ...(sort   !== undefined ? { sort }   : {}),
      filter: {
        ...fields,
        ...(or  !== undefined ? { or }  : {}),
        ...(and !== undefined ? { and } : {}),
      },
    },
    { encodeValuesOnly: true },
  );
}

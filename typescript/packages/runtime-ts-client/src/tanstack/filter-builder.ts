import qs from "qs";

/**
 * Build a bracketed qs URL fragment from a filter object.
 *
 * Output shape (qs's default bracketed style):
 *   ?filter[email][like]=%25@x.com&filter[subscribed]=true&sort=createdAt:desc&limit=25&withCount=1&search=term
 *
 * Top-level `limit`, `offset`, `sort`, `withCount`, and `search` are emitted
 * at the top level (not under `filter`). All other keys go inside `filter`.
 * The `or` / `and` keys (if present) move inside `filter` so they nest
 * correctly for the server's parser.
 *
 * `withCount` is the opt-in flag for the `{ rows, total }` list-response
 * envelope (see runtime-ts mountListRoute). Pass `1` or `true` to enable.
 *
 * `search` is a free-text term that the server ORs as `like('%term%')` across
 * all @filterable string fields, AND-combined with any explicit filter WHERE.
 */
export function buildFilterQs(filter: Record<string, unknown>): string {
  const { limit, offset, sort, withCount, search, or, and, ...fields } = filter as any;
  const top: Record<string, unknown> = {};
  if (limit     !== undefined) top.limit     = limit;
  if (offset    !== undefined) top.offset    = offset;
  if (sort      !== undefined) top.sort      = sort;
  if (withCount !== undefined) top.withCount = withCount;
  if (search    !== undefined) top.search    = search;
  const filterObj: Record<string, unknown> = { ...fields };
  if (or  !== undefined) filterObj.or  = or;
  if (and !== undefined) filterObj.and = and;
  return qs.stringify({ ...top, filter: filterObj }, { encodeValuesOnly: true });
}

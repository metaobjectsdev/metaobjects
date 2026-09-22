import qs from "qs";

/**
 * Build a bracketed qs URL fragment from a filter object.
 *
 * Output shape (qs's bracketed style), shown DECODED:
 *   ?filter[email][like]=%@x.com&filter[subscribed]=true&sort=createdAt:desc&limit=25&withCount=1&search=term
 *
 * On the wire the brackets are percent-encoded (`filter%5Bemail%5D%5Blike%5D=…`). RFC 3986
 * admits no raw `[`/`]` in a query, and Tomcat — every Spring Boot app's default server —
 * answers a raw one with its own HTML 400, so the generated Java and Kotlin controllers could
 * not serve a single filtered request while this sent them raw. Every server-side parser
 * decodes before it reads the brackets, so the encoded form means the same thing everywhere.
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
  return qs.stringify({ ...top, filter: filterObj });
}

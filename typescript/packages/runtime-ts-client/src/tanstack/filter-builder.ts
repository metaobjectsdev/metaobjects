import qs from "qs";

/**
 * Build a bracketed qs URL fragment from a filter object.
 *
 * Output shape (qs's default bracketed style):
 *   ?filter[email][like]=%25@x.com&filter[subscribed]=true&sort=createdAt:desc&limit=25&withCount=1
 *
 * Top-level `limit`, `offset`, `sort`, and `withCount` are emitted at the top
 * level (not under `filter`). All other keys go inside `filter`. The `or` /
 * `and` keys (if present) move inside `filter` so they nest correctly for the
 * server's parser.
 *
 * `withCount` is the opt-in flag for the `{ rows, total }` list-response
 * envelope (see runtime-ts mountListRoute). Pass `1` or `true` to enable.
 */
export function buildFilterQs(filter: Record<string, unknown>): string {
  const { limit, offset, sort, withCount, or, and, ...fields } = filter as any;
  return qs.stringify(
    {
      ...(limit     !== undefined ? { limit }     : {}),
      ...(offset    !== undefined ? { offset }    : {}),
      ...(sort      !== undefined ? { sort }      : {}),
      ...(withCount !== undefined ? { withCount } : {}),
      filter: {
        ...fields,
        ...(or  !== undefined ? { or }  : {}),
        ...(and !== undefined ? { and } : {}),
      },
    },
    { encodeValuesOnly: true },
  );
}

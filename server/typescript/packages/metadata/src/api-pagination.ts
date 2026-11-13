// The page size of a generated list route: `api.pagination` in .metaobjects/config.json,
// carried on the loaded root beside the naming rules and read through `apiPaginationOf`.
// A project without the block has none, and its routes behave as they always have.

import type { MetaData } from "./shared/meta-data.js";

/** The `api` block in `.metaobjects/config.json`. */
export const API_KEY_PAGINATION = "pagination";
/** The keys of `api.pagination`. */
export const PAGINATION_KEY_DEFAULT_LIMIT = "defaultLimit";
export const PAGINATION_KEY_MAX_LIMIT = "maxLimit";

/** What `meta init` writes for a new project. */
export const INIT_DEFAULT_LIMIT = 50;
export const INIT_MAX_LIMIT = 1000;

/**
 * `api.pagination`: a list route with no `limit` returns `defaultLimit` rows, and an explicit
 * `limit` above `maxLimit` is refused with `400 { "error": "limit_too_large", "maxLimit": N }`.
 */
export interface ApiPagination {
  readonly defaultLimit: number;
  readonly maxLimit: number;
}

/** The page-size setting of the tree `node` belongs to: what its root carries, else none. */
export function apiPaginationOf(node: MetaData): ApiPagination | undefined {
  return (node.root() as { apiPagination?: ApiPagination | undefined }).apiPagination;
}

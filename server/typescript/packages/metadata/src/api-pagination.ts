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

// ── api.unknownFields ────────────────────────────────────────────────────────────────────────
// What a generated create, PUT or PATCH route does with a body key the entity does not declare.

/** The key of `api.unknownFields` in `.metaobjects/config.json`. */
export const API_KEY_UNKNOWN_FIELDS = "unknownFields";
/** Refuse the request: `400 { "error": "unknown_fields", "fields": [...] }`. The default. */
export const UNKNOWN_FIELDS_REJECT = "reject";
/** Drop the undeclared keys silently and write the rest (the behaviour before 1.3). */
export const UNKNOWN_FIELDS_DROP = "drop";
export const UNKNOWN_FIELDS_MODES = [UNKNOWN_FIELDS_REJECT, UNKNOWN_FIELDS_DROP] as const;
export type UnknownFieldsMode = (typeof UNKNOWN_FIELDS_MODES)[number];
/** A project that sets nothing refuses undeclared keys. */
export const DEFAULT_UNKNOWN_FIELDS: UnknownFieldsMode = UNKNOWN_FIELDS_REJECT;
/** The `error` of the 400 a refused body answers with. */
export const ERROR_UNKNOWN_FIELDS = "unknown_fields";

/**
 * The unknown-field rule of the tree `node` belongs to: what its root carries, else the
 * default (`reject`). A key is unknown when no field of the entity declares it (for a
 * single-table hierarchy, no field of the base or any subtype). A declared key the client may
 * not set (the generated key, a `readOnly` or derived field, a frozen field on update) is not
 * unknown: it is dropped under either rule, so a client that echoes back a row it read keeps
 * working.
 */
export function apiUnknownFieldsOf(node: MetaData): UnknownFieldsMode {
  return (node.root() as { apiUnknownFields?: UnknownFieldsMode | undefined }).apiUnknownFields ?? DEFAULT_UNKNOWN_FIELDS;
}

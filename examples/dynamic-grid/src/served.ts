/**
 * What the browser needs to know about the server that the model document (`/_meta`) does
 * not carry. Generated code has these baked in (`$path` on each entity's descriptor); with
 * nothing generated, the server says them at runtime.
 */
export interface ServedInfo {
  /** Goes up by one on every reload, so an open page can tell the model changed. */
  readonly revision: number;
  /** Entity name to the collection path it is served under, e.g. `WorkOrder` to `work_orders`. */
  readonly collections: Readonly<Record<string, string>>;
  /** The project's `api.pagination`, or null when it sets none. */
  readonly pagination: { readonly defaultLimit: number; readonly maxLimit: number } | null;
}

/** The route `ServedInfo` is served on, beside `/_meta`. */
export const SERVED_ROUTE_PATH = "/_served";

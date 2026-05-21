/**
 * Generic fetcher signature. Returns already-parsed JSON of type T.
 * Mirrors the shape used by the trainer website's existing adminFetch<T> helper.
 *
 * Generated hooks call this for every request — GET / POST / PATCH / DELETE.
 * The app supplies the concrete implementation via EntityFetcherProvider.
 */
export type EntityFetcher = <T>(path: string, init?: RequestInit) => Promise<T>;

/** Grid-level config emitted by the codegen for each named data-grid view. */
export interface GridConfig {
  name: string;
  pageSize: number;
  defaultSort?: { field: string; order: "asc" | "desc" };
  filterable: boolean;
}

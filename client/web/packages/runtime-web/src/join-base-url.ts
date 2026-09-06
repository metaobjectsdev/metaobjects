/**
 * Join a client base URL to a generated entity-relative path.
 *
 * ONE implementation, shared by both client tiers on purpose. `@metaobjectsdev/tanstack`
 * wraps `useEntityFetcher()` with it and `@metaobjectsdev/angular` wraps the
 * `EntityFetcherToken`; implemented separately they would eventually disagree about a
 * trailing slash, and the disagreement would surface as a 404 in one framework only.
 *
 * `baseUrl` is deliberately optional and empty-by-default — a same-origin app mounting
 * routes at the root needs no base, which is also what `meta init` scaffolds
 * (`apiPrefix: ""`). The value may be a path (`/api`) or a full origin
 * (`https://api.example.com/v1`); both are just prefixes to this function.
 *
 * The path is passed through with only its leading separator normalized: a query string
 * rides along untouched, because generated hooks build `?…` onto the path before calling
 * the fetcher.
 */
export function joinBaseUrl(baseUrl: string | undefined, path: string): string {
  if (baseUrl === undefined || baseUrl === "") return path;
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const rest = path.startsWith("/") ? path : `/${path}`;
  return `${base}${rest}`;
}

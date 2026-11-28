// UI-1 — the metadata API contract. Framework-free on purpose: only TypeScript
// has a web-bound runtime home, so every other port ships this function and lets
// the host mount it. The durable deliverable is the path + the serialization.
import { buildDocsView, canonicalSerializeEffective, serializeDocsView, type MetaData } from "@metaobjectsdev/metadata";

/**
 * The metadata endpoint's path, mounted under the host's `apiPrefix`.
 * A cross-port contract value — one browser read-model has to work against
 * every backend, so this string is not per-port configurable.
 */
export const META_ROUTE_PATH = "/_meta";

/**
 * The `GET {apiPrefix}/_meta` response content-type header.
 * A TypeScript-local detail, not a cross-port contract: only this port ships
 * HTTP mounts, so this value only has to stay byte-identical across TypeScript's
 * own `mountMetaRoute` (Fastify) and `mountMetaRouteHono` (Hono). Another port's
 * hand-mounted route is free to emit a different content-type
 * (see docs/features/metadata-api.md).
 */
export const META_CONTENT_TYPE = "application/json; charset=utf-8";

/**
 * The `GET {apiPrefix}/_meta` response body: the loaded model as EFFECTIVE
 * canonical JSON.
 *
 * Effective, not raw (spec §3.2): the effective form materializes the
 * super-chain merge, so a browser reading it never resolves `extends` itself.
 * Per ADR-0039 an own-vs-resolving mistake there would silently drop inherited
 * `@columns` / `@pageSize` / `@sortableDefaultOrder` — exactly the attrs a
 * runtime grid reads — and read as "unset" rather than failing.
 */
export function metaJson(root: MetaData): string {
  return canonicalSerializeEffective(root);
}

/**
 * The docs view endpoint's path, mounted under the host's `apiPrefix` beside
 * {@link META_ROUTE_PATH}. A cross-port contract value: the model explorer app
 * reads `GET {apiPrefix}/_meta/docs` from any backend.
 */
export const META_DOCS_ROUTE_PATH = `${META_ROUTE_PATH}/docs`;

/** What the docs view endpoint builds the view from, beyond the model. */
export interface MetaDocsOptions {
  /** The routes the application mounts, `[{ node, method, path }]` with `node` a resolution
   *  key, as `buildDocsView` reads them. Without them no node lists its REST routes. */
  routes?: unknown;
}

/**
 * The `GET {apiPrefix}/_meta/docs` response body: the loaded model's docs view
 * (docs/features/docs-view.md), as `serializeDocsView` writes it. It is built
 * from the model alone: no verify payload and no generation manifest, which a
 * running application does not hold. So it matches the `explorer.json` a
 * docs-site build writes only when that build had neither.
 */
export function metaDocsJson(root: MetaData, opts: MetaDocsOptions = {}): string {
  return serializeDocsView(buildDocsView({ root, ...(opts.routes !== undefined && { routes: opts.routes }) }));
}

/**
 * A strong ETag for a docs view body: its length and its 32-bit FNV-1a hash, so
 * a poller's revalidation costs a 304. A TypeScript-local detail like
 * {@link META_CONTENT_TYPE}: the contract is only that the tag changes when the
 * body does. Plain arithmetic, so it runs wherever Hono does.
 */
export function metaDocsEtag(body: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < body.length; i++) {
    h ^= body.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `"${body.length.toString(16)}-${(h >>> 0).toString(16).padStart(8, "0")}"`;
}

/** Whether an `If-None-Match` header value names `etag` (or is `*`). */
export function etagMatches(ifNoneMatch: string | undefined | null, etag: string): boolean {
  if (ifNoneMatch == null || ifNoneMatch === "") return false;
  return ifNoneMatch.split(",").some((t) => {
    const v = t.trim().replace(/^W\//, "");
    return v === "*" || v === etag;
  });
}

/** The headers both mounts send on the docs view route. `allowOrigin`, when given, lets a
 *  page served from elsewhere (the explorer app opened from `file://`, whose origin is
 *  `null`) read the route; without it the route is same-origin only, like `/_meta`. */
export function metaDocsHeaders(etag: string, allowOrigin: string | undefined): Record<string, string> {
  return {
    "content-type": META_CONTENT_TYPE,
    etag,
    // Revalidate on every read: the model can change when the application restarts.
    "cache-control": "no-cache",
    ...(allowOrigin !== undefined && {
      "access-control-allow-origin": allowOrigin,
      "access-control-expose-headers": "ETag",
      ...(allowOrigin !== "*" && { vary: "Origin" }),
    }),
  };
}

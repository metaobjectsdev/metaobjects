// UI-1 — the metadata API contract. Framework-free on purpose: only TypeScript
// has a web-bound runtime home, so every other port ships this function and lets
// the host mount it. The durable deliverable is the path + the serialization.
import { canonicalSerializeEffective, type MetaData } from "@metaobjectsdev/metadata";

/**
 * The metadata endpoint's path, mounted under the host's `apiPrefix`.
 * A cross-port contract value — one browser read-model has to work against
 * every backend, so this string is not per-port configurable.
 */
export const META_ROUTE_PATH = "/_meta";

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

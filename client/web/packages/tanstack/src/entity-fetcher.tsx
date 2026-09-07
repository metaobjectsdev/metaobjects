import { createContext, useContext, useMemo, type ReactNode } from "react";
import { joinBaseUrl, type EntityFetcher } from "@metaobjectsdev/runtime-web";

const EntityFetcherContext = createContext<EntityFetcher | null>(null);

export interface EntityFetcherProviderProps {
  /**
   * Transport only. It receives an already-prefixed URL and never learns about
   * routing — that split is why `baseUrl` is a sibling option here rather than
   * something each app hides inside its own fetch helper.
   */
  fetcher: EntityFetcher;
  /**
   * Where the API lives — a path (`/api`) or a full origin
   * (`https://api.example.com/v1`).
   *
   * OPTIONAL, default `""`: same-origin at the root, which is what `meta init`
   * scaffolds (`apiPrefix: ""`). Generated hooks emit entity-relative paths, so this
   * is the single place the base is decided, and deciding it at RUNTIME rather than
   * at `meta gen` time is what lets one client bundle serve a dev proxy, a preview
   * environment and a separate API host without regenerating.
   */
  baseUrl?: string | undefined;
  children: ReactNode;
}

/** Wrap your app (or admin subtree) to supply a fetcher to generated hooks. */
export function EntityFetcherProvider({
  fetcher,
  baseUrl,
  children,
}: EntityFetcherProviderProps) {
  // Memoized so the wrapped identity is stable across renders. An unmemoized wrapper is
  // a new function every render, which churns everything downstream that captures it.
  const value = useMemo<EntityFetcher>(
    () =>
      (<T,>(path: string, init?: RequestInit) =>
        fetcher<T>(joinBaseUrl(baseUrl, path), init)) as EntityFetcher,
    [fetcher, baseUrl],
  );
  return <EntityFetcherContext.Provider value={value}>{children}</EntityFetcherContext.Provider>;
}

/**
 * The fetcher from context, already bound to `baseUrl`.
 *
 * **Every path you hand this is rewritten**: `baseUrl` is prefixed onto it. That
 * is exactly right for the ENTITY-RELATIVE paths generated hooks emit
 * (`${Entity.$path}/…`), and it is the reason for the name — the argument is an
 * entity path, not an application path.
 *
 * It is NOT a general-purpose `fetch`. Handing it an absolute app route silently
 * relocates the request: with `baseUrl="/api"`, `/internal/leads/1/notes` becomes
 * `/api/internal/leads/1/notes`, and an already-prefixed `/api/decisions/1`
 * becomes `/api/api/decisions/1`. Both are type-correct, so nothing in the
 * compiler, the unit suite or `meta verify` can see them — only a request that
 * 404s at runtime. An adopter who had followed the "the fetcher is the ONE place
 * base-URL policy lives" advice and shared this seam with hand-written call sites
 * lost ten write actions this way, silently.
 *
 * For non-entity paths, call your own transport directly, or compose `joinBaseUrl`
 * from `@metaobjectsdev/runtime-web` yourself where you DO want the prefix.
 *
 * Throws if no `<EntityFetcherProvider>` is above it.
 */
export function useEntityPathFetcher(): EntityFetcher {
  const fetcher = useContext(EntityFetcherContext);
  if (!fetcher) {
    throw new Error(
      "useEntityPathFetcher() called outside <EntityFetcherProvider>. " +
        "Wrap your app (or the relevant subtree) with EntityFetcherProvider fetcher={...}.",
    );
  }
  return fetcher;
}

/**
 * @deprecated Renamed to {@link useEntityPathFetcher}. Identical behaviour — the
 * new name says what the hook does to the path it is given, which is what the old
 * name hid: before 1.0 the provider passed its fetcher through unchanged, so
 * "entity fetcher" was an accurate description of a hook that rewrote nothing.
 * 1.0 made it BIND the fetcher to `baseUrl` (generated hooks stopped composing
 * `$apiPrefix` themselves), and the name did not move with the behaviour.
 *
 * This alias will be removed in a future major. If you share this seam with
 * hand-written non-entity call sites, read {@link useEntityPathFetcher} first —
 * those paths are being rewritten.
 */
export const useEntityFetcher = useEntityPathFetcher;

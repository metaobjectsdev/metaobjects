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

/** Reads the fetcher from context, already bound to `baseUrl`. Throws if not provided. */
export function useEntityFetcher(): EntityFetcher {
  const fetcher = useContext(EntityFetcherContext);
  if (!fetcher) {
    throw new Error(
      "useEntityFetcher() called outside <EntityFetcherProvider>. " +
        "Wrap your app (or the relevant subtree) with EntityFetcherProvider fetcher={...}.",
    );
  }
  return fetcher;
}

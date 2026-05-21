import { createContext, useContext, type ReactNode } from "react";
import type { EntityFetcher } from "./types.js";

const EntityFetcherContext = createContext<EntityFetcher | null>(null);

export interface EntityFetcherProviderProps {
  value: EntityFetcher;
  children: ReactNode;
}

/** Wrap your app (or admin subtree) to supply a fetcher to generated hooks. */
export function EntityFetcherProvider({ value, children }: EntityFetcherProviderProps) {
  return <EntityFetcherContext.Provider value={value}>{children}</EntityFetcherContext.Provider>;
}

/** Reads the fetcher from context. Throws if not provided. */
export function useEntityFetcher(): EntityFetcher {
  const fetcher = useContext(EntityFetcherContext);
  if (!fetcher) {
    throw new Error(
      "useEntityFetcher() called outside <EntityFetcherProvider>. " +
        "Wrap your app (or the relevant subtree) with EntityFetcherProvider value={...}.",
    );
  }
  return fetcher;
}

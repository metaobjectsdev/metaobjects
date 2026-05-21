import { describe, test, expect } from "bun:test";
import "./setup.js";
import { renderHook } from "@testing-library/react";
import { EntityFetcherProvider, useEntityFetcher, type EntityFetcher } from "../src/index.js";
import type { ReactNode } from "react";

function Wrapper({ value, children }: { value: any; children: ReactNode }) {
  return <EntityFetcherProvider value={value}>{children}</EntityFetcherProvider>;
}

describe("useEntityFetcher", () => {
  test("returns the value provided by EntityFetcherProvider", () => {
    const fetcher = async (path: string) => ({ ok: true, path }) as any;
    const { result } = renderHook(() => useEntityFetcher(), {
      wrapper: ({ children }) => <Wrapper value={fetcher}>{children}</Wrapper>,
    });
    expect(result.current).toBe(fetcher);
  });

  test("throws with a clear message when used outside a provider", () => {
    expect(() => renderHook(() => useEntityFetcher())).toThrow(/EntityFetcherProvider/);
  });

  test("nested providers override", () => {
    const outer = async () => "outer";
    const inner = async () => "inner";
    const { result } = renderHook(() => useEntityFetcher(), {
      wrapper: ({ children }) => (
        <EntityFetcherProvider value={outer as any}>
          <EntityFetcherProvider value={inner as any}>{children}</EntityFetcherProvider>
        </EntityFetcherProvider>
      ),
    });
    // Cast for reference-identity check: inner is passed as any to the provider;
    // result.current is EntityFetcher (generic), so a structural cast is needed here.
    expect(result.current).toBe(inner as unknown as EntityFetcher);
  });
});

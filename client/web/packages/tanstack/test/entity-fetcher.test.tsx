import { describe, test, expect } from "bun:test";
import "./setup.js";
import { renderHook } from "@testing-library/react";
import { EntityFetcherProvider, useEntityFetcher } from "../src/index.js";
import type { ReactNode } from "react";

function wrapper(fetcher: unknown, baseUrl?: string) {
  return ({ children }: { children: ReactNode }) => (
    <EntityFetcherProvider fetcher={fetcher as never} baseUrl={baseUrl}>
      {children}
    </EntityFetcherProvider>
  );
}

describe("useEntityFetcher", () => {
  test("with no baseUrl the path reaches the fetcher unchanged", async () => {
    const seen: string[] = [];
    const fetcher = async (p: string) => {
      seen.push(p);
      return null as never;
    };
    const { result } = renderHook(() => useEntityFetcher(), { wrapper: wrapper(fetcher) });
    await result.current("/customers");
    expect(seen).toEqual(["/customers"]);
  });

  test("baseUrl is prepended before the fetcher sees it", async () => {
    const seen: string[] = [];
    const fetcher = async (p: string) => {
      seen.push(p);
      return null as never;
    };
    const { result } = renderHook(() => useEntityFetcher(), {
      wrapper: wrapper(fetcher, "/api"),
    });
    await result.current("/customers?limit=25");
    expect(seen).toEqual(["/api/customers?limit=25"]);
  });

  test("init is forwarded untouched", async () => {
    const seen: RequestInit[] = [];
    const fetcher = async (_p: string, init?: RequestInit) => {
      if (init) seen.push(init);
      return null as never;
    };
    const { result } = renderHook(() => useEntityFetcher(), {
      wrapper: wrapper(fetcher, "/api"),
    });
    await result.current("/customers", { method: "DELETE" });
    expect(seen).toEqual([{ method: "DELETE" }]);
  });

  test("the wrapped fetcher is referentially stable across renders", () => {
    const fetcher = async () => null as never;
    const { result, rerender } = renderHook(() => useEntityFetcher(), {
      wrapper: wrapper(fetcher, "/api"),
    });
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });

  test("nested providers override, base and all", async () => {
    const seen: string[] = [];
    const outer = async (p: string) => {
      seen.push(`outer:${p}`);
      return null as never;
    };
    const inner = async (p: string) => {
      seen.push(`inner:${p}`);
      return null as never;
    };
    const { result } = renderHook(() => useEntityFetcher(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <EntityFetcherProvider fetcher={outer as never} baseUrl="/outer">
          <EntityFetcherProvider fetcher={inner as never} baseUrl="/inner">
            {children}
          </EntityFetcherProvider>
        </EntityFetcherProvider>
      ),
    });
    await result.current("/customers");
    expect(seen).toEqual(["inner:/inner/customers"]);
  });

  test("throws with a clear message when used outside a provider", () => {
    expect(() => renderHook(() => useEntityFetcher())).toThrow(/EntityFetcherProvider/);
  });
});

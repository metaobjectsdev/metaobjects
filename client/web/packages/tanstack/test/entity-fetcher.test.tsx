import { describe, test, expect } from "bun:test";
import "./setup.js";
import { renderHook } from "@testing-library/react";
import {
  EntityFetcherProvider,
  useEntityPathFetcher,
  useEntityFetcher,
} from "../src/index.js";
import type { ReactNode } from "react";

function wrapper(fetcher: unknown, baseUrl?: string) {
  return ({ children }: { children: ReactNode }) => (
    <EntityFetcherProvider fetcher={fetcher as never} baseUrl={baseUrl}>
      {children}
    </EntityFetcherProvider>
  );
}

describe("useEntityPathFetcher", () => {
  test("with no baseUrl the path reaches the fetcher unchanged", async () => {
    const seen: string[] = [];
    const fetcher = async (p: string) => {
      seen.push(p);
      return null as never;
    };
    const { result } = renderHook(() => useEntityPathFetcher(), { wrapper: wrapper(fetcher) });
    await result.current("/customers");
    expect(seen).toEqual(["/customers"]);
  });

  test("baseUrl is prepended before the fetcher sees it", async () => {
    const seen: string[] = [];
    const fetcher = async (p: string) => {
      seen.push(p);
      return null as never;
    };
    const { result } = renderHook(() => useEntityPathFetcher(), {
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
    const { result } = renderHook(() => useEntityPathFetcher(), {
      wrapper: wrapper(fetcher, "/api"),
    });
    await result.current("/customers", { method: "DELETE" });
    expect(seen).toEqual([{ method: "DELETE" }]);
  });

  test("the wrapped fetcher is referentially stable across renders", () => {
    const fetcher = async () => null as never;
    const { result, rerender } = renderHook(() => useEntityPathFetcher(), {
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
    const { result } = renderHook(() => useEntityPathFetcher(), {
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
    expect(() => renderHook(() => useEntityPathFetcher())).toThrow(/EntityFetcherProvider/);
  });
});

// F20: the hook was renamed because 1.0 changed what it DOES to the path it is
// given — the provider began binding its fetcher to `baseUrl`, so every path
// handed to this seam is now rewritten. The old name described a hook that
// rewrote nothing.
describe("useEntityFetcher — the deprecated alias", () => {
  test("is the same hook, so existing call sites keep working", () => {
    expect(useEntityFetcher).toBe(useEntityPathFetcher);
  });

  test("the rewrite the new name warns about is real, and is what generated hooks want", async () => {
    const seen: string[] = [];
    const spy = (async (p: string) => { seen.push(p); return {}; }) as never;
    const { result } = renderHook(() => useEntityPathFetcher(), {
      wrapper: ({ children }) => (
        <EntityFetcherProvider fetcher={spy} baseUrl="/api">{children}</EntityFetcherProvider>
      ),
    });
    // An entity-relative path — what generated hooks emit. Correct.
    await result.current("/widgets/1");
    // An absolute APP path a hand-written call site might share this seam with.
    // It is rewritten too, and that is the footgun the name now names.
    await result.current("/internal/leads/1/notes");
    expect(seen).toEqual(["/api/widgets/1", "/api/internal/leads/1/notes"]);
  });
});

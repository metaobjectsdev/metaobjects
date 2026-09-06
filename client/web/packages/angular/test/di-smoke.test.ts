// The DI surface that CAN run under Bun.
//
// Split out of `angular-runtime.test.ts` because that file imports `../src/index.js`,
// whose barrel reaches `currency-input.component.ts` — and a `@Component` whose template
// pulls `@angular/common` cannot be instantiated in this process at all: the shipped
// fesm2022 bundles are PARTIALLY compiled (`ɵɵngDeclare*`) and need the Angular linker,
// a Babel plugin `bun test` does not run. So that file dies at import, its assertions
// never execute, and CI (`scripts/ci-local.sh`, gate_ts_unit) runs only
// `browser-bundleable.test.ts` from this package by name.
//
// The consequence is the part worth stating: every assertion in `angular-runtime.test.ts`
// has been dead. Anything added there reports as a pass without running. Tests that can
// run therefore live HERE, importing their modules DIRECTLY rather than through the
// barrel, so they execute — and this file is named in the CI lane beside the bundle gate.
import "./setup.js";
import { describe, test, expect } from "bun:test";
import { Injector } from "@angular/core";
import { EntityFetcherToken } from "../src/entity-fetcher.token.js";
import { CellRendererRegistry } from "../src/cell-renderer.registry.js";

describe("EntityFetcherToken", () => {
  test("throws a helpful error when nothing provided it", () => {
    const injector = Injector.create({ providers: [] });
    // The token declares no factory, so Angular's stock NullInjectorError fires; its
    // message carries the token description ("metaobjects.EntityFetcher").
    expect(() => injector.get(EntityFetcherToken)).toThrow(/No provider for.*EntityFetcher/);
  });
});

describe("CellRendererRegistry", () => {
  test("registers, resolves and clears a component class", () => {
    const registry = new CellRendererRegistry();
    class FakeRenderer {
      value: unknown = null;
    }
    expect(registry.resolve("currency")).toBeNull();
    registry.register("currency", FakeRenderer as never);
    expect(registry.resolve("currency")).toBe(FakeRenderer as never);
    registry.clear();
    expect(registry.resolve("currency")).toBeNull();
  });
});

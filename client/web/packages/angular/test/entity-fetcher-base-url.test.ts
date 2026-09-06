// Imports `../src/entity-fetcher.token.js` DIRECTLY, not the `../src/index.js` barrel.
//
// That is load-bearing, not stylistic. The barrel pulls in `currency-input.component.ts`,
// whose standard Angular field decorators throw "not supported in JIT mode" under Bun —
// a pre-existing failure that kills `angular-runtime.test.ts` at import time. Assertions
// added to that file never execute and report as a pass, which is the same artefact as no
// test. Importing the one module under test keeps these assertions real.
import { describe, test, expect } from "bun:test";
import { Injector } from "@angular/core";
import {
  EntityFetcherToken,
  provideEntityFetcher,
} from "../src/entity-fetcher.token.js";
import type { EntityFetcher } from "@metaobjectsdev/runtime-web";

function recorder(): { seen: string[]; inits: (RequestInit | undefined)[]; fetcher: EntityFetcher } {
  const seen: string[] = [];
  const inits: (RequestInit | undefined)[] = [];
  const fetcher: EntityFetcher = async <T>(path: string, init?: RequestInit): Promise<T> => {
    seen.push(path);
    inits.push(init);
    return [] as unknown as T;
  };
  return { seen, inits, fetcher };
}

describe("provideEntityFetcher", () => {
  test("binds baseUrl before the supplied fetcher sees the path", async () => {
    const { seen, fetcher } = recorder();
    const injector = Injector.create({
      providers: [provideEntityFetcher({ fetcher, baseUrl: "/api" })],
    });
    await injector.get(EntityFetcherToken)<unknown[]>("/author?limit=25");
    expect(seen).toEqual(["/api/author?limit=25"]);
  });

  test("omitting baseUrl leaves the entity-relative path unchanged", async () => {
    const { seen, fetcher } = recorder();
    const injector = Injector.create({
      providers: [provideEntityFetcher({ fetcher })],
    });
    await injector.get(EntityFetcherToken)<unknown[]>("/author");
    expect(seen).toEqual(["/author"]);
  });

  test("a trailing slash on baseUrl does not double", async () => {
    const { seen, fetcher } = recorder();
    const injector = Injector.create({
      providers: [provideEntityFetcher({ fetcher, baseUrl: "/api/" })],
    });
    await injector.get(EntityFetcherToken)<unknown[]>("/author");
    expect(seen).toEqual(["/api/author"]);
  });

  test("an absolute origin is preserved", async () => {
    const { seen, fetcher } = recorder();
    const injector = Injector.create({
      providers: [
        provideEntityFetcher({ fetcher, baseUrl: "https://api.example.com/v1" }),
      ],
    });
    await injector.get(EntityFetcherToken)<unknown[]>("/author");
    expect(seen).toEqual(["https://api.example.com/v1/author"]);
  });

  test("init is forwarded untouched", async () => {
    const { inits, fetcher } = recorder();
    const injector = Injector.create({
      providers: [provideEntityFetcher({ fetcher, baseUrl: "/api" })],
    });
    await injector.get(EntityFetcherToken)<unknown[]>("/author/1", { method: "DELETE" });
    expect(inits).toEqual([{ method: "DELETE" }]);
  });
});

# API base URL leaves the entity descriptor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove `$apiPrefix` from every generated entity descriptor and move the client's base URL to the runtime provider, so a client bundle can be built once and served against any origin.

**Architecture:** Generated client artifacts emit entity-relative paths (`${Entity.$path}…`). Both client tiers take their fetcher from exactly one seam — `useEntityFetcher()` (TanStack) and `inject(EntityFetcherToken)` (Angular) — so the base is applied once per tier by wrapping at that seam. The join lives in `runtime-web` so the two tiers cannot disagree about a slash.

**Tech Stack:** TypeScript, Bun (test + workspace), ts-poet (emit), React 18, Angular, Biome.

**Spec:** [`docs/superpowers/specs/2026-09-06-api-base-url-client-tier-design.md`](../specs/2026-09-06-api-base-url-client-tier-design.md)

## Global Constraints

- **`baseUrl` is OPTIONAL, defaulting to `""`.** Never make it required — that is migration ergonomics leaking into a permanent API, and it contradicts `meta init`'s own `apiPrefix: ""` scaffold (`cli/src/commands/init.ts:131`).
- **The option is spelled `baseUrl`**, never `basePath` / `baseURL` / `apiPrefix`.
- **`renderEntityConstants` and `renderEntityMetaFile` keep their `apiPrefix` parameter**, accepted and ignored, marked `@deprecated`. ADR-0034 ejected copies pass it positionally; removing it fails to compile in every adopter repo.
- **`apiPrefix` stays in `metaobjects.config.ts`** and keeps driving the server routes mount (`routes-file.ts:106`) and the documented addresses in `agent-ui-page.ts`. Do not rename the config key.
- **`metamodelVersion` stays `0.14`.** Nothing registered changes; do not run `check-metamodel-version.mjs --set`.
- **Never read metadata through an `own*()` accessor** (ADR-0039). No task here needs one.
- **Public repository.** No private project names, no absolute home paths, in code, docs, or commit messages.
- Run tests scoped: `cd server/typescript && bun test`, or per-package. Never a bare `bun test` at the repo root.

---

### Task 1: The join helper in `runtime-web`

**Files:**
- Create: `client/web/packages/runtime-web/src/join-base-url.ts`
- Modify: `client/web/packages/runtime-web/src/index.ts`
- Test: `client/web/packages/runtime-web/test/join-base-url.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `joinBaseUrl(baseUrl: string | undefined, path: string): string`, exported from `@metaobjectsdev/runtime-web`. Tasks 2 and 3 both import it.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { joinBaseUrl } from "../src/join-base-url.js";

describe("joinBaseUrl", () => {
  test("no base is the path unchanged", () => {
    expect(joinBaseUrl(undefined, "/customers")).toBe("/customers");
    expect(joinBaseUrl("", "/customers")).toBe("/customers");
  });

  test("a base without a trailing slash concatenates", () => {
    expect(joinBaseUrl("/api", "/customers")).toBe("/api/customers");
  });

  test("a trailing slash on the base does not double", () => {
    expect(joinBaseUrl("/api/", "/customers")).toBe("/api/customers");
  });

  test("a path without a leading slash still gets one separator", () => {
    expect(joinBaseUrl("/api", "customers")).toBe("/api/customers");
    expect(joinBaseUrl("/api/", "customers")).toBe("/api/customers");
  });

  test("an absolute origin is preserved", () => {
    expect(joinBaseUrl("https://api.example.com/v1", "/customers"))
      .toBe("https://api.example.com/v1/customers");
    expect(joinBaseUrl("https://api.example.com/v1/", "/customers"))
      .toBe("https://api.example.com/v1/customers");
  });

  test("the query string rides on the path untouched", () => {
    expect(joinBaseUrl("/api", "/customers?limit=25")).toBe("/api/customers?limit=25");
  });

  test("a bare origin with no path segment still separates", () => {
    expect(joinBaseUrl("https://api.example.com", "/customers"))
      .toBe("https://api.example.com/customers");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client/web/packages/runtime-web && bun test test/join-base-url.test.ts`
Expected: FAIL — cannot resolve `../src/join-base-url.js`.

- [ ] **Step 3: Write minimal implementation**

Create `client/web/packages/runtime-web/src/join-base-url.ts`:

```ts
/**
 * Join a client base URL to a generated entity-relative path.
 *
 * ONE implementation, shared by both client tiers on purpose. `@metaobjectsdev/tanstack`
 * wraps `useEntityFetcher()` with it and `@metaobjectsdev/angular` wraps the
 * `EntityFetcherToken`; implemented separately they would eventually disagree about a
 * trailing slash, and the disagreement would surface as a 404 in one framework only.
 *
 * `baseUrl` is deliberately optional and empty-by-default — a same-origin app mounting
 * routes at the root needs no base, which is also what `meta init` scaffolds
 * (`apiPrefix: ""`). The value may be a path (`/api`) or a full origin
 * (`https://api.example.com/v1`); both are just prefixes to this function.
 */
export function joinBaseUrl(baseUrl: string | undefined, path: string): string {
  if (baseUrl === undefined || baseUrl === "") return path;
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const rest = path.startsWith("/") ? path : `/${path}`;
  return `${base}${rest}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client/web/packages/runtime-web && bun test test/join-base-url.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Export it**

In `client/web/packages/runtime-web/src/index.ts`, add beside the existing fetcher export:

```ts
export { joinBaseUrl } from "./join-base-url.js";
```

- [ ] **Step 6: Verify the package still builds and typechecks**

Run: `cd client/web/packages/runtime-web && bun test && bunx tsc --noEmit -p tsconfig.json`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add client/web/packages/runtime-web/src/join-base-url.ts \
        client/web/packages/runtime-web/src/index.ts \
        client/web/packages/runtime-web/test/join-base-url.test.ts
git commit -m "feat(runtime-web): one join for the client base URL, shared by both tiers"
```

---

### Task 2: The TanStack provider takes `fetcher` + `baseUrl`

**Files:**
- Modify: `client/web/packages/tanstack/src/entity-fetcher.tsx`
- Test: `client/web/packages/tanstack/test/entity-fetcher.test.tsx:1-40`

**Interfaces:**
- Consumes: `joinBaseUrl` from Task 1.
- Produces: `EntityFetcherProviderProps = { fetcher: EntityFetcher; baseUrl?: string; children: ReactNode }`. `useEntityFetcher(): EntityFetcher` returns a fetcher that has already prepended `baseUrl`. Task 5's generated hooks rely on that prepending.

- [ ] **Step 1: Write the failing test**

Replace the body of `client/web/packages/tanstack/test/entity-fetcher.test.tsx` with:

```tsx
import { describe, expect, test } from "bun:test";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { EntityFetcherProvider, useEntityFetcher } from "../src/entity-fetcher.js";

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
    const fetcher = async (p: string) => { seen.push(p); return null; };
    const { result } = renderHook(() => useEntityFetcher(), { wrapper: wrapper(fetcher) });
    await result.current("/customers");
    expect(seen).toEqual(["/customers"]);
  });

  test("baseUrl is prepended before the fetcher sees it", async () => {
    const seen: string[] = [];
    const fetcher = async (p: string) => { seen.push(p); return null; };
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
      return null;
    };
    const { result } = renderHook(() => useEntityFetcher(), {
      wrapper: wrapper(fetcher, "/api"),
    });
    await result.current("/customers", { method: "DELETE" });
    expect(seen).toEqual([{ method: "DELETE" }]);
  });

  test("the wrapped fetcher is referentially stable across renders", () => {
    const fetcher = async () => null;
    const { result, rerender } = renderHook(() => useEntityFetcher(), {
      wrapper: wrapper(fetcher, "/api"),
    });
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });

  test("the nearest provider wins", async () => {
    const seen: string[] = [];
    const outer = async (p: string) => { seen.push(`outer:${p}`); return null; };
    const inner = async (p: string) => { seen.push(`inner:${p}`); return null; };
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

  test("outside a provider it throws", () => {
    expect(() => renderHook(() => useEntityFetcher())).toThrow(/EntityFetcherProvider/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client/web/packages/tanstack && bun test test/entity-fetcher.test.tsx`
Expected: FAIL — `fetcher` is not a known prop; the provider still expects `value`.

- [ ] **Step 3: Write minimal implementation**

Replace `client/web/packages/tanstack/src/entity-fetcher.tsx`:

```tsx
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { joinBaseUrl, type EntityFetcher } from "@metaobjectsdev/runtime-web";

const EntityFetcherContext = createContext<EntityFetcher | null>(null);

export interface EntityFetcherProviderProps {
  /** Transport only. It receives an already-prefixed URL and never learns about routing. */
  fetcher: EntityFetcher;
  /**
   * Where the API lives — a path (`/api`) or a full origin
   * (`https://api.example.com/v1`). OPTIONAL: the default `""` means same-origin at the
   * root, which is what `meta init` scaffolds (`apiPrefix: ""`). Generated hooks emit
   * entity-relative paths, so this is the single place the base is decided — and being
   * runtime rather than baked at `meta gen` is what lets one bundle serve many origins.
   */
  baseUrl?: string;
  children: ReactNode;
}

/** Wrap your app (or admin subtree) to supply a fetcher to generated hooks. */
export function EntityFetcherProvider({ fetcher, baseUrl, children }: EntityFetcherProviderProps) {
  // Memoized so the wrapped identity is stable across renders — an unmemoized wrapper
  // is a new function every render, which churns anything that captures it.
  const value = useMemo<EntityFetcher>(
    () => (<T,>(path: string, init?: RequestInit) =>
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client/web/packages/tanstack && bun test test/entity-fetcher.test.tsx`
Expected: PASS, 6 tests.

- [ ] **Step 5: Run the whole package and typecheck**

Run: `cd client/web/packages/tanstack && bun test && bunx tsc --noEmit -p tsconfig.json`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add client/web/packages/tanstack/src/entity-fetcher.tsx \
        client/web/packages/tanstack/test/entity-fetcher.test.tsx
git commit -m "feat(tanstack)!: the provider owns the base URL, the fetcher stays transport"
```

---

### Task 3: The Angular provider takes `fetcher` + `baseUrl`

**Files:**
- Modify: `client/web/packages/angular/src/entity-fetcher.token.ts`
- Test: `client/web/packages/angular/test/angular-runtime.test.ts`

**Interfaces:**
- Consumes: `joinBaseUrl` from Task 1.
- Produces: `provideEntityFetcher(opts: { fetcher: EntityFetcher; baseUrl?: string }): Provider`. `EntityFetcherToken` yields an already-prefixed fetcher, which Task 6's generated services rely on.

- [ ] **Step 1: Write the failing test**

Add to `client/web/packages/angular/test/angular-runtime.test.ts`:

```ts
import { joinBaseUrl } from "@metaobjectsdev/runtime-web";
import { EntityFetcherToken, provideEntityFetcher } from "../src/entity-fetcher.token.js";

describe("provideEntityFetcher", () => {
  test("supplies a fetcher bound to baseUrl on the token", async () => {
    const seen: string[] = [];
    const fetcher = async (p: string) => { seen.push(p); return null as never; };
    const provider = provideEntityFetcher({ fetcher, baseUrl: "/api" }) as {
      provide: unknown; useValue: (p: string) => Promise<unknown>;
    };
    expect(provider.provide).toBe(EntityFetcherToken);
    await provider.useValue("/customers");
    expect(seen).toEqual(["/api/customers"]);
  });

  test("omitting baseUrl leaves the path unchanged", async () => {
    const seen: string[] = [];
    const fetcher = async (p: string) => { seen.push(p); return null as never; };
    const provider = provideEntityFetcher({ fetcher }) as {
      useValue: (p: string) => Promise<unknown>;
    };
    await provider.useValue("/customers");
    expect(seen).toEqual(["/customers"]);
  });

  test("it agrees with the shared join helper", () => {
    expect(joinBaseUrl("/api/", "customers")).toBe("/api/customers");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client/web/packages/angular && bun test test/angular-runtime.test.ts`
Expected: FAIL — `provideEntityFetcher` takes a bare function, so `{ fetcher, baseUrl }` is not callable / does not prefix.

- [ ] **Step 3: Write minimal implementation**

Replace the `provideEntityFetcher` half of `client/web/packages/angular/src/entity-fetcher.token.ts`:

```ts
export interface EntityFetcherOptions {
  /** Transport only. It receives an already-prefixed URL. */
  fetcher: EntityFetcher;
  /**
   * Where the API lives — a path (`/api`) or a full origin. OPTIONAL, default `""`
   * (same-origin at the root). Mirrors React's `<EntityFetcherProvider baseUrl>`; an
   * absolute origin is also what makes an SSR pass work, since a relative URL has no
   * origin to resolve against on the server.
   */
  baseUrl?: string;
}

/**
 * Supplies an `EntityFetcher` for the entire application, bound to `baseUrl`.
 * Mirrors React's `<EntityFetcherProvider fetcher={...} baseUrl={...} />`.
 */
export function provideEntityFetcher({ fetcher, baseUrl }: EntityFetcherOptions): Provider {
  const bound = (<T,>(path: string, init?: RequestInit) =>
    fetcher<T>(joinBaseUrl(baseUrl, path), init)) as EntityFetcher;
  return { provide: EntityFetcherToken, useValue: bound };
}
```

Add the import at the top: `import { joinBaseUrl } from "@metaobjectsdev/runtime-web";` and export the new type from `client/web/packages/angular/src/index.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client/web/packages/angular && bun test && bunx tsc --noEmit -p tsconfig.json`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/web/packages/angular/src/entity-fetcher.token.ts \
        client/web/packages/angular/src/index.ts \
        client/web/packages/angular/test/angular-runtime.test.ts
git commit -m "feat(angular)!: provideEntityFetcher takes { fetcher, baseUrl }"
```

---

### Task 4: `$apiPrefix` leaves the entity descriptor

**Files:**
- Modify: `server/typescript/packages/codegen-ts/src/templates/entity-constants.ts:88-123`
- Modify: `server/typescript/packages/codegen-ts/src/templates/entity-meta-file.ts:38-48`
- Test: `server/typescript/packages/codegen-ts/test/` (new assertion + golden refresh)

**Interfaces:**
- Consumes: nothing.
- Produces: a `<Entity>` const with keys `$entity`, `$table`, `$path` and the per-field entries — no `$apiPrefix`. Tasks 5 and 6 depend on its absence.

- [ ] **Step 1: Write the failing test**

Create `server/typescript/packages/codegen-ts/test/entity-constants-no-api-prefix.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { renderEntityConstants } from "../src/templates/entity-constants.js";
import { loadFixtureObject } from "./helpers/load-fixture.js"; // existing helper

describe("the entity descriptor carries no API prefix", () => {
  test("$apiPrefix is absent even when a prefix is passed", async () => {
    const obj = await loadFixtureObject("Subscriber");
    expect(renderEntityConstants(obj, "/api").toString()).not.toContain("$apiPrefix");
  });

  test("the metadata-derived members are still there", async () => {
    const obj = await loadFixtureObject("Subscriber");
    const out = renderEntityConstants(obj, "/api").toString();
    expect(out).toContain("$entity");
    expect(out).toContain("$table");
    expect(out).toContain("$path");
  });
});
```

If `loadFixtureObject` does not exist under that name, use whichever helper the sibling
tests in `codegen-ts/test/` already use to load a fixture object — do not add a new one.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server/typescript/packages/codegen-ts && bun test test/entity-constants-no-api-prefix.test.ts`
Expected: FAIL — output still contains `$apiPrefix`.

- [ ] **Step 3: Write minimal implementation**

In `entity-constants.ts`, delete the `$apiPrefix` line from the `joinCode` body (line 119):

```diff
       code`  $path: ${JSON.stringify(path)}`,
-      code`  $apiPrefix: ${JSON.stringify(apiPrefix)}`,
       ...fieldEntries.map((e) => code`${e}`),
```

Then mark the now-unused parameter, keeping it in place:

```ts
export function renderEntityConstants(
  obj: MetaObject,
  /**
   * @deprecated Accepted and IGNORED since the base URL moved to the client provider.
   * It must stay in the signature: `src/reference/entity.ts` is copied verbatim into
   * adopter repos (ADR-0034) and calls this positionally, so removing the parameter
   * would fail to compile in every ejected copy. Removal is a separate later break.
   */
  _apiPrefix = "",
  names?: { readonly name: string; readonly symbol: Code } | undefined,
): Code {
```

Apply the identical `@deprecated` treatment to `renderEntityMetaFile`'s second parameter
in `entity-meta-file.ts`, and stop forwarding it to `renderEntityConstants`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server/typescript/packages/codegen-ts && bun test test/entity-constants-no-api-prefix.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Refresh the goldens and READ the diff**

Run: `cd server/typescript/packages/codegen-ts && bun test`
Expected: golden snapshot failures across `test/golden/__snapshots__/{postgres,sqlite,package}/`.

Update them the way this package already does (its snapshot-update flag), then **read the
diff**: every changed line must be a removed `$apiPrefix:` line and nothing else. A changed
`$table`, `$path` or field entry means something beyond this task moved — stop and
investigate rather than accepting the snapshot.

- [ ] **Step 6: Run the package suite and typecheck**

Run: `cd server/typescript/packages/codegen-ts && bun test && bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/typescript/packages/codegen-ts/src/templates/entity-constants.ts \
        server/typescript/packages/codegen-ts/src/templates/entity-meta-file.ts \
        server/typescript/packages/codegen-ts/test/
git commit -m "feat(codegen-ts)!: the entity descriptor stops carrying the API prefix"
```

---

### Task 5: TanStack templates emit entity-relative paths

**Files:**
- Modify: `server/typescript/packages/codegen-ts-tanstack/src/templates/hooks-file.ts` (15 sites: 147, 209, 222, 290, 303, 318, 337, 356, 445, 458, 470, 480, 492, 522, 541)
- Modify: `server/typescript/packages/codegen-ts-tanstack/src/templates/grid-hook-file.ts:141`
- Test: `server/typescript/packages/codegen-ts-tanstack/test/{tanstack-query,tanstack-query-m2m,projection-hooks}.test.ts`, `test/golden/__snapshots__/`

**Interfaces:**
- Consumes: the Task 4 descriptor (no `$apiPrefix`), the Task 2 provider (prepends `baseUrl`).
- Produces: generated hook files whose URLs start at `${<Entity>.$path}`.

- [ ] **Step 1: Write the failing test**

Add to `server/typescript/packages/codegen-ts-tanstack/test/tanstack-query.test.ts`:

```ts
test("generated hooks emit entity-relative paths, never a baked prefix", async () => {
  const out = await renderHooksFileForFixture("Subscriber"); // the helper this file already uses
  expect(out).not.toContain("$apiPrefix");
  expect(out).toContain("${Subscriber.$path}");
});
```

Use the same fixture-rendering helper the surrounding tests in that file already call —
do not introduce a new one.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server/typescript/packages/codegen-ts-tanstack && bun test test/tanstack-query.test.ts`
Expected: FAIL — output still contains `$apiPrefix`.

- [ ] **Step 3: Write minimal implementation**

At all 16 sites, drop the prefix interpolation. Every occurrence is the same shape:

```diff
-\`\${${entityName}.$apiPrefix}\${${entityName}.$path}/\${id}\`
+\`\${${entityName}.$path}/\${id}\`
```

and the TPH variants likewise use `${baseName}.$path` alone. Update the prose comment at
`hooks-file.ts:404` — it says the const is imported "for $path/$apiPrefix" — to name
`$path` only.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server/typescript/packages/codegen-ts-tanstack && bun test test/tanstack-query.test.ts`
Expected: PASS.

- [ ] **Step 5: Refresh goldens and READ the diff**

Run: `cd server/typescript/packages/codegen-ts-tanstack && bun test`
Expected: failures in `test/golden/__snapshots__/{single-entity,multi-grid,grid-filter}/`.
Update, then read the diff — every change must be a dropped `${X.$apiPrefix}`.

- [ ] **Step 6: Verify no site was missed**

Run: `cd <repo-root> && git grep -c 'apiPrefix' -- server/typescript/packages/codegen-ts-tanstack/src`
Expected: only `ctx.renderContext.apiPrefix` forwarding into `renderEntityMetaFile` remains
(4 lines across `reference/` and the two generators). Zero `.$apiPrefix`.

- [ ] **Step 7: Commit**

```bash
git add server/typescript/packages/codegen-ts-tanstack/
git commit -m "feat(codegen-ts-tanstack)!: hooks and grid hooks emit entity-relative paths"
```

---

### Task 6: Angular service template emits entity-relative paths

**Files:**
- Modify: `server/typescript/packages/codegen-ts-angular/src/templates/service-file.ts` (5 sites: 71, 75, 79, 87, 95)
- Test: the package's existing service-file test

**Interfaces:**
- Consumes: the Task 4 descriptor, the Task 3 provider.
- Produces: generated `<Entity>Service` methods whose URLs start at `${<Entity>.$path}`.

- [ ] **Step 1: Write the failing test**

Add to the package's existing service-file test:

```ts
test("the generated service emits entity-relative paths", async () => {
  const out = await renderServiceFileForFixture("Subscriber"); // the helper the file already uses
  expect(out).not.toContain("$apiPrefix");
  expect(out).toContain("${Subscriber.$path}");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server/typescript/packages/codegen-ts-angular && bun test`
Expected: FAIL — output still contains `$apiPrefix`.

- [ ] **Step 3: Write minimal implementation**

Same edit as Task 5 at all five sites:

```diff
-\`\${${entityName}.$apiPrefix}\${${entityName}.$path}\${qs}\`
+\`\${${entityName}.$path}\${qs}\`
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server/typescript/packages/codegen-ts-angular && bun test && bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/typescript/packages/codegen-ts-angular/
git commit -m "feat(codegen-ts-angular)!: the generated service emits entity-relative paths"
```

---

### Task 7: A one-shot `meta gen` note for projects that had a prefix

**Files:**
- Modify: `server/typescript/packages/codegen-ts/src/runner.ts:157-178`
- Test: `server/typescript/packages/codegen-ts/test/runner-base-url-note.test.ts`

**Interfaces:**
- Consumes: the existing `recordedEngine` / `installedEngine` values already computed at `runner.ts:166-168` for the #232 stamp.
- Produces: an entry in `RunGenResult.warnings`.

**Why it is keyed on the engine stamp.** `data-grid-gate.ts:25-31` records that a
`timestampMode` warning was *deleted from `runner.ts`* for firing forever — a note keyed
only on `apiPrefix !== ""` would repeat exactly that. Keying it on "the recorded engine
predates the release that removed `$apiPrefix`" makes it fire once, on the first regen
after the upgrade, and never again.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { shouldNoteBaseUrlMove } from "../src/runner.js";

describe("the base-URL migration note", () => {
  test("fires once for a project upgrading from before the move", () => {
    expect(shouldNoteBaseUrlMove("/api", "0.24.5", "0.25.0")).toBe(true);
  });
  test("stays quiet once the project has regenerated", () => {
    expect(shouldNoteBaseUrlMove("/api", "0.25.0", "0.25.0")).toBe(false);
  });
  test("stays quiet for a project with no prefix", () => {
    expect(shouldNoteBaseUrlMove("", "0.24.5", "0.25.0")).toBe(false);
  });
  test("stays quiet for a fresh project with no recorded engine", () => {
    // Silence is the safe default here, unlike the 0.24.5 agent-context nudge: a project
    // with no history has nothing to migrate, and a false nag is the cry-wolf failure
    // that got the timestampMode warning deleted.
    expect(shouldNoteBaseUrlMove("/api", undefined, "0.25.0")).toBe(false);
  });
  test("stays quiet when a version is not orderable as N.N.N", () => {
    expect(shouldNoteBaseUrlMove("/api", "0.25.0-rc.1", "0.25.0")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server/typescript/packages/codegen-ts && bun test test/runner-base-url-note.test.ts`
Expected: FAIL — `shouldNoteBaseUrlMove` is not exported.

- [ ] **Step 3: Write minimal implementation**

In `runner.ts`, beside `engineVersion()`:

```ts
/** The release in which `$apiPrefix` left the entity descriptor. */
const BASE_URL_MOVE_VERSION = "0.25.0";

function orderable(v: string | undefined): [number, number, number] | undefined {
  if (v === undefined) return undefined;
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

/**
 * Exported for test. True exactly on the FIRST gen after upgrading past the release that
 * moved the base URL, and only for a project that actually had a prefix to move.
 */
export function shouldNoteBaseUrlMove(
  apiPrefix: string,
  recordedEngine: string | undefined,
  moveVersion: string = BASE_URL_MOVE_VERSION,
): boolean {
  if (apiPrefix === "") return false;
  const was = orderable(recordedEngine);
  const move = orderable(moveVersion);
  if (was === undefined || move === undefined) return false;
  for (let i = 0; i < 3; i++) {
    if (was[i] !== move[i]) return was[i] < move[i];
  }
  return false;
}
```

Then, immediately after the existing #232 warning block:

```ts
if (shouldNoteBaseUrlMove(config.apiPrefix, recordedEngine)) {
  warnings.push(
    `apiPrefix ${JSON.stringify(config.apiPrefix)} no longer reaches the client — ` +
      `generated hooks now emit entity-relative paths. Pass it once at the provider: ` +
      `<EntityFetcherProvider fetcher={...} baseUrl=${JSON.stringify(config.apiPrefix)}>. ` +
      `Server routes are unaffected. ` +
      `See docs/features/migrations/api-base-url-leaves-the-entity-descriptor.md`,
  );
}
```

Read the resolved config value the way the surrounding code already does; if `apiPrefix`
is not in scope at that point, take it from the same place the render context does rather
than re-resolving it.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server/typescript/packages/codegen-ts && bun test test/runner-base-url-note.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Run the package suite**

Run: `cd server/typescript/packages/codegen-ts && bun test && bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/typescript/packages/codegen-ts/src/runner.ts \
        server/typescript/packages/codegen-ts/test/runner-base-url-note.test.ts
git commit -m "feat(codegen-ts): a one-shot note for projects whose prefix stopped reaching the client"
```

---

### Task 8: Sweep every shipped artifact, and gate the sweep

**Files:**
- Modify: `docs/features/api-contract.md` (URL-grammar table + the §`apiPrefix` policy block)
- Modify: `docs/ports/typescript-client.md`, `docs/recipes/csharp-angular18.md`
- Modify: `client/web/packages/tanstack/README.md`, `client/web/packages/angular/README.md`
- Modify: `agent-context/skills/metaobjects-runtime-ui/SKILL.md` and `references/{react,tanstack,typescript}.md`
- Modify: `agent-context/skills/metaobjects-codegen/references/typescript.md`
- Modify: `agent-context/skills/metaobjects-audit/references/capability-checklist.md`
- Modify: `examples/advanced-modeling/src/generated/{Author,Lesson,Program,ProgramSummary,Purchase}.ts`
- Modify: `examples/showcase/generated/ts/Subscriber.ts`
- Create: `docs/features/migrations/api-base-url-leaves-the-entity-descriptor.md`
- Create: `scripts/check-no-api-prefix.ts`
- Modify: `scripts/ci-local.sh` (register the gate in the `gates` lane)
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: everything above.
- Produces: a gate that fails if `$apiPrefix` reappears in any shipped artifact.

**Why the gate ships with the sweep, not after.** `gate_doc_examples` checks that shipped
*metadata* examples still load; nothing checks generated TypeScript or prose. Issue #337
is the record of that gap being found three separate times by an adopter and never by a
lane. Sweeping without gating means the next reintroduction is silent.

- [ ] **Step 1: Write the failing gate**

Create `scripts/check-no-api-prefix.ts`:

```ts
/**
 * `$apiPrefix` left the generated entity descriptor. Nothing shipped may still teach it.
 *
 * This exists because `gate_doc_examples` proves shipped METADATA still loads and says
 * nothing about generated TypeScript or prose — the gap #337 records an adopter finding
 * three separate times. Docs under `docs/superpowers/` are exempt: specs and plans are
 * dated records of what was decided, and rewriting history to satisfy a gate is how a
 * record stops being one.
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const ROOTS = ["docs", "agent-context", "examples", "client", "server"];
const EXEMPT = /^docs\/superpowers\/|^docs\/llms\/|^CHANGELOG\.md$/;

const files = execFileSync("git", ["ls-files", ...ROOTS], { encoding: "utf8" })
  .split("\n").filter((f) => f !== "" && !EXEMPT.test(f));

const hits = files.filter((f) => {
  try { return readFileSync(f, "utf8").includes("$apiPrefix"); } catch { return false; }
});

if (hits.length > 0) {
  console.error(`$apiPrefix is retired but still appears in ${hits.length} file(s):`);
  for (const h of hits) console.error(`  ${h}`);
  process.exit(1);
}
console.log(`ok — no $apiPrefix in ${files.length} shipped files`);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd <repo-root> && bun scripts/check-no-api-prefix.ts`
Expected: FAIL, listing the docs, skills and committed example output still carrying it.

- [ ] **Step 3: Sweep the prose**

In `docs/features/api-contract.md`, the §`apiPrefix` policy block currently states the
prefix is "baked into the generated entity-constants file as `$apiPrefix`, so the client
and server agree on it without runtime configuration". That sentence is now false — replace
it with: `apiPrefix` mounts the **server** routes; the client's base is `baseUrl` on the
provider, supplied at runtime. Keep the URL-grammar table (the wire contract is unchanged)
but stop attributing the prefix to the client artifact.

Update both client READMEs and the five `agent-context/skills/` files to the
`<EntityFetcherProvider fetcher={...} baseUrl="/api">` form.

- [ ] **Step 4: Regenerate the committed example output**

Regenerate `examples/advanced-modeling` and `examples/showcase` with the local build rather
than hand-editing, so the committed output is genuinely what this codegen emits. Read the
diff: only `$apiPrefix` lines and the hook URLs may change.

- [ ] **Step 5: Write the migration guide**

Create `docs/features/migrations/api-base-url-leaves-the-entity-descriptor.md` covering:
the one-line provider diff; that `value` → `fetcher` is a compile error by design; that
`baseUrl` is optional and `""` is correct for a same-origin root mount; that `apiPrefix`
stays in config and still mounts the server routes; and that hand-written code reading
`<Entity>.$apiPrefix` must take the base from its own config instead.

- [ ] **Step 6: Run the gate to verify it passes**

Run: `cd <repo-root> && bun scripts/check-no-api-prefix.ts`
Expected: `ok — no $apiPrefix in N shipped files`.

- [ ] **Step 7: Register the gate**

In `scripts/ci-local.sh`, beside the other `gates`-lane entries (near line 563):

```bash
gate_no_api_prefix() { bun scripts/check-no-api-prefix.ts; }
```
and its `step_if bun "no retired \$apiPrefix" gate_no_api_prefix` line in the `gates` block.

Verify `scripts/` still typechecks — no package tsconfig covers it, so it is easy to break:

Run: `cd <repo-root> && bunx tsc --noEmit scripts/check-no-api-prefix.ts`
Expected: clean.

- [ ] **Step 8: Write the CHANGELOG entry**

Add a `0.25.0` entry leading with the breaking client change, the one-line migration, and
the reason the base moved (a deployment fact the generator was freezing). Link the
migration guide.

- [ ] **Step 9: Commit**

```bash
git add docs/ agent-context/ examples/ client/web/packages/*/README.md \
        scripts/check-no-api-prefix.ts scripts/ci-local.sh CHANGELOG.md
git commit -m "docs: the API base URL moves to the provider, and a gate that keeps it there"
```

---

### Task 9: Prove it end to end

**Files:** none — verification only.

- [ ] **Step 1: Workspace build + typecheck**

Run: `cd <repo-root> && bun run --filter '*' build && bun run --filter '*' typecheck`
Expected: PASS. This is the gate a `bun test` run cannot give you — Bun transpiles per file
and does not typecheck, so a type-broken provider ships green on the suites above.

- [ ] **Step 2: Server + client suites**

Run: `cd server/typescript && bun test`, then each touched `client/web/packages/*` package.
Expected: PASS.

- [ ] **Step 3: The gates lane**

Run: `cd <repo-root> && bash scripts/ci-local.sh --only gates`
Expected: PASS, including the new gate and `check-metamodel-version.mjs` reporting no
classified difference (`metamodelVersion` must still read `0.14`).

Do not pipe this through `tail` — the exit status you would read is `tail`'s.

- [ ] **Step 4: Prove the gate by breaking it**

Reintroduce `$apiPrefix` into one shipped doc, run `bun scripts/check-no-api-prefix.ts`,
confirm it exits 1 and names that file, then revert. A gate never seen to fail is the same
artefact as no gate.

- [ ] **Step 5: Confirm nothing unrelated moved**

Run: `git diff --stat origin/main..HEAD -- fixtures/`
Expected: empty. This change touches no fixture and no conformance corpus; anything here
means scope leaked.

## Self-Review

**Spec coverage.** Entity-relative paths → Tasks 4, 5, 6. Provider owns the base → Tasks 2,
3. `baseUrl` optional and so spelled → Global Constraints, Tasks 2, 3. Shared join helper →
Task 1. `apiPrefix` stays in config → Global Constraints, verified in Task 8's prose sweep.
ADR-0034 parameter retention → Task 4 Step 3. Migration guide → Task 8 Step 5. The one-shot
note → Task 7. Gates: goldens → Tasks 4, 5; join semantics → Task 1; the repo-wide
assertion → Task 8. Versioning → Task 8 Step 8, Task 9 Step 3. Non-goals carry no task by
design.

**Type consistency.** `joinBaseUrl(baseUrl: string | undefined, path: string): string` is
defined in Task 1 and consumed with that exact signature in Tasks 2 and 3.
`shouldNoteBaseUrlMove(apiPrefix, recordedEngine, moveVersion?)` is defined and used only in
Task 7. `EntityFetcherProviderProps` (Task 2) and `EntityFetcherOptions` (Task 3) are
deliberately different names — one is React props including `children`, the other is not.

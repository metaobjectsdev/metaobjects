# The API base URL leaves the entity descriptor

**Status:** designed, not implemented. Targets `0.25.0` (npm), alongside the
`<Node>Names` traversal.

## Problem

`apiPrefix` is an application setting. It originates as `config.apiPrefix` in
`metaobjects.config.ts` and describes where the app's routes are mounted.

The generated server routes bake it as a literal — `{ prefix: "/api" }` in
`routes-file.ts:106` — and that is the correct form. A route mount is fixed at
build time by construction: the code that registers `/api/authors` *is* the
server.

The client tier copies it. `renderEntityConstants` (`entity-constants.ts:119`)
stamps `$apiPrefix` into every generated `<Entity>` const, and
`renderEntityMetaFile` copies that whole const into every `<Entity>.meta.ts`.
Twenty-one sites across three templates then read it back to build a URL:

| Template | Sites |
|---|---|
| `codegen-ts-tanstack/src/templates/hooks-file.ts` | 15 |
| `codegen-ts-angular/src/templates/service-file.ts` | 5 |
| `codegen-ts-tanstack/src/templates/grid-hook-file.ts` | 1 |

Two things are wrong with this, and they are different sizes.

The small one is duplication: one application setting stamped into N entity
descriptors. It cannot *drift* — every copy is written from one config value in
one run — so this is ugly rather than dangerous.

The large one is that **the browser's base URL is a deployment fact, and codegen
freezes it at generation time.** A client bundle cannot be built once and served
against a different origin: a separate API host, a dev proxy, a preview
environment, an Angular SSR pass that needs an absolute URL. Today the only way
to change where the client points is to re-run `meta gen`.

This was recorded as deferred in
[`2026-09-06-generic-names-traversal-design.md`](2026-09-06-generic-names-traversal-design.md)
§237-243 and is now un-deferred.

## Prior art

Every comparable tool separates the two: **generated per-operation artifacts
carry only the relative path, and the base URL is runtime client configuration
supplied once.**

| Tool | Where the base lives |
|---|---|
| [openapi-fetch](https://openapi-ts.dev/openapi-fetch/) | `createClient({ baseUrl, fetch })`; `baseUrl` may be a function evaluated per request |
| [Hey API](https://heyapi.dev/openapi-ts/clients/fetch) | `client.setConfig({ baseUrl })` |
| [Orval](https://orval.dev/docs/guides/set-base-url/) | a documented custom-base-URL seam, not baked per operation |
| [NSwag (Angular)](https://github.com/RicoSuter/NSwag/issues/395) | an `API_BASE_URL` `InjectionToken` injected into the generated service |
| Apollo | `new ApolloClient({ uri })` — generated hooks carry the document, never a URL |
| tRPC | `httpBatchLink({ url, fetch })` |
| RTK Query | `fetchBaseQuery({ baseUrl })` |
| axios | `axios.create({ baseURL })` |

Three rulings follow from this table rather than from taste:

1. **The base is client configuration, not generated output.** Baking it into
   each generated operation is what no one else does; `$apiPrefix` on the entity
   descriptor is the outlier. This is why the fix removes it rather than merely
   de-duplicating it into one emitted constant — one baked copy is tidier than
   twenty-one and still the wrong shape.
2. **The base is a named option beside the transport, not hidden inside it.**
   openapi-fetch takes `baseUrl` *and* `fetch`; tRPC takes `url` *and* `fetch`.
   So the base belongs on the provider, and the app's fetcher stays a pure
   transport that never learns about routing.
3. **It is optional and defaults to same-origin.** NSwag is explicit: with no
   `API_BASE_URL` provider the token yields the empty string, and calls go to the
   origin hosting the app. A *required* option would be migration ergonomics
   leaking into a permanent API — and would contradict this repo's own default,
   since `meta init` scaffolds `apiPrefix: ""` (`init.ts:131`).

## Design

### Generated client artifacts emit entity-relative paths

All 21 sites drop `${<Entity>.$apiPrefix}` and emit `${<Entity>.$path}…` alone.
`$apiPrefix` is deleted from `renderEntityConstants`, so it leaves both
`<Entity>.ts` and `<Entity>.meta.ts`.

`$entity`, `$table` and `$path` stay. Those are derived from metadata — `$path`
is the address the object is served at, including the TPH segment. The prefix
never was metadata: zero occurrences in `expected-registry.json` and none in any
`spec/metamodel/*.json`.

### The base moves to the provider

```tsx
// before
<EntityFetcherProvider value={fetcher}>
// after
<EntityFetcherProvider fetcher={fetcher} baseUrl="/api">
```

`baseUrl` is **optional and defaults to `""`** (§Prior art 3), which is the
correct behaviour for a same-origin app and matches `apiPrefix`'s own scaffolded
default. `useEntityFetcher()` returns the fetcher already wrapped to prepend it,
memoized on `[fetcher, baseUrl]` so the identity is stable across renders.

Angular mirrors it: `provideEntityFetcher({ fetcher, baseUrl })`, wrapping at the
`EntityFetcherToken` seam. Both tiers take the fetcher from exactly one place —
`useEntityFetcher()` and `inject(EntityFetcherToken)` — so the base is applied
once per tier rather than at 21 call sites.

**`value` → `fetcher` is a rename on its own merits.** Once the provider takes
two things, `value` names nothing. That it also makes every unmigrated app fail
`tsc` is the point of §Migration, but it is not the reason for the rename; the
API is not distorted to produce a break.

**The name is `baseUrl`, not `basePath`.** It is the dominant spelling
(openapi-fetch, Hey API, RTK Query; axios's `baseURL`) and the honest one, since
the value may be a full origin and not merely a path.

### Joining is one shared helper

`baseUrl` + `$path` must survive a trailing slash (`"/api/"` + `"/customers"`
must not yield `/api//customers`), an empty base, and an absolute origin
(`https://api.example.com/v1`). That join lives in **`runtime-web`** as one
tested helper consumed by both tiers. Implemented separately in `tanstack` and
`angular` they will eventually disagree about a slash.

### `apiPrefix` stays in `metaobjects.config.ts`

It still drives the server routes mount and the documented addresses in
`agent-ui-page.ts` / api-docs. It simply stops flowing to the client tier. The
config key is not renamed: it correctly names the server mount prefix, which is
what it now exclusively means.

## Migration

One mechanical line:

```diff
-<EntityFetcherProvider value={fetcher}>
+<EntityFetcherProvider fetcher={fetcher} baseUrl="/api">   // whatever apiPrefix said
```

`value` is gone, so an unmigrated app fails to compile rather than 404ing in a
browser. Code hand-reading `<Entity>.$apiPrefix` also fails to compile — the
property no longer exists.

Guide: `docs/features/migrations/api-base-url-leaves-the-entity-descriptor.md`.

**The one silent case, and its answer.** An adopter who renames the prop but
omits `baseUrl` gets `""` and 404s. `meta gen` therefore emits a single
self-extinguishing warning whenever `apiPrefix !== ""`, naming the value to pass
— the idiom the 0.21.4 grid-discoverability warning established. Projects on the
scaffolded default see nothing, because for them `""` is already correct.

## Gates

- **Goldens.** `codegen-ts/test/golden/__snapshots__/` (postgres, sqlite,
  package) and the three `codegen-ts-tanstack` grid snapshots.
- **Existing suites.** `projection-hooks`, `tanstack-query-m2m`,
  `tanstack-query`, `client/web/packages/tanstack/test/entity-fetcher.test.tsx`,
  `client/web/packages/angular/test/angular-runtime.test.ts`.
- **New: join semantics.** Trailing slash, leading slash, both, neither, empty
  base, absolute origin. In `runtime-web`, where the helper lives.
- **New: a repo-wide `$apiPrefix` assertion.** No committed artifact under
  `docs/`, `agent-context/` or `examples/` may contain `$apiPrefix`.

  This one exists because of a measured gap, not for symmetry. `gate_doc_examples`
  checks that shipped *metadata* examples still load; nothing checks generated
  TypeScript or prose. A stale `$apiPrefix` in a recipe, a skill, or
  `examples/advanced-modeling/src/generated/` would survive every lane — which is
  precisely the failure [#337](https://github.com/metaobjectsdev/metaobjects/issues/337)
  was written about, where three separate times an adopter, never a gate, found a
  doc teaching a shape the tool had retired. The removal becomes enforceable
  instead of a one-time sweep.

## Versioning and release

- Breaking client-tier API → npm **`0.25.0`**, the cut `<Node>Names` is already
  headed for. Folding it in there is what keeps adopters at one migration rather
  than two.
- **`metamodelVersion` stays `0.14`.** Nothing registered changes.
- Under publish-what-changed this alone is npm-only. All four registries publish
  at `0.25.0` because `<Node>Names` is five-port — not because of this change.
- The Angular tier is source-only (ADR-0048), so its API change reaches no npm
  adopter.

## Non-goals

Recorded so they are not re-proposed.

- **A `baseUrl` that accepts a function.** openapi-fetch has one. Additive later
  — a `string | (() => string)` widening breaks no caller — so not now.
- **Emitting `apiBasePath` into the barrel** as a default the adopter imports.
  This is OpenAPI's `servers:` shape (a baked default, runtime-overridable) and
  it does not transfer: OpenAPI has one `Configuration` object to hold the
  default, whereas this codegen emits N hook modules and the single configuration
  point is the provider — which lives in `@metaobjectsdev/tanstack` and cannot
  see `metaobjects.config.ts`. Making it work means generated client code
  importing a baked constant again, which is the anomaly being removed.
- **Removing the `apiPrefix` parameter from `renderEntityConstants` /
  `renderEntityMetaFile`.** ADR-0034 ejected copies pass it positionally — a
  known adopter does exactly this today. It stays accepted, ignored and
  `@deprecated`; removing it is a separate later break.
- **Renaming the `apiPrefix` config key.** It now means exactly one thing, which
  is what it says.

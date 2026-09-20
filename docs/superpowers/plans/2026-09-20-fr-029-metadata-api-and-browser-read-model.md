# FR-029 — Metadata API (`GET /_meta`) + browser read-model — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve a loaded model as effective canonical JSON at `GET {apiPrefix}/_meta` in all five ports, and read it in the browser into a model the already-shipped `buildGrid()` can walk.

**Architecture:** UI-1 is a contract plus a one-line framework-free helper per port (`metaJson(root)`), with an HTTP mount only in TypeScript — the only port with a web-bound runtime home. UI-2 is a slim structural read-model in `runtime-web`, **not** the metadata loader compiled to the browser, because that loader's root barrel transitively imports `node:url` and cannot be bundled (#287).

**Tech Stack:** TypeScript (Bun test, Fastify, Hono), C# (xUnit), Java (JUnit, Maven), Kotlin (JVM, via the Java facade), Python (pytest).

**Spec:** `docs/superpowers/specs/2026-09-20-fr-029-metadata-api-and-browser-read-model-design.md`

## Global Constraints

- **Route path is exactly `/_meta`**, mounted under the host's `apiPrefix`. It is a cross-port contract; do not rename it per port.
- **The response body is the EFFECTIVE canonical serialization** (`canonicalSerializeEffective` and its per-port twins), never the raw one. Spec §3.2.
- **`runtime-web` may import VALUES only from `@metaobjectsdev/metadata/constants`.** Types may come from the package root — `import type` is erased at build time. A value import from the root reintroduces #287 and fails `browser-bundleable.test.ts`.
- **Effective output still emits `extends` on every node**, with inherited members already inlined beside it. Consumers must **ignore** `extends`; resolving it would double-count members.
- **ADR-0039:** any metadata read added by this plan uses the resolving accessors (`attr()`, `children()`, `fields()`, `views()`), never an `own*()` variant.
- **No `any`.** Use `unknown` and narrow (repo TS discipline).
- **Named constants for metamodel strings** — no inline `"field"` / `"object"` literals.
- Run `cd server/typescript && bun test` scoped per package. **Never** a bare `bun test` at the repo root.

## File Structure

| File | Responsibility |
|---|---|
| `server/typescript/packages/metadata/src/index.ts` | **Modify** — barrel-export `canonicalSerializeEffective` (currently unexported) |
| `server/typescript/packages/runtime-ts/src/meta-endpoint.ts` | **Create** — `META_ROUTE_PATH` + `metaJson(root)`; framework-free |
| `server/typescript/packages/runtime-ts/src/fastify/index.ts` | **Modify** — `mountMetaRoute` |
| `server/typescript/packages/runtime-ts/src/hono/index.ts` | **Modify** — `mountMetaRouteHono` |
| `client/web/packages/runtime-web/src/meta-read.ts` | **Create** — the narrow read surface (types only) |
| `client/web/packages/runtime-web/src/load-meta-model.ts` | **Create** — canonical JSON → `MetaRead` tree |
| `client/web/packages/runtime-web/src/grid-from-metadata.ts` | **Modify** — widen `buildGrid` from `MetaObject` to `MetaRead` |
| `server/csharp/MetaObjects/MetaEndpoint.cs` | **Create** — C# helper |
| `server/java/metadata/.../io/json/MetaEndpoint.java` | **Create** — Java helper (Kotlin consumes it) |
| `server/python/src/metaobjects/meta_endpoint.py` | **Create** — Python helper |
| `docs/features/metadata-api.md` | **Create** — the contract, documented once |

---

### Task 1: Export the effective serializer and define the TS contract

**Files:**
- Modify: `server/typescript/packages/metadata/src/index.ts:243`
- Create: `server/typescript/packages/runtime-ts/src/meta-endpoint.ts`
- Modify: `server/typescript/packages/runtime-ts/src/index.ts`
- Test: `server/typescript/packages/runtime-ts/test/meta-endpoint.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `META_ROUTE_PATH: "/_meta"`, `metaJson(root: MetaData): string`.

**Context:** `canonicalSerializeEffective` exists at `metadata/src/serializer-json.ts:190` but is **not** in the public barrel — line 243 exports its siblings and omits it. Its only current consumer reaches it by deep relative import from inside the package's own tests. Export it first.

- [ ] **Step 1: Write the failing test**

```ts
// server/typescript/packages/runtime-ts/test/meta-endpoint.test.ts
import { describe, test, expect } from "bun:test";
import { canonicalSerializeEffective } from "@metaobjectsdev/metadata";
import { META_ROUTE_PATH, metaJson } from "../src/meta-endpoint.js";
import { loadTestModel } from "./helpers/load-test-model.js";

describe("meta-endpoint", () => {
  test("the route path is the cross-port contract value", () => {
    expect(META_ROUTE_PATH).toBe("/_meta");
  });

  test("metaJson returns the EFFECTIVE canonical serialization", async () => {
    const root = await loadTestModel();
    expect(metaJson(root)).toBe(canonicalSerializeEffective(root));
  });

  test("metaJson inlines a member inherited via extends", async () => {
    const root = await loadTestModel();
    // The effective form materializes the super-chain merge, so an inherited
    // field appears in the child's own children array.
    const parsed = JSON.parse(metaJson(root)) as Record<string, unknown>;
    expect(JSON.stringify(parsed)).toContain("createdAt");
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd server/typescript/packages/runtime-ts && bun test test/meta-endpoint.test.ts`
Expected: FAIL — `canonicalSerializeEffective` is not exported from `@metaobjectsdev/metadata`, and `../src/meta-endpoint.js` does not exist.

- [ ] **Step 3: Export the serializer from the metadata barrel**

In `server/typescript/packages/metadata/src/index.ts`, change line 243 to add the missing name:

```ts
export { serializeJson, canonicalSerialize, canonicalSerializeEffective, serializeSharedDocument, inferAttrSubType } from "./serializer-json.js";
```

- [ ] **Step 4: Create the helper**

```ts
// server/typescript/packages/runtime-ts/src/meta-endpoint.ts
//
// UI-1 — the metadata API contract. Framework-free on purpose: only TypeScript
// has a web-bound runtime home, so every other port ships this function and lets
// the host mount it. The durable deliverable is the path + the serialization.
import { canonicalSerializeEffective, type MetaData } from "@metaobjectsdev/metadata";

/**
 * The metadata endpoint's path, mounted under the host's `apiPrefix`.
 * A cross-port contract value — one browser read-model has to work against
 * every backend, so this string is not per-port configurable.
 */
export const META_ROUTE_PATH = "/_meta";

/**
 * The `GET {apiPrefix}/_meta` response body: the loaded model as EFFECTIVE
 * canonical JSON.
 *
 * Effective, not raw (spec §3.2): the effective form materializes the
 * super-chain merge, so a browser reading it never resolves `extends` itself.
 * Per ADR-0039 an own-vs-resolving mistake there would silently drop inherited
 * `@columns` / `@pageSize` / `@sortableDefaultOrder` — exactly the attrs a
 * runtime grid reads — and read as "unset" rather than failing.
 */
export function metaJson(root: MetaData): string {
  return canonicalSerializeEffective(root);
}
```

Add to `server/typescript/packages/runtime-ts/src/index.ts`:

```ts
export { META_ROUTE_PATH, metaJson } from "./meta-endpoint.js";
```

- [ ] **Step 5: Create the test helper if it does not already exist**

```ts
// server/typescript/packages/runtime-ts/test/helpers/load-test-model.ts
import { MetaDataLoader, type MetaData } from "@metaobjectsdev/metadata";
import { join } from "node:path";

/** Loads the committed extends fixture — it has an inherited member, which is
 *  what makes it the right model for an EFFECTIVE-serialization assertion. */
export async function loadTestModel(): Promise<MetaData> {
  const dir = join(
    import.meta.dir, "..", "..", "..", "..", "..",
    "fixtures", "conformance", "extends-entity-field-basic", "input",
  );
  // `fromDirectory` is awaited DIRECTLY — it is not a builder with a .load().
  // This matches the call shape already used in this package's own tests
  // (see test/llm-recorder-contract.test.ts).
  const result = await MetaDataLoader.fromDirectory(dir);
  if (result.errors.length > 0) {
    throw new Error(`fixture failed to load: ${JSON.stringify(result.errors)}`);
  }
  return result.root;
}
```

> Assert on `result.errors`. A test that reads `.root` and discards the verdict
> passes on a model that failed to load — a real and repeated defect shape here.
> If `LoadResult`'s field names differ, match `test/llm-recorder-contract.test.ts:55`
> rather than inventing a shape.

- [ ] **Step 6: Run the tests and confirm they pass**

Run: `cd server/typescript/packages/runtime-ts && bun test test/meta-endpoint.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 7: Typecheck the workspace**

Run: `cd /path/to/repo && bun run --filter '*' typecheck`
Expected: clean. (`bun test` transpiles per file and does not typecheck — a broken type ships green without this.)

- [ ] **Step 8: Commit**

```bash
git add server/typescript/packages/metadata/src/index.ts \
        server/typescript/packages/runtime-ts/src/meta-endpoint.ts \
        server/typescript/packages/runtime-ts/src/index.ts \
        server/typescript/packages/runtime-ts/test/meta-endpoint.test.ts \
        server/typescript/packages/runtime-ts/test/helpers/load-test-model.ts
git commit -m "feat(runtime-ts): metaJson + the /_meta contract; export the effective serializer"
```

---

### Task 2: Mount `/_meta` on Fastify and Hono

**Files:**
- Modify: `server/typescript/packages/runtime-ts/src/fastify/index.ts`
- Modify: `server/typescript/packages/runtime-ts/src/hono/index.ts`
- Test: `server/typescript/packages/runtime-ts/test/meta-route.test.ts`

**Interfaces:**
- Consumes: `META_ROUTE_PATH`, `metaJson(root)` from Task 1.
- Produces: `mountMetaRoute(opts: MetaRouteOptions): void` (Fastify), `mountMetaRouteHono(opts: HonoMetaRouteOptions): void`.

**Context:** TypeScript is the only port shipping a mount (spec §3.3), so it is the only port with a route test. Mounting is opt-in: nothing registers this implicitly, and the host guards it with its own middleware — the same answer #367 gives for generated routes.

- [ ] **Step 1: Write the failing test**

```ts
// server/typescript/packages/runtime-ts/test/meta-route.test.ts
import { describe, test, expect } from "bun:test";
import Fastify from "fastify";
import { metaJson } from "../src/meta-endpoint.js";
import { mountMetaRoute } from "../src/fastify/index.js";
import { loadTestModel } from "./helpers/load-test-model.js";

describe("GET /_meta (fastify)", () => {
  test("serves the effective canonical JSON under the prefix", async () => {
    const root = await loadTestModel();
    const app = Fastify();
    mountMetaRoute({ fastify: app, root, prefix: "/api" });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/api/_meta" });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.body).toBe(metaJson(root));
  });

  test("mounts at the bare path when no prefix is given", async () => {
    const root = await loadTestModel();
    const app = Fastify();
    mountMetaRoute({ fastify: app, root });
    await app.ready();

    expect((await app.inject({ method: "GET", url: "/_meta" })).statusCode).toBe(200);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd server/typescript/packages/runtime-ts && bun test test/meta-route.test.ts`
Expected: FAIL — `mountMetaRoute` is not exported.

- [ ] **Step 3: Implement the Fastify mount**

Append to `server/typescript/packages/runtime-ts/src/fastify/index.ts`:

```ts
import type { FastifyInstance } from "fastify";
import type { MetaData } from "@metaobjectsdev/metadata";
import { META_ROUTE_PATH, metaJson } from "../meta-endpoint.js";

export interface MetaRouteOptions {
  fastify: FastifyInstance;
  /** The loaded model root. */
  root: MetaData;
  /** Mounted under this prefix; defaults to "" (the bare `/_meta`). */
  prefix?: string;
}

/**
 * Mount `GET {prefix}/_meta`, serving the model as effective canonical JSON.
 *
 * Opt-in by design. `/_meta` publishes the SHAPE of the model — entity and field
 * names, types, validators, layouts — though no row data. Guard it with your own
 * middleware exactly as you would the generated routes (#367):
 *
 *     app.register(async (s) => {
 *       s.addHook("preHandler", requireAuth);
 *       mountMetaRoute({ fastify: s, root, prefix: "/api" });
 *     });
 *
 * The body is serialized once per call. If that ever matters, cache it in the
 * host — the model is immutable after load.
 */
export function mountMetaRoute(opts: MetaRouteOptions): void {
  const path = `${opts.prefix ?? ""}${META_ROUTE_PATH}`;
  opts.fastify.get(path, async (_req, reply) => {
    return reply
      .code(200)
      .header("content-type", "application/json; charset=utf-8")
      .send(metaJson(opts.root));
  });
}
```

- [ ] **Step 4: Implement the Hono mount**

Append to `server/typescript/packages/runtime-ts/src/hono/index.ts`:

```ts
import type { Hono } from "hono";
import type { MetaData } from "@metaobjectsdev/metadata";
import { META_ROUTE_PATH, metaJson } from "../meta-endpoint.js";

export interface HonoMetaRouteOptions {
  app: Hono;
  root: MetaData;
  prefix?: string;
}

/**
 * Mount `GET {prefix}/_meta` on Hono. Same contract and same opt-in caveat as
 * the Fastify twin; guard the mount path with middleware before calling this:
 *
 *     app.use(`/api${META_ROUTE_PATH}`, requireAuth);
 *     mountMetaRouteHono({ app, root, prefix: "/api" });
 */
export function mountMetaRouteHono(opts: HonoMetaRouteOptions): void {
  const path = `${opts.prefix ?? ""}${META_ROUTE_PATH}`;
  opts.app.get(path, (c) =>
    c.body(metaJson(opts.root), 200, { "content-type": "application/json; charset=utf-8" }),
  );
}
```

- [ ] **Step 5: Add the matching Hono test**

```ts
// append to server/typescript/packages/runtime-ts/test/meta-route.test.ts
import { Hono } from "hono";
import { mountMetaRouteHono } from "../src/hono/index.js";

describe("GET /_meta (hono)", () => {
  test("serves the same bytes as the fastify mount", async () => {
    const root = await loadTestModel();
    const app = new Hono();
    mountMetaRouteHono({ app, root, prefix: "/api" });

    const res = await app.request("/api/_meta");

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(metaJson(root));
  });
});
```

- [ ] **Step 6: Run the tests and confirm they pass**

Run: `cd server/typescript/packages/runtime-ts && bun test test/meta-route.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 7: Commit**

```bash
git add server/typescript/packages/runtime-ts/src/fastify/index.ts \
        server/typescript/packages/runtime-ts/src/hono/index.ts \
        server/typescript/packages/runtime-ts/test/meta-route.test.ts
git commit -m "feat(runtime-ts): mount GET /_meta on fastify and hono"
```

---

### Task 3: The narrow read surface, and widen `buildGrid` onto it

**Files:**
- Create: `client/web/packages/runtime-web/src/meta-read.ts`
- Modify: `client/web/packages/runtime-web/src/grid-from-metadata.ts:12` (the type import) and the `buildGrid` signature
- Modify: `client/web/packages/runtime-web/src/index.ts`
- Test: `client/web/packages/runtime-web/test/meta-read.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `MetaRead`, `MetaFieldRead`, `MetaViewRead`, `MetaLayoutRead`, `MetaModelRead`.

**Context:** `buildGrid` imports `MetaObject`/`MetaField`/`MetaView` as **types only** and touches a small surface: `MetaObject.fields()` / `.layouts()`; `MetaField.name` / `.subType` / `.attr()` / `.views()`; `MetaView.subType` / `.attr()`; layout `.name` / `.subType` / `.attr()`. Declaring that surface lets both the real `MetaObject` and a browser model satisfy it. Widening a parameter type is backward compatible — every existing server-side caller keeps compiling.

- [ ] **Step 1: Write the failing test**

```ts
// client/web/packages/runtime-web/test/meta-read.test.ts
import { describe, test, expect } from "bun:test";
import { buildGrid } from "../src/grid-from-metadata.js";
import type { MetaRead } from "../src/meta-read.js";

/** A hand-built model satisfying MetaRead — proves buildGrid no longer requires
 *  a real MetaObject, which is what lets a browser model drive it. */
const stub: MetaRead = {
  name: "Author",
  subType: "entity",
  attr: () => undefined,
  fields: () => [
    { name: "firstName", subType: "string", attr: () => undefined, views: () => [] },
    { name: "createdAt", subType: "timestamp", attr: () => undefined, views: () => [] },
  ],
  layouts: () => [],
};

describe("MetaRead", () => {
  test("buildGrid accepts any MetaRead, not only a MetaObject", () => {
    const grid = buildGrid(stub);
    expect(grid.columns.map((c) => c.field)).toEqual(["firstName", "createdAt"]);
  });

  test("headers humanize when no view supplies a title", () => {
    expect(buildGrid(stub).columns[0]!.header).toBe("First Name");
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd client/web/packages/runtime-web && bun test test/meta-read.test.ts`
Expected: FAIL — `../src/meta-read.js` does not exist.

- [ ] **Step 3: Declare the read surface**

```ts
// client/web/packages/runtime-web/src/meta-read.ts
//
// The narrow, read-only metadata surface a runtime UI consumer needs.
//
// Declared here rather than imported from @metaobjectsdev/metadata because this
// package must satisfy it with a browser-built model too: the metadata package's
// root barrel exports MetaDataLoader, which transitively imports `node:url`, so
// it cannot be bundled for a browser (#287). A real MetaObject satisfies these
// interfaces structurally, so server-side callers are unaffected.
//
// ADR-0039: every accessor here is the RESOLVING one. `attr()` must answer with
// inherited values, and `views()`/`fields()` must include inherited members.

/** A metadata attribute reader. Returns `undefined` for an unset OR unregistered name. */
export type AttrReader = (name: string) => unknown;

export interface MetaViewRead {
  readonly subType: string;
  attr: AttrReader;
}

export interface MetaFieldRead {
  readonly name: string;
  readonly subType: string;
  attr: AttrReader;
  views(): MetaViewRead[];
}

export interface MetaLayoutRead {
  readonly name: string;
  readonly subType: string;
  attr: AttrReader;
}

/** One object (entity / value / projection) as a runtime UI reads it. */
export interface MetaRead {
  readonly name: string;
  readonly subType: string;
  attr: AttrReader;
  fields(): MetaFieldRead[];
  layouts(): MetaLayoutRead[];
}

/** The whole model, as returned by `loadMetaModel`. */
export interface MetaModelRead {
  objects(): MetaRead[];
  object(name: string): MetaRead | undefined;
}
```

- [ ] **Step 4: Widen `buildGrid`**

In `client/web/packages/runtime-web/src/grid-from-metadata.ts`, replace the metadata type import with the local surface and widen the signatures. Change:

```ts
import type { MetaObject, MetaField, MetaView } from "@metaobjectsdev/metadata";
```

to:

```ts
// The narrow local surface, not the metadata classes: a browser-built model must
// satisfy it too (#287 — the metadata root barrel cannot be bundled). A real
// MetaObject satisfies MetaRead structurally, so server callers are unaffected.
import type { MetaRead, MetaFieldRead, MetaViewRead } from "./meta-read.js";
```

Then replace the three type names throughout this file: `MetaObject` → `MetaRead`, `MetaField` → `MetaFieldRead`, `MetaView` → `MetaViewRead`. The value imports from `@metaobjectsdev/metadata/constants` stay exactly as they are.

`buildGrid`'s signature becomes:

```ts
export function buildGrid(meta: MetaRead, gridName?: string): MetaGrid {
```

- [ ] **Step 5: Export the types**

Add to `client/web/packages/runtime-web/src/index.ts`:

```ts
export type {
  MetaRead, MetaFieldRead, MetaViewRead, MetaLayoutRead, MetaModelRead, AttrReader,
} from "./meta-read.js";
```

- [ ] **Step 6: Run the new test AND the existing grid suite**

Run: `cd client/web/packages/runtime-web && bun test`
Expected: PASS — including the pre-existing `test/grid-from-metadata.test.ts`, unchanged. If that suite goes red, the widening changed behavior, which it must not.

- [ ] **Step 7: Typecheck**

Run: `cd /path/to/repo && bun run --filter '*' typecheck`
Expected: clean. This is what proves the widening is backward compatible for every server-side caller of `buildGrid`.

- [ ] **Step 8: Commit**

```bash
git add client/web/packages/runtime-web/src/meta-read.ts \
        client/web/packages/runtime-web/src/grid-from-metadata.ts \
        client/web/packages/runtime-web/src/index.ts \
        client/web/packages/runtime-web/test/meta-read.test.ts
git commit -m "feat(runtime-web): declare the narrow MetaRead surface; widen buildGrid onto it"
```

---

### Task 4: `loadMetaModel` — canonical JSON to a browser read-model

**Files:**
- Create: `client/web/packages/runtime-web/src/load-meta-model.ts`
- Modify: `server/typescript/packages/metadata/src/constants.ts` — add `shared/base-types.js` to the browser-safe barrel (**required**; see Step 4)
- Modify: `client/web/packages/runtime-web/src/index.ts`
- Test: `client/web/packages/runtime-web/test/load-meta-model.test.ts`

**Interfaces:**
- Consumes: `MetaRead`, `MetaModelRead` (Task 3).
- Produces: `loadMetaModel(json: string | unknown): MetaModelRead`.

**Context — the canonical shape.** A node is a single-key object whose key is `"<type>.<subType>"` and whose body carries `name`, optionally `package`, `extends`, `children: []`, and attributes as `@`-prefixed keys:

```json
{ "metadata.root": { "package": "acme::ai", "children": [
    { "object.entity": { "name": "Author", "extends": "acme::Base", "@dbTable": "authors",
        "children": [ { "field.string": { "name": "firstName" } } ] } } ] } }
```

**The trap:** effective output **still emits `extends`**, with inherited members already inlined beside it. `loadMetaModel` must **ignore** `extends` entirely. Resolving it would double-count every inherited member.

- [ ] **Step 1: Write the failing test**

```ts
// client/web/packages/runtime-web/test/load-meta-model.test.ts
import { describe, test, expect } from "bun:test";
import { loadMetaModel } from "../src/load-meta-model.js";

const DOC = JSON.stringify({
  "metadata.root": {
    package: "acme::blog",
    children: [
      {
        "object.entity": {
          name: "Author",
          extends: "acme::common::BaseEntity",
          "@dbTable": "authors",
          children: [
            { "field.string": { name: "firstName", children: [{ "view.text": { "@title": "Given name" } }] } },
            { "field.timestamp": { name: "createdAt" } },
            { "layout.dataGrid": { name: "default", "@pageSize": 50 } },
          ],
        },
      },
    ],
  },
});

describe("loadMetaModel", () => {
  test("exposes each object by name", () => {
    const model = loadMetaModel(DOC);
    expect(model.objects().map((o) => o.name)).toEqual(["Author"]);
    expect(model.object("Author")?.subType).toBe("entity");
    expect(model.object("Nope")).toBeUndefined();
  });

  test("reads attributes without the @ prefix", () => {
    expect(loadMetaModel(DOC).object("Author")!.attr("dbTable")).toBe("authors");
  });

  test("separates fields, layouts and views by node type", () => {
    const author = loadMetaModel(DOC).object("Author")!;
    expect(author.fields().map((f) => f.name)).toEqual(["firstName", "createdAt"]);
    expect(author.fields()[0]!.subType).toBe("string");
    expect(author.layouts().map((l) => l.name)).toEqual(["default"]);
    expect(author.layouts()[0]!.attr("pageSize")).toBe(50);
    expect(author.fields()[0]!.views()[0]!.attr("title")).toBe("Given name");
  });

  test("IGNORES extends — effective output already inlined inherited members", () => {
    // Resolving `extends` here would double-count. The ref is present in the
    // body and must not be followed.
    const author = loadMetaModel(DOC).object("Author")!;
    expect(author.attr("extends")).toBeUndefined();
    expect(author.fields()).toHaveLength(2);
  });

  test("accepts an already-parsed object as well as a string", () => {
    expect(loadMetaModel(JSON.parse(DOC)).object("Author")?.name).toBe("Author");
  });

  test("an unset or unregistered attr reads undefined", () => {
    expect(loadMetaModel(DOC).object("Author")!.attr("nothingLikeThis")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd client/web/packages/runtime-web && bun test test/load-meta-model.test.ts`
Expected: FAIL — `../src/load-meta-model.js` does not exist.

- [ ] **Step 3: Implement the reader**

```ts
// client/web/packages/runtime-web/src/load-meta-model.ts
//
// UI-2 — read the `GET /_meta` document into a model buildGrid can walk.
//
// Deliberately NOT the metadata loader: that package's root barrel exports
// MetaDataLoader, which transitively imports `node:url`, so it cannot be bundled
// for a browser (#287). This is a reader over an already-validated, already-
// resolved document — no validation, no registry, no super-resolution.
import {
  TYPE_FIELD, TYPE_LAYOUT, TYPE_VIEW, TYPE_OBJECT,
} from "@metaobjectsdev/metadata/constants";
import type {
  AttrReader, MetaFieldRead, MetaLayoutRead, MetaModelRead, MetaRead, MetaViewRead,
} from "./meta-read.js";

/** Reserved body keys that are structure, not attributes. */
const ATTR_PREFIX = "@";
const KEY_NAME = "name";
const KEY_CHILDREN = "children";
/**
 * `extends` is STILL EMITTED in effective output, with inherited members already
 * inlined beside it. It is structure we deliberately ignore: following it would
 * count every inherited member twice.
 */
const KEY_EXTENDS = "extends";

/** One parsed node: its fused "type.subType" key and its body. */
interface RawNode {
  type: string;
  subType: string;
  body: Record<string, unknown>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A canonical node is a single-key object: { "field.string": { ... } }. */
function readNode(value: unknown): RawNode | undefined {
  if (!isRecord(value)) return undefined;
  const keys = Object.keys(value);
  if (keys.length !== 1) return undefined;
  const fused = keys[0]!;
  const body = value[fused];
  if (!isRecord(body)) return undefined;
  const dot = fused.indexOf(".");
  if (dot < 0) return undefined;
  return { type: fused.slice(0, dot), subType: fused.slice(dot + 1), body };
}

function childrenOf(node: RawNode): RawNode[] {
  const raw = node.body[KEY_CHILDREN];
  if (!Array.isArray(raw)) return [];
  const out: RawNode[] = [];
  for (const entry of raw) {
    const child = readNode(entry);
    if (child !== undefined) out.push(child);
  }
  return out;
}

/** Attributes are the `@`-prefixed body keys, read without the prefix. */
function attrReaderFor(node: RawNode): AttrReader {
  const attrs = new Map<string, unknown>();
  for (const [key, value] of Object.entries(node.body)) {
    if (key.startsWith(ATTR_PREFIX)) attrs.set(key.slice(ATTR_PREFIX.length), value);
  }
  // KEY_EXTENDS is intentionally absent: it is not an attribute, and the members
  // it once referenced are already inlined here.
  return (name: string) => attrs.get(name);
}

function nameOf(node: RawNode): string {
  const raw = node.body[KEY_NAME];
  return typeof raw === "string" ? raw : "";
}

function toView(node: RawNode): MetaViewRead {
  return { subType: node.subType, attr: attrReaderFor(node) };
}

function toField(node: RawNode): MetaFieldRead {
  const views = childrenOf(node).filter((c) => c.type === TYPE_VIEW).map(toView);
  return {
    name: nameOf(node),
    subType: node.subType,
    attr: attrReaderFor(node),
    views: () => views,
  };
}

function toLayout(node: RawNode): MetaLayoutRead {
  return { name: nameOf(node), subType: node.subType, attr: attrReaderFor(node) };
}

function toObject(node: RawNode): MetaRead {
  const kids = childrenOf(node);
  const fields = kids.filter((c) => c.type === TYPE_FIELD).map(toField);
  const layouts = kids.filter((c) => c.type === TYPE_LAYOUT).map(toLayout);
  return {
    name: nameOf(node),
    subType: node.subType,
    attr: attrReaderFor(node),
    fields: () => fields,
    layouts: () => layouts,
  };
}

/**
 * Read a `GET /_meta` document (effective canonical JSON) into a browser model.
 *
 * Accepts the raw response text or an already-parsed value. The document is
 * assumed valid: the server loaded and validated it, and serving the EFFECTIVE
 * form means every inherited member is already materialized here.
 */
export function loadMetaModel(json: string | unknown): MetaModelRead {
  const parsed: unknown = typeof json === "string" ? JSON.parse(json) : json;
  const root = readNode(parsed);
  const objects = root === undefined
    ? []
    : childrenOf(root).filter((c) => c.type === TYPE_OBJECT).map(toObject);
  const byName = new Map(objects.map((o) => [o.name, o] as const));
  return {
    objects: () => objects,
    object: (name: string) => byName.get(name),
  };
}
```

- [ ] **Step 4: Add the base-type constants to the browser-safe barrel — REQUIRED, the import above fails without it**

`TYPE_OBJECT` / `TYPE_FIELD` / `TYPE_VIEW` / `TYPE_LAYOUT` are defined in
`server/typescript/packages/metadata/src/shared/base-types.ts` (`:9`, `:10`, `:13`, `:16`), and
that file is **not** re-exported by `src/constants.ts` — its barrel currently lists only
`core/*`, `persistence/*`, `presentation/*` and `template/*`. So `load-meta-model.ts` will not
compile until it is added.

`base-types.ts` is 62 lines of pure `export const` with **zero imports**, so it is safe for the
browser barrel — that is the property the barrel requires (no `node:*` anywhere in the graph).

Add to `server/typescript/packages/metadata/src/constants.ts`, in the existing `export *` block:

```ts
export * from "./shared/base-types.js";
```

Do **not** import these from the package root instead, and do **not** inline the string
literals — repo discipline is named constants for every metamodel string, and the root barrel
is what #287 forbids.

- [ ] **Step 5: Export it**

Add to `client/web/packages/runtime-web/src/index.ts`:

```ts
export { loadMetaModel } from "./load-meta-model.js";
```

- [ ] **Step 6: Run the tests and confirm they pass**

Run: `cd client/web/packages/runtime-web && bun test test/load-meta-model.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 7: Typecheck, then commit**

Run: `cd /path/to/repo && bun run --filter '*' typecheck` — clean.

```bash
git add server/typescript/packages/metadata/src/constants.ts \
        client/web/packages/runtime-web/src/load-meta-model.ts \
        client/web/packages/runtime-web/src/index.ts \
        client/web/packages/runtime-web/test/load-meta-model.test.ts
git commit -m "feat(runtime-web): loadMetaModel — read GET /_meta into a browser read-model"
```

---

### Task 5: The equality gate — the browser model must behave like the real one

**Files:**
- Test: `client/web/packages/runtime-web/test/meta-model-parity.test.ts`

**Interfaces:**
- Consumes: `loadMetaModel` (Task 4), `buildGrid` (Task 3), `canonicalSerializeEffective` (Task 1).
- Produces: nothing — this is the guarantee that makes the browser model trustworthy.

**Context:** This is the load-bearing test of the whole plan. Everything else could pass while the browser model quietly disagrees with the real one. Here the *same* `buildGrid` runs over both and the outputs must be identical. Test code may use the Node loader freely — tests are not bundled; only `src/` is subject to #287.

- [ ] **Step 1: Write the failing test**

```ts
// client/web/packages/runtime-web/test/meta-model-parity.test.ts
import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { MetaDataLoader, canonicalSerializeEffective } from "@metaobjectsdev/metadata";
import { TYPE_OBJECT } from "@metaobjectsdev/metadata/constants";
import { buildGrid } from "../src/grid-from-metadata.js";
import { loadMetaModel } from "../src/load-meta-model.js";

const FIXTURES = join(import.meta.dir, "..", "..", "..", "..", "..", "fixtures", "conformance");

/** Fixtures whose models exercise inheritance — the case where an own-vs-resolving
 *  mistake would diverge. `extends-view-triple-nest` inherits VIEWS, which is what
 *  buildGrid reads for both its header and its renderer hint. */
const CASES = [
  "extends-entity-field-basic",
  "extends-abstract-field-inheritance",
  "extends-view-triple-nest",
];

describe("browser read-model parity", () => {
  for (const name of CASES) {
    test(`buildGrid agrees for ${name}`, async () => {
      // fromDirectory is awaited directly — not a builder with a .load().
      const result = await MetaDataLoader.fromDirectory(join(FIXTURES, name, "input"));
      expect(result.errors).toEqual([]);

      const browser = loadMetaModel(canonicalSerializeEffective(result.root));

      // children(), not ownChildren(): ADR-0039. TYPE_OBJECT, not "object":
      // named constants for every metamodel string.
      const realObjects = result.root.children().filter((c) => c.type === TYPE_OBJECT);
      expect(realObjects.length).toBeGreaterThan(0);

      for (const real of realObjects) {
        const mirrored = browser.object(real.name);
        expect(mirrored, `${real.name} missing from the browser model`).toBeDefined();
        // The SAME function over both models. Any divergence — a dropped inherited
        // view, a missed attr, a mis-split child type — shows up right here.
        expect(buildGrid(mirrored!)).toEqual(buildGrid(real as never));
      }
    });
  }
});
```

- [ ] **Step 2: Run it and confirm it fails or passes for the right reason**

Run: `cd client/web/packages/runtime-web && bun test test/meta-model-parity.test.ts`
Expected: FAIL initially if `loadMetaModel` mis-splits any node type. **Do not "fix" the test to match the reader** — the real model is the reference; fix `load-meta-model.ts` until they agree.

> If `LoadResult`'s field names differ from `.root` / `.errors`, match
> `runtime-ts/test/llm-recorder-contract.test.ts:55`. Keep the assertion shape
> exactly: the same `buildGrid`, both models, deep equality.

- [ ] **Step 3: Run the whole package suite**

Run: `cd client/web/packages/runtime-web && bun test`
Expected: PASS, all files.

- [ ] **Step 4: Commit**

```bash
git add client/web/packages/runtime-web/test/meta-model-parity.test.ts
git commit -m "test(runtime-web): gate the browser read-model against the real one via buildGrid"
```

---

### Task 6: Keep the browser-bundling gate honest

**Files:**
- Modify: `client/web/packages/runtime-web/test/browser-bundleable.test.ts`

**Interfaces:**
- Consumes: the built `dist` output of `runtime-web`.
- Produces: nothing.

**Context:** This test exists because a single VALUE import from the metadata root barrel made every browser bundle fail (#287), reported by an adopting project, and unit tests passed the whole time — Bun's test runner resolves the `"bun"` export condition to TypeScript source and never bundles. `load-meta-model.ts` is new surface on exactly that boundary, so the gate must cover it.

- [ ] **Step 1: Read the existing test**

Run: `cat client/web/packages/runtime-web/test/browser-bundleable.test.ts`

Note how it builds (`Bun.build({ target: "browser" })`) over `dist/index.js` and how it asserts. Follow that shape — do not invent a second mechanism.

- [ ] **Step 2: Add a case that would fail if `loadMetaModel` reached the root barrel**

```ts
// append inside the existing describe block
test("loadMetaModel is reachable in a browser bundle", async () => {
  // load-meta-model.ts imports TYPE_* from @metaobjectsdev/metadata/constants.
  // If it ever imports them from the package root instead, the root pulls
  // MetaDataLoader -> library-sources.ts -> node:url and this fails.
  const built = await browserBundle(DIST_ENTRY);
  expect(built.ok, built.message).toBe(true);

  const out = await Bun.build({ entrypoints: [DIST_ENTRY], target: "browser", throw: false });
  const code = await out.outputs[0]!.text();
  expect(code).toContain("loadMetaModel");
  expect(code).not.toContain("fileURLToPath");
});
```

- [ ] **Step 3: Build, then run the gate against BUILT output**

Run:
```bash
cd /path/to/repo && bun run --filter '*' build
cd client/web/packages/runtime-web && bun test test/browser-bundleable.test.ts
```
Expected: PASS. The build step is not optional — this test reads `dist`, and a stale `dist` makes it assert about the previous commit.

- [ ] **Step 4: Commit**

```bash
git add client/web/packages/runtime-web/test/browser-bundleable.test.ts
git commit -m "test(runtime-web): cover loadMetaModel in the browser-bundling gate"
```

---

### Task 7: C# `metaJson`

**Files:**
- Create: `server/csharp/MetaObjects/MetaEndpoint.cs`
- Test: `server/csharp/MetaObjects.Tests/MetaEndpointTests.cs`

**Interfaces:**
- Consumes: `SerializerJson.CanonicalSerializeEffective(MetaData model)` (verified signature).
- Produces: `MetaObjects.MetaEndpoint.MetaRoutePath`, `MetaObjects.MetaEndpoint.MetaJson(MetaData root)`.

**Context:** C# ships the helper but **no mount** — its runtime `MetaObjects` package references only YamlDotNet, and adding an ASP.NET `FrameworkReference` to it would push a web dependency onto every consumer of the core package. The host mounts one line. This is the only FR-029 work C# participates in; it has no metadata-driven runtime data access (spec §8).

- [ ] **Step 1: Write the failing test**

```csharp
// server/csharp/MetaObjects.Tests/MetaEndpointTests.cs
using Xunit;

namespace MetaObjects.Tests;

public class MetaEndpointTests
{
    [Fact]
    public void MetaRoutePath_is_the_cross_port_contract_value()
    {
        Assert.Equal("/_meta", MetaEndpoint.MetaRoutePath);
    }

    [Fact]
    public void MetaJson_returns_the_effective_canonical_serialization()
    {
        var root = TestModels.LoadExtendsFixture();   // follow this suite's existing loader helper
        Assert.Equal(SerializerJson.CanonicalSerializeEffective(root), MetaEndpoint.MetaJson(root));
    }
}
```

> Use whatever fixture-loading helper `MetaObjects.Tests` already has; do not add
> a second way to load a model. Assert the load produced no errors before using it.

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd server/csharp && dotnet test MetaObjects.Tests --filter MetaEndpointTests`
Expected: FAIL — `MetaEndpoint` does not exist.

> Count the test lines in the output. `dotnet test` prints `Passed!` for a run in
> which a project failed to compile, so a green word alone is not evidence.

- [ ] **Step 3: Implement**

```csharp
// server/csharp/MetaObjects/MetaEndpoint.cs
namespace MetaObjects;

/// <summary>
/// UI-1 — the metadata API contract.
///
/// C# ships the helper and not a mount: the runtime <c>MetaObjects</c> package
/// references only YamlDotNet, and an ASP.NET FrameworkReference here would put a
/// web dependency on every consumer of the core package. Mount it yourself:
///
/// <code>
/// app.MapGet($"/api{MetaEndpoint.MetaRoutePath}",
///            () => Results.Text(MetaEndpoint.MetaJson(root), "application/json"));
/// </code>
///
/// Guard that route with your own authorization — <c>/_meta</c> publishes the
/// shape of the model (entity and field names, types, validators, layouts),
/// though no row data.
/// </summary>
public static class MetaEndpoint
{
    /// <summary>The endpoint path, mounted under the host's API prefix. A cross-port
    /// contract value — one browser read-model works against every backend.</summary>
    public const string MetaRoutePath = "/_meta";

    /// <summary>The response body: the model as EFFECTIVE canonical JSON, so a browser
    /// reading it never has to resolve <c>extends</c> itself.</summary>
    public static string MetaJson(MetaData root) => SerializerJson.CanonicalSerializeEffective(root);
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `cd server/csharp && dotnet test MetaObjects.Tests --filter MetaEndpointTests`
Expected: PASS (2 tests) — and confirm the count, per Step 2's note.

- [ ] **Step 5: Commit**

```bash
git add server/csharp/MetaObjects/MetaEndpoint.cs server/csharp/MetaObjects.Tests/MetaEndpointTests.cs
git commit -m "feat(csharp): metaJson helper for the GET /_meta contract"
```

---

### Task 8: Java `metaJson`, reachable from Kotlin

**Files:**
- Create: `server/java/metadata/src/main/java/com/metaobjects/io/json/MetaEndpoint.java`
- Test: `server/java/metadata/src/test/java/com/metaobjects/io/json/MetaEndpointTest.java`
- Test: `server/java/metadata-ktx/src/test/kotlin/com/metaobjects/metadata/ktx/MetaEndpointKtxTest.kt`

**Interfaces:**
- Consumes: `CanonicalJsonSerializer.canonicalSerializeEffective(MetaData node)` (verified signature).
- Produces: `com.metaobjects.io.json.MetaEndpoint.META_ROUTE_PATH`, `MetaEndpoint.metaJson(MetaData root)`.

**Context:** It goes in `metadata`, not `core-spring`: `core-spring` has `spring-context` and `spring-boot-autoconfigure` but **no `spring-web`**, so it cannot host a controller either, and `metadata` is where the serializer already lives. Kotlin consumes the Java symbol through `metadata-ktx` — no separate Kotlin implementation, just a test proving reachability.

- [ ] **Step 1: Write the failing Java test**

```java
// server/java/metadata/src/test/java/com/metaobjects/io/json/MetaEndpointTest.java
package com.metaobjects.io.json;

import com.metaobjects.loader.MetaDataLoader;
import org.junit.Test;
import static org.junit.Assert.assertEquals;

public class MetaEndpointTest {

    @Test
    public void metaRoutePathIsTheCrossPortContractValue() {
        assertEquals("/_meta", MetaEndpoint.META_ROUTE_PATH);
    }

    @Test
    public void metaJsonReturnsTheEffectiveCanonicalSerialization() {
        MetaDataLoader loader = TestLoaders.extendsFixture();  // reuse this module's existing helper
        assertEquals(
            CanonicalJsonSerializer.canonicalSerializeEffective(loader.getMetaDataRoot()),
            MetaEndpoint.metaJson(loader.getMetaDataRoot()));
    }
}
```

> Match this module's existing fixture-loading helper and root accessor rather
> than inventing one; confirm the accessor name against a neighbouring test.

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd server/java && mvn -pl metadata test -Dtest=MetaEndpointTest`
Expected: FAIL — `MetaEndpoint` does not exist.

- [ ] **Step 3: Implement**

```java
// server/java/metadata/src/main/java/com/metaobjects/io/json/MetaEndpoint.java
package com.metaobjects.io.json;

import com.metaobjects.MetaData;

/**
 * UI-1 — the metadata API contract.
 *
 * <p>Java ships the helper and not a mount: {@code core-spring} carries
 * {@code spring-context} but no {@code spring-web}, and adding a web dependency
 * for one endpoint would put it on every consumer. Mount it yourself:
 *
 * <pre>
 * &#64;GetMapping(value = "/api" + MetaEndpoint.META_ROUTE_PATH,
 *             produces = MediaType.APPLICATION_JSON_VALUE)
 * public String meta() { return MetaEndpoint.metaJson(root); }
 * </pre>
 *
 * <p>Guard that route with your own authorization — {@code /_meta} publishes the
 * shape of the model, though no row data.
 */
public final class MetaEndpoint {

    private MetaEndpoint() {}

    /**
     * The endpoint path, mounted under the host's API prefix. A cross-port contract
     * value — one browser read-model works against every backend.
     */
    public static final String META_ROUTE_PATH = "/_meta";

    /**
     * The response body: the model as EFFECTIVE canonical JSON, so a browser reading
     * it never resolves {@code extends} itself.
     */
    public static String metaJson(MetaData root) {
        return CanonicalJsonSerializer.canonicalSerializeEffective(root);
    }
}
```

- [ ] **Step 4: Add the Kotlin reachability test**

```kotlin
// server/java/metadata-ktx/src/test/kotlin/com/metaobjects/metadata/ktx/MetaEndpointKtxTest.kt
package com.metaobjects.metadata.ktx

import com.metaobjects.io.json.MetaEndpoint
import kotlin.test.Test
import kotlin.test.assertEquals

class MetaEndpointKtxTest {
    /** Kotlin consumes the Java symbol; there is no separate Kotlin implementation,
     *  so this proves the contract is reachable from the Kotlin facade. */
    @Test
    fun `the contract is reachable from kotlin`() {
        assertEquals("/_meta", MetaEndpoint.META_ROUTE_PATH)
    }
}
```

- [ ] **Step 5: Run the FULL reactor, not just the two modules**

Run: `cd server/java && mvn -q test`
Expected: PASS. A Maven reactor **stops** at the first failing module, so re-running only the module you touched never proves the set — later modules were never reached.

- [ ] **Step 6: Commit**

```bash
git add server/java/metadata/src/main/java/com/metaobjects/io/json/MetaEndpoint.java \
        server/java/metadata/src/test/java/com/metaobjects/io/json/MetaEndpointTest.java \
        server/java/metadata-ktx/src/test/kotlin/com/metaobjects/metadata/ktx/MetaEndpointKtxTest.kt
git commit -m "feat(java): metaJson helper for the GET /_meta contract, reachable from Kotlin"
```

---

### Task 9: Python `metaJson`

**Files:**
- Create: `server/python/src/metaobjects/meta_endpoint.py`
- Modify: `server/python/src/metaobjects/__init__.py`
- Test: `server/python/tests/test_meta_endpoint.py`

**Interfaces:**
- Consumes: `canonical_serialize_effective(node: MetaData) -> str` (verified signature).
- Produces: `metaobjects.META_ROUTE_PATH`, `metaobjects.meta_json(root)`.

**Context:** Like TS's barrel gap, `canonical_serialize_effective` is **not** exported from `metaobjects/__init__.py`. Export both it and the new helper. Python ships no mount — neither `runtime/` nor `codegen/runtime/` imports FastAPI, and this endpoint is not a reason to make one of them framework-bound.

- [ ] **Step 1: Write the failing test**

```python
# server/python/tests/test_meta_endpoint.py
from metaobjects import META_ROUTE_PATH, meta_json
from metaobjects.serializer_json import canonical_serialize_effective

from .helpers import load_extends_fixture   # reuse this suite's existing loader helper


def test_meta_route_path_is_the_cross_port_contract_value() -> None:
    assert META_ROUTE_PATH == "/_meta"


def test_meta_json_returns_the_effective_canonical_serialization() -> None:
    root = load_extends_fixture()
    assert meta_json(root) == canonical_serialize_effective(root)


def test_meta_json_inlines_a_member_inherited_via_extends() -> None:
    root = load_extends_fixture()
    assert "createdAt" in meta_json(root)
```

> Use the fixture helper this suite already has; if there is none, load
> `fixtures/conformance/extends-entity-field-basic/input` the way a neighbouring
> test does, and assert the load reported no errors.

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd server/python && python -m pytest tests/test_meta_endpoint.py -v`
Expected: FAIL — `ImportError` for `META_ROUTE_PATH` / `meta_json`.

> Use the project venv (Python **>= 3.11**). A venv built on the system
> interpreter will fail on syntax the package requires, which looks like a mass
> test failure rather than a wrong interpreter.

- [ ] **Step 3: Implement**

```python
# server/python/src/metaobjects/meta_endpoint.py
"""UI-1 — the metadata API contract.

Python ships the helper and not a mount: neither ``metaobjects.runtime`` nor
``metaobjects.codegen.runtime`` imports a web framework, and one endpoint is not
a reason to make either of them framework-bound. Mount it yourself::

    @app.get(f"/api{META_ROUTE_PATH}")
    def meta() -> Response:
        return Response(meta_json(root), media_type="application/json")

Guard that route with your own authorization — ``/_meta`` publishes the shape of
the model (entity and field names, types, validators, layouts), though no row data.
"""

from metaobjects.meta.meta_data import MetaData
from metaobjects.serializer_json import canonical_serialize_effective

#: The endpoint path, mounted under the host's API prefix. A cross-port contract
#: value — one browser read-model works against every backend.
META_ROUTE_PATH = "/_meta"


def meta_json(root: MetaData) -> str:
    """The response body: the model as EFFECTIVE canonical JSON.

    Effective, not raw: the effective form materializes the super-chain merge, so
    a browser reading it never resolves ``extends`` itself.
    """
    return canonical_serialize_effective(root)
```

- [ ] **Step 4: Export from the package root**

Add to `server/python/src/metaobjects/__init__.py`, following the file's existing export style and `__all__` convention:

```python
from metaobjects.meta_endpoint import META_ROUTE_PATH, meta_json
from metaobjects.serializer_json import canonical_serialize_effective
```

> `canonical_serialize_effective` is currently unexported from this barrel — the
> same gap TS had. Export it alongside its siblings.

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `cd server/python && python -m pytest tests/test_meta_endpoint.py -v`
Expected: PASS (3 tests)

- [ ] **Step 6: Run the package suite**

Run: `cd server/python && python -m pytest -q`
Expected: PASS — the `__init__` change is the kind that breaks an unrelated import.

- [ ] **Step 7: Commit**

```bash
git add server/python/src/metaobjects/meta_endpoint.py \
        server/python/src/metaobjects/__init__.py \
        server/python/tests/test_meta_endpoint.py
git commit -m "feat(python): metaJson helper for the GET /_meta contract"
```

---

### Task 10: Document the contract

**Files:**
- Create: `docs/features/metadata-api.md`
- Modify: `docs/features/api-contract.md` (link to it from the endpoint list)

**Interfaces:**
- Consumes: everything above.
- Produces: the documented contract — per spec §3.3 this is the durable deliverable; the code is nearly nothing.

**Context:** The whole point of UI-1 is that one browser read-model works against any backend (UI-8). That guarantee lives in a documented contract, not in five small functions.

- [ ] **Step 1: Write the page**

`docs/features/metadata-api.md` must state, with a worked mount example per port copied from the doc comments written in Tasks 2, 7, 8 and 9:

1. **The contract** — `GET {apiPrefix}/_meta` → `200 application/json`, body = the model's **effective** canonical serialization.
2. **Why effective** — the browser never resolves `extends`; ADR-0039 makes an own-vs-resolving error there silent rather than loud.
3. **Per-port table** — helper symbol per port, and that **only TypeScript ships a mount** (`mountMetaRoute`, `mountMetaRouteHono`); the other four are mounted by the host, with the reason (no web-bound runtime home; adding one would push a web dependency onto every consumer).
4. **Exposure** — opt-in to mount, guarded by the host's own middleware, the same answer #367 gives for generated routes. `/_meta` publishes model shape, not row data.
5. **Browser consumption** — `loadMetaModel(await fetch(...).then(r => r.text()))` → `buildGrid(model.object("Author")!)`, and that `runtime-web` imports metadata **values** only from `/constants` (#287).
6. **What is deferred** — per-entity routes, ETag/caching/versioning.

- [ ] **Step 2: Check every code sample actually runs as written**

For each sample, confirm the symbol names against the files created in Tasks 1–9. A doc sample naming a symbol that does not exist is the defect class #367's `.extra.ts` pointer was — generated or written output directing a reader at a mechanism that is not there.

- [ ] **Step 3: Link it**

Add a `GET /_meta` row to the endpoint list in `docs/features/api-contract.md` pointing at the new page. Do not restate the contract in both places.

- [ ] **Step 4: Verify docs drift gates**

Run: `meta verify --docs` (and `scripts/ci-local.sh --quick` if the docs gate lives there)
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add docs/features/metadata-api.md docs/features/api-contract.md
git commit -m "docs: the GET /_meta metadata API contract"
```

---

## Final verification

- [ ] `cd server/typescript && bun test` — scoped, per package
- [ ] `cd client/web/packages/runtime-web && bun test`
- [ ] `bun run --filter '*' build && bun run --filter '*' typecheck` from the repo root
- [ ] `cd server/java && mvn -q test` — the FULL reactor
- [ ] `cd server/csharp && dotnet test` — count the test lines, do not trust `Passed!`
- [ ] `cd server/python && python -m pytest -q`
- [ ] `scripts/ci-local.sh --quick` before opening a PR
- [ ] Update FR-029's Theme 1 table: UI-1 and UI-2 move from `📋 DESIGNED` to `✅ SHIPPED`

**Not in this plan, and deliberately:** UI-3 (`buildColumns` + `useMetaGrid`, per the 2026-06-16 slice-1 design §5.4/§5.5), UI-4 runtime forms, UI-7 both-ways demo, UI-8 verification. Each is its own plan once this one lands.

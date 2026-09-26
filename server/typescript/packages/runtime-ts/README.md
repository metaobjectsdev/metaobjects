# @metaobjectsdev/runtime-ts

Runtime metadata layer — CRUD, validation, relationship traversal, and view introspection driven by MetaObjects metadata.

Part of the [MetaObjects](https://github.com/metaobjectsdev/metaobjects) monorepo.

## Install

```bash
npm install @metaobjectsdev/runtime-ts @metaobjectsdev/metadata kysely
```

## Usage

```typescript
import { MetaDataLoader } from "@metaobjectsdev/metadata";
import { FileSource } from "@metaobjectsdev/metadata/core";
import { ObjectManager } from "@metaobjectsdev/runtime-ts";
import { kyselyDriver } from "@metaobjectsdev/runtime-ts/drivers";
import { Kysely } from "kysely";

const { root } = await new MetaDataLoader().load([
  new FileSource("metaobjects/meta.blog.json"),
]);

const om = new ObjectManager({
  metadata: root,
  driver: kyselyDriver({ db: kyselyInstance, dialect: "sqlite" }),
});

// CRUD
const post = await om.create("Post", { title: "Hello", body: "World", authorId: 1 });
const found = await om.findById("Post", post.id, { include: ["author"] });
const list = await om.findMany("Post", { authorId: 1, isPublished: true }, { limit: 10 });
await om.update("Post", post.id, { title: "Updated" });
await om.delete("Post", post.id);

// Filters (Mongo-style)
const recent = await om.findMany("Post", { createdAt: { $gte: "2026-05-01" } });
const search = await om.findMany("Post", { title: { $like: "%hello%" } });

// Validation (pure, no DB hit)
const result = om.validate("Post", { title: "x" });
if (!result.ok) console.log(result.errors);

// View introspection (for admin UIs / MCP tools)
const formSpec = om.entityView("Post", "edit");
// → { entityName, viewName, fields: [{ fieldName, controlType, attrs, required, ... }] }

// Transactions
await om.transaction(async (txOm) => {
  const user = await txOm.create("User", { /* ... */ });
  await txOm.create("Post", { authorId: user.id, /* ... */ });
});

// Reference strings (Java ObjectManager-compatible)
const ref = om.refOf("Post", post);   // "Post:42"
const reloaded = await om.load(ref);
```

## Drivers

Two drivers ship today:

- **`kyselyDriver({ db, dialect })`** — real DBs (SQLite via libsql/Turso, Postgres via node-postgres or Neon). User provides a Kysely instance.
- **`inMemoryDriver({ seed?, pkFields? })`** — Map-backed; useful for unit tests, prototyping, and MCP tool sandboxing where data shouldn't persist.

```typescript
import { inMemoryDriver } from "@metaobjectsdev/runtime-ts/drivers";

const driver = inMemoryDriver({
  seed: { posts: [{ id: 1, title: "Hello" }] },
  pkFields: { posts: ["id"] },
});
```

Future drivers (Drizzle, raw `pg`) can plug in without ObjectManager changes.

## Filter syntax

```typescript
type Filter =
  | { field: value }                              // equality
  | { field: null }                               // IS NULL
  | { field: [v1, v2] }                           // IN (...)
  | { field: { $eq | $ne | $gt | $gte | $lt | $lte | $like | $in | $isNull: ... } }
  | { $and: [...] };                              // explicit AND
```

`$or` and nested operators are not yet shipped.

## What is core here, and what `meta eject` hands you

This package has two tiers, and only the first is a MetaObjects guarantee
([ADR-0034 Amendment 3](https://github.com/metaobjectsdev/metaobjects/blob/main/spec/decisions/ADR-0034-codegen-scaffold-and-own.md)):

| Entry | Tier | What it is |
|---|---|---|
| `.` and `./drivers` | **Core** | The metadata-driven runtime: `ObjectManager`, the query builder, the validator runner, the relation / M:N / TPH resolvers, type coercion, the constraint-error mapping, `extractObject`. Conformance-gated; a defect here is a MetaObjects bug. |
| `./drizzle-fastify`, `./hono`, `./fastify` | **Helper** | The HTTP adapters that mount CRUD on a web framework: the mount helpers, the filter/sort parser, the error envelopes, pagination. Reference code, not a promise. |

Generated route files are the only callers of the helper tier, and they are yours once
you run `meta eject routes` (or `routes-hono`, or `entity` for the allowlist types). Eject
copies the adapter **source** the generated code calls — verbatim, from this package's
`src/` — into your repo at `codegen/runtime/`, and the ejected generators point their
output there. After that your generated and copied code import nothing from this package;
you install what the copy imports instead (`qs`, the framework, `@metaobjectsdev/metadata`).
Fix an adapter defect in your copy without waiting for a release.

To take a later upstream fix into your copy, compare the file with the version you have
installed and apply what you want:

```bash
meta eject --list        # marks each codegen/runtime/ file identical to / DIFFERING from this package
diff -u node_modules/@metaobjectsdev/runtime-ts/src/route-errors.ts codegen/runtime/route-errors.ts
```

A file you never changed can be refreshed wholesale with `meta eject routes --force`
(which also replaces the generator — commit first). A project that has not ejected keeps
importing `@metaobjectsdev/runtime-ts/drizzle-fastify` and `/hono` exactly as before. The
`./fastify` entry (the `ObjectManager`-backed mount) has no generator calling it, so eject
never copies it; it is still helper-tier, so copy it by hand if you mount it and want to
own it.

## Driver compatibility note

Generated CRUD uses Kysely's `.returning()` API. Works on:

- libsql / Turso
- node-postgres (`pg`)
- @neondatabase/serverless

Does NOT work on `better-sqlite3` or `bun:sqlite` (no native RETURNING). Users on those drivers should write a custom `PersistenceDriver` impl, or use `inMemoryDriver` for tests.

## License

Apache-2.0.

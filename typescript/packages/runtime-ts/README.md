# @metaobjects/runtime-ts

Runtime metadata layer — CRUD, validation, relationship traversal, and view introspection driven by MetaObjects metadata.

Part of the [MetaObjects](https://github.com/metaobjectsdev/metaobjects) monorepo.

## Install

```bash
npm install @metaobjects/runtime-ts @metaobjects/metadata kysely
```

## Usage

```typescript
import { FileMetaDataLoader } from "@metaobjects/metadata/core";
import { ObjectManager } from "@metaobjects/runtime-ts";
import { kyselyDriver } from "@metaobjects/runtime-ts/drivers";
import { Kysely } from "kysely";

const loader = new FileMetaDataLoader();
const { root } = await loader.loadFiles([".meta/memory/object/Post.json"]);

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

Two drivers ship in v0.1:

- **`kyselyDriver({ db, dialect })`** — real DBs (SQLite via libsql/Turso, Postgres via node-postgres or Neon). User provides a Kysely instance.
- **`inMemoryDriver({ seed?, pkFields? })`** — Map-backed; useful for unit tests, prototyping, and MCP tool sandboxing where data shouldn't persist.

```typescript
import { inMemoryDriver } from "@metaobjects/runtime-ts/drivers";

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

`$or` and nested operators are deferred to v0.1.x.

## Driver compatibility note

Generated CRUD uses Kysely's `.returning()` API. Works on:

- libsql / Turso (the trainer website's stack)
- node-postgres (`pg`)
- @neondatabase/serverless

Does NOT work on `better-sqlite3` or `bun:sqlite` (no native RETURNING). Users on those drivers should write a custom `PersistenceDriver` impl, or use `inMemoryDriver` for tests.

## License

Apache-2.0.

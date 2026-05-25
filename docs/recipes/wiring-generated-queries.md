# Wiring generated queries

Generated CRUD helpers in `<Entity>.queries.ts` take a Drizzle persistence-context
(`db`) as their first argument. This recipe shows how to wire them in any
runtime — long-lived Node, Cloudflare Workers, multi-tenant servers, tests.

> **Why this shape?** ADR-0008 documents the cross-language decision: every
> language port's generated repo helpers accept their persistence-context as a
> parameter. The module-level singleton breaks on edge runtimes, multi-tenant
> servers, and isolated tests. See [ADR-0008](../../spec/decisions/ADR-0008-parameter-passing-generated-repo-helpers.md)
> for the full rationale.

## TL;DR

```ts
import { findUserById, listUsers, createUser } from "./generated/User.queries";

const user = await findUserById(db, "abc");
const users = await listUsers(db, { limit: 50 });
const created = await createUser(db, { name: "Alice", email: "a@b.c" });
```

Pass any Drizzle instance whose type matches the generated `type Db = ...` at
the top of `<Entity>.queries.ts`.

## Setting up `db` per dialect

### SQLite (libsql / Turso)

```ts
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";

const client = createClient({ url: process.env.DATABASE_URL! });
export const db = drizzle(client);
```

### Cloudflare D1

D1 bindings are **request-scoped** — there is no module-level `db`. Construct
inside the request handler:

```ts
import { drizzle } from "drizzle-orm/d1";

export default {
  async fetch(req: Request, env: { DB: D1Database }) {
    const db = drizzle(env.DB);
    const user = await findUserById(db, "abc");
    return Response.json(user);
  },
} satisfies ExportedHandler<{ DB: D1Database }>;
```

This is the consumer-friction case FR2 fixes: pre-0.7.0 codegen forced workers
adopters to ship a runtime-throwing module stub purely to satisfy the
typecheck.

### Postgres (node-postgres)

```ts
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const db = drizzle(pool);
```

### Multi-tenant Postgres

A different pool (or pool selection) per tenant:

```ts
function dbForTenant(tenantId: string) {
  const pool = poolsByTenant.get(tenantId);
  if (!pool) throw new Error(`unknown tenant ${tenantId}`);
  return drizzle(pool);
}

app.get("/users/:id", (req, res) => {
  const db = dbForTenant(req.headers["x-tenant-id"]);
  return findUserById(db, req.params.id);
});
```

## Wiring in Hono (edge-first)

Hono is the de facto edge HTTP router in 2026. Generated queries compose with
it directly — no metaobjects-specific Hono integration needed.

```ts
import { Hono, type Context } from "hono";
import { drizzle } from "drizzle-orm/d1";
import {
  findUserById,
  listUsers,
  createUser,
  updateUser,
  deleteUserById,
} from "./generated/User.queries";

type Env = { Bindings: { DB: D1Database } };

const users = new Hono<Env>();

const getDb = (c: Context<Env>) => drizzle(c.env.DB);

users.get("/:id", async (c) => {
  const user = await findUserById(getDb(c), c.req.param("id"));
  return user ? c.json(user) : c.notFound();
});

users.get("/", async (c) => {
  const limit = Number(c.req.query("limit") ?? 50);
  return c.json(await listUsers(getDb(c), { limit }));
});

users.post("/", async (c) => {
  const created = await createUser(getDb(c), await c.req.json());
  return c.json(created, 201);
});

users.patch("/:id", async (c) => {
  const updated = await updateUser(getDb(c), c.req.param("id"), await c.req.json());
  return updated ? c.json(updated) : c.notFound();
});

users.delete("/:id", async (c) => {
  const ok = await deleteUserById(getDb(c), c.req.param("id"));
  return ok ? c.body(null, 204) : c.notFound();
});

const app = new Hono<Env>();
app.route("/api/users", users);
export default app;
```

The same shape works against [itty-router](https://itty.dev), `Hono` v5, or
raw `fetch()` handlers — pick whichever matches your runtime.

## Wiring in Fastify (Node)

For Node consumers, `routesFile()` still emits Fastify routes (unchanged in
0.7.0; it imports its own `db` from `<dbImport>` via the runtime-ts helpers).
If you want to hand-roll routes against the generated queries instead:

```ts
import Fastify from "fastify";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { findUserById, listUsers, createUser } from "./generated/User.queries";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool);

const app = Fastify();

app.get("/users/:id", async (req) => {
  const user = await findUserById(db, (req.params as any).id);
  if (!user) throw app.httpErrors.notFound();
  return user;
});

app.get("/users", async (req) => {
  const { limit = "50" } = req.query as any;
  return listUsers(db, { limit: Number(limit) });
});

app.post("/users", async (req, reply) => {
  reply.code(201);
  return createUser(db, req.body);
});

app.listen({ port: 3000 });
```

## Wiring with raw `fetch()` / itty-router

No HTTP framework needed:

```ts
import { Router } from "itty-router";
import { drizzle } from "drizzle-orm/d1";
import { findUserById } from "./generated/User.queries";

const router = Router();

router.get("/users/:id", async (req, env: { DB: D1Database }) => {
  const db = drizzle(env.DB);
  const user = await findUserById(db, req.params.id);
  return user ? Response.json(user) : new Response(null, { status: 404 });
});

export default { fetch: router.fetch };
```

## Composing generated queries with custom routes

Generated queries do not lock you into "all CRUD, in this shape." Pick the
verbs you want; hand-write whatever's interesting:

```ts
import { Hono } from "hono";
import { findUserById, updateUser } from "./generated/User.queries";
import { drizzle } from "drizzle-orm/d1";

const app = new Hono<{ Bindings: { DB: D1Database } }>();

// Hand-written endpoint — custom verb, custom logic
app.post("/users/:id/promote", async (c) => {
  const db = drizzle(c.env.DB);
  const user = await findUserById(db, c.req.param("id"));
  if (!user) return c.notFound();
  await updateUser(db, user.id, { role: "admin", promotedAt: Date.now() });
  return c.json({ ok: true });
});

// Generated endpoint (composed via routesFile output, or hand-written from the
// queries directly — your call)
app.get("/users/:id", async (c) => {
  const user = await findUserById(drizzle(c.env.DB), c.req.param("id"));
  return user ? c.json(user) : c.notFound();
});
```

## Wrapping into your own `Generator` factory

If you want your routes generated rather than hand-rolled, the codegen plugin
model lets you ship your own. Roughly:

```ts
// metaobjects-routes-hono.ts — a custom Generator
import { type Generator, type GenContext, type EmittedFile, perEntity } from "@metaobjectsdev/codegen-ts";

export const honoRoutesFile = (): Generator => ({
  name: "hono-routes-file",
  filter: (e) => e.subType === "entity",
  generate: perEntity((entity, ctx): EmittedFile => {
    const name = entity.name;
    const lower = name.charAt(0).toLowerCase() + name.slice(1);
    return {
      path: `${name}.hono.ts`,
      content: `// @generated by @metaobjectsdev/codegen-ts — DO NOT EDIT.
import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { find${name}ById, list${name}s, create${name} } from "./${name}.queries";

const ${lower}s = new Hono<{ Bindings: { DB: D1Database } }>();
const getDb = (c: any) => drizzle(c.env.DB);

${lower}s.get("/:id", async (c) => {
  const item = await find${name}ById(getDb(c), c.req.param("id"));
  return item ? c.json(item) : c.notFound();
});

${lower}s.get("/", async (c) => c.json(await list${name}s(getDb(c), {})));
${lower}s.post("/", async (c) => c.json(await create${name}(getDb(c), await c.req.json()), 201));

export default ${lower}s;
`,
    };
  }),
});
```

Then wire it into `metaobjects.config.ts`:

```ts
import { defineConfig } from "@metaobjectsdev/cli";
import { entityFile, queriesFile, barrel } from "@metaobjectsdev/codegen-ts/generators";
import { honoRoutesFile } from "./metaobjects-routes-hono";

export default defineConfig({
  outDir: "src/generated",
  dialect: "sqlite",
  apiPrefix: "/api",
  generators: [entityFile(), queriesFile(), honoRoutesFile(), barrel()],
});
```

> **Note for D1 consumers:** codegen-ts only knows `"sqlite" | "postgres"`. D1 is
> SQLite at the SQL level, so codegen uses `dialect: "sqlite"`. The D1-specific
> `--dialect d1` is a `meta migrate` CLI flag (it controls migration transport +
> file layout), not a codegen config value.

## Migration from 0.6.0

```bash
bun add -E @metaobjectsdev/cli@0.7.0
meta gen
```

Then update consumer call sites — every generated CRUD call gains `db` as the
first arg:

| Before | After |
|---|---|
| `findUserById("abc")` | `findUserById(db, "abc")` |
| `listUsers({ limit: 50 })` | `listUsers(db, { limit: 50 })` |
| `createUser({ ... })` | `createUser(db, { ... })` |
| `updateUser("abc", { ... })` | `updateUser(db, "abc", { ... })` |
| `deleteUserById("abc")` | `deleteUserById(db, "abc")` |

The mechanical search-and-replace at every call site is the migration cost. If
you prefer the old call-site shape in Node, wrap each function in a one-liner:

```ts
// shims.ts
import * as Q from "./generated/User.queries";
import { db } from "./db";

export const findUserById = (id: string) => Q.findUserById(db, id);
export const listUsers = (opts: Parameters<typeof Q.listUsers>[1]) => Q.listUsers(db, opts);
// ... etc.
```

Then import from `./shims` instead of `./generated/User.queries` and your
existing call sites keep working.

## See also

- [ADR-0008](../../spec/decisions/ADR-0008-parameter-passing-generated-repo-helpers.md)
  — the cross-language decision rationale.
- [Cloudflare Workers recipe](./cloudflare-workers.md) — Vite + Workers deploy.

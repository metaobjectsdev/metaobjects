# Recipe: Next.js (App Router) + Vercel

**This is a convenience path, not a capability.** Nothing in it is Next.js support in
any `@metaobjectsdev/*` package — every step below is something the general retargeting
procedure already produces, and that procedure is the thing to learn: it lives in the
`metaobjects-codegen` skill (`SKILL.md` → *"Your framework isn't the default"*, with the
per-knob detail in `references/typescript.md`). Read this page as a shortcut past
reasoning you could have done yourself, and reach for the skill the moment your stack
stops matching the table below. Deleting this file would cost convenience and nothing
else.

## 1. Stack

| Layer | Choice |
|---|---|
| Framework | Next.js App Router (Server Components + Route Handlers) |
| Bundler | Turbopack (Next's default) |
| HTTP layer for generated routes | Hono, via `routesFileHono()` + `@metaobjectsdev/runtime-ts/hono` |
| Route mount | `app/api/[[...route]]/route.ts` using `hono/vercel` |
| Client tier | `@metaobjectsdev/codegen-ts-react` (forms) + `@metaobjectsdev/codegen-ts-tanstack` (hooks, grids) |
| Host | Vercel (Fluid compute) |
| Database | any Postgres/SQLite reachable from a Node runtime |

## 2. The config delta

Three values in `metaobjects.config.ts` differ from a stock `meta init` project. Each is
a fact about *this stack*, not about your model — which is why all three are codegen
config and none of them is metadata.

```ts
import { defineConfig } from "@metaobjectsdev/cli";
// Owned generators. `meta init` scaffolds entity/queries/routes/barrel;
// routes-hono and the UI tier are reached with `meta eject` (§6).
import { entityFile } from "./codegen/generators/entity.js";
import { queriesFile } from "./codegen/generators/queries.js";
import { routesFileHono } from "./codegen/generators/routes-hono.js";
import { barrel } from "./codegen/generators/barrel.js";

export default defineConfig({
  outDir: "src/generated",
  dialect: "postgres",
  apiPrefix: "/api",

  // 1. Turbopack does NOT perform the TypeScript `.js` → `.ts` specifier rewrite, so
  //    the default `extStyle: "js"` makes the generated tree unresolvable — including
  //    imports BETWEEN two generated files. Vite and esbuild accept `.js`; webpack
  //    needs `resolve.extensionAlias`. Retest rather than assuming either value.
  extStyle: "none",

  // 2. React Server Components compile server and client from ONE tree, so a module
  //    using hooks must declare itself. This prepends `"use client";` to the generated
  //    form, hooks, columns and grid-hook modules. Defaults to false, because outside
  //    RSC the directive is inert and some bundlers warn on it.
  clientDirective: true,

  generators: [entityFile(), queriesFile(), routesFileHono(), barrel()],
});
```

`<Entity>.meta.ts` deliberately does **not** get the directive. It is plain data with no
hooks and no React import — imported *by* a client component, which under RSC is exactly
where the boundary already is. The directive marks the boundary module, not everything
reachable from it.

> `clientDirective` is idempotent and quote-tolerant: if you hand-edit a generated file
> to add `'use client'` yourself, regen preserves the edit and does not add a second copy.

## 3. Mounting the generated routes

`routesFileHono()` emits one file per persistable entity — `<Entity>.routes.hono.ts` —
each exporting a registration function that takes its persistence client as an **injected
dependency** rather than importing a module singleton:

```ts
export function registerAuthorRoutes(app: Hono<any, any, any>, deps: { db: unknown }): void
```

(The generics are open because the Hono bindings and variables are yours to define; a
wrapper of your own should stay equally open or it will not accept your typed app.)

That signature is the whole reason this generator suits Next.js: the routes do not decide
where `db` comes from, so a Route Handler can hand them a connection it owns. Mount them
once, in a catch-all Route Handler:

```ts
// app/api/[[...route]]/route.ts
import { Hono } from "hono";
import { handle } from "hono/vercel";
import { db } from "@/lib/db";
import { registerAuthorRoutes } from "@/generated/Author.routes.hono";
import { registerBookRoutes } from "@/generated/Book.routes.hono";

export const runtime = "nodejs";

const app = new Hono();
registerAuthorRoutes(app, { db });
registerBookRoutes(app, { db });

export const GET = handle(app);
export const POST = handle(app);
export const PATCH = handle(app);
export const DELETE = handle(app);
```

**Do not set a Hono `basePath`.** The generated routes already bake `apiPrefix` into
their paths as a literal, so with `apiPrefix: "/api"` the emitted route is `/api/authors`
— the same path the `app/api/` folder receives. A `basePath("/api")` on top would mount
them at `/api/api/authors`. Keep the two in agreement: whatever folder the catch-all
lives in is what `apiPrefix` must say.

The optional-catch-all `[[...route]]` (double brackets) rather than `[...route]` is what
lets the collection endpoint `/api/authors` and the item endpoint `/api/authors/123` both
reach the same handler.

Adding an entity means adding a `register…Routes` line. That file is yours; it is not
generated, and nothing regenerates over it.

## 4. Calling generated queries from a Server Component

`queriesFile()` emits helpers that take `db` as a parameter — `findAuthorById(db, id)`,
`listAuthors(db, { limit, offset })` — so a Server Component can call them directly. No
HTTP hop, no fetch, no serialization:

```tsx
// app/authors/page.tsx
import { db } from "@/lib/db";
import { listAuthors } from "@/generated/Author.queries";

export default async function AuthorsPage() {
  const authors = await listAuthors(db, { limit: 50 });
  return <ul>{authors.map((a) => <li key={a.id}>{a.name}</li>)}</ul>;
}
```

### The trap: this page prerenders at build time

**A direct database call is not a dynamic signal.** Next opts a route out of static
rendering when it sees a dynamic API — `cookies()`, `headers()`, `searchParams`, an
uncached `fetch`. Reading your database through a driver is none of those, so the page
above is **statically prerendered at build** and then serves the build-time rows to every
visitor, indefinitely, with no error and no warning. It looks like a caching bug and it is
not one: the framework was never told this page depends on anything.

Say so explicitly. Per route:

```ts
export const dynamic = "force-dynamic";   // render on every request
// ...or, for time-based revalidation instead:
export const revalidate = 60;             // regenerate at most once a minute
```

This is the single most likely thing to go wrong in this recipe, and it fails silently in
production while looking correct in `next dev` — where every request re-renders anyway.
Check it against a `next build && next start`, not against the dev server.

The generated **hooks** (`@metaobjectsdev/codegen-ts-tanstack`) have no such problem: they
run in a client component against the HTTP routes from §3, so they fetch per request by
construction. Use Server Components for the first paint and hooks where the client needs
to refetch — the two consume the same model and stay consistent because both are generated
from it.

## 5. The database connection on Vercel

Under Fluid compute an instance is **suspended between requests** rather than torn down.
A pooled TCP connection can therefore outlive the request that opened it and then find its
sockets severed while idle, so the next invocation fails on a connection the pool still
believes is good.

Register the pool so the runtime can drain it before suspending:

```ts
// lib/db.ts
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { attachDatabasePool } from "@vercel/functions";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
attachDatabasePool(pool);

export const db = drizzle(pool);
```

Two notes on scope. This is host guidance, not MetaObjects behaviour — the generated code
never opens a connection, which is exactly why `lib/db.ts` is yours to write and why both
`queriesFile` and `routesFileHono` take `db` as a parameter. And it applies to a **pooled
TCP driver**; an HTTP-based driver (Neon serverless, PlanetScale) holds no socket between
requests and needs none of this. Vercel's own connection-management documentation is the
authority on the current API — check it rather than trusting this snippet's shape after a
runtime change.

Set `export const runtime = "nodejs"` on any route that touches a TCP driver, as §3 does.
The edge runtime has no TCP sockets.

## 6. Changing what is emitted

Everything above is configuration. When you need different *output* — a different route
shape, a different form library, an auth wrapper around every handler — take the generator:

```bash
meta eject --list           # all nine reference templates, grouped by package
meta eject routes-hono      # → codegen/generators/routes-hono.ts
meta eject form             # → codegen/generators/form.ts
meta eject hooks            # → codegen/generators/hooks.ts
```

`eject` copies the reference template into `codegen/generators/`, prints the exact import
line to put in `metaobjects.config.ts` **in place of** the package import, and never
clobbers a file you already own.

**It reports two of the three dependency tiers; the third is on you.** `meta init`
declares the `@metaobjectsdev/*` packages its four scaffolded generators import
(`codegen-ts`, `metadata`), and `eject` names any further `@metaobjectsdev/*` package the
template you just took imports — `codegen-ts-react` for `form`, `codegen-ts-tanstack` for
`hooks`/`grid`/`grid-hook`. Neither says anything about what the *emitted* code imports,
because that is not visible in the generator's own import list. For `routes-hono` that
means **`hono` and `@metaobjectsdev/runtime-ts`** (the emitted file imports
`mountCrudRoutes` from its `/hono` subpath) — add both yourself, or the first `tsc` after
`meta gen` reports TS2307 on the generated routes rather than on anything eject touched.

An ejected generator is ordinary TypeScript you maintain. The metadata walk at the top of
each template is framework-neutral and usually stays as-is; the emit at the bottom is the
seam. This is the supported path, not an escape hatch — and it is the same path an adopter
on Svelte, Nuxt or Qwik takes, where no recipe exists at all.

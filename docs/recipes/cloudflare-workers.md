# Recipe — Deploying MetaObjects-codegen output to Cloudflare Workers (with Vite)

Cloudflare Workers is one of the most common edge deployment targets in 2026.
This recipe documents what runs in V8 isolates, how `meta gen` slots into a
Vite + Wrangler build chain, and the gotchas that took multiple sessions to
learn the first time around.

## Which `@metaobjectsdev/*` packages run in Workers?

Workers run V8 isolates with a Node.js compatibility flag. Not every package
is V8-isolate-safe. The table below is the authoritative split:

| Package | Workers-compatible? | Notes |
|---|---|---|
| `@metaobjectsdev/cli` | Build-time only | Run on the developer's machine; never bundled into the Worker. |
| `@metaobjectsdev/metadata` | Build-time only | Same. |
| `@metaobjectsdev/codegen-ts` | Build-time only | Same. |
| `@metaobjectsdev/migrate-ts` | Build-time only | Migrations emit SQL, then `wrangler d1 migrations apply` runs them. |
| `@metaobjectsdev/render` | ✅ Runtime-safe | Pure JS, no Node-only deps. Used at request time. |
| `@metaobjectsdev/runtime-ts` | ⚠️ Only the `/hono` entry | The Fastify and Kysely entry points are Node-only. The `/hono` entry is what generated Hono routes import. |
| `@metaobjectsdev/runtime-web` | ✅ Runtime-safe | Pure browser/edge JS. |
| `@metaobjectsdev/react` | ✅ Runtime-safe | Browser; works in Workers if you render React on the edge. |
| `@metaobjectsdev/tanstack` | ✅ Runtime-safe | Browser-side. |
| Generated `<Entity>.entity.ts` / `<Entity>.queries.ts` | ✅ Runtime-safe | The generated code is the runtime; uses `drizzle-orm/d1`. |
| Generated `<Entity>.routes.ts` (Fastify, default) | ❌ Node-only | The handlers are Workers-safe but the Fastify adapter from `runtime-ts` is not. Use the Hono generator instead. |
| Generated Hono routes (`routesFileHono()`) | ✅ Runtime-safe | The opt-in Workers routes generator. It imports only the `@metaobjectsdev/runtime-ts/hono` entry point (Hono, Drizzle, Zod; no Fastify, Kysely or `node:` import in that module graph). Wire it in `metaobjects.config.ts` in place of `routesFile()`. |

## Project layout

The minimum-friction shape for a Workers + Vite + MO project:

```
project-root/
├── metaobjects/                       # MO metadata (source of truth)
├── metaobjects.config.ts
├── src/
│   ├── worker.ts                      # Worker entrypoint (the SPA's API)
│   └── ui/                            # React SPA source
│       ├── index.html
│       └── main.tsx
├── public/                            # Hand-curated static (favicons, robots.txt, etc.)
├── dist/                              # Vite output (gitignored)
└── wrangler.toml                      # Workers config
```

## Vite + Workers Static Assets gotcha: `emptyOutDir: false`

`vite.config.ts` must set `build.emptyOutDir: false` if you want hand-curated
files in `dist/` to survive a `vite build`. With Vite 5+'s default of
`emptyOutDir: true`, the build wipes anything Vite didn't produce itself —
destroying any pre-staged assets, including files copied by other build
steps.

```ts
// vite.config.ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    emptyOutDir: false,     // ← critical for Workers Static Assets integration
    outDir: "dist",
    rollupOptions: {
      input: { main: "src/ui/index.html" },
    },
  },
});
```

`wrangler.toml` points `assets.directory = "./dist"` and `main = "./src/worker.ts"`:

```toml
name = "myapp"
main = "./src/worker.ts"
compatibility_date = "2026-01-01"
compatibility_flags = ["nodejs_compat"]

[assets]
directory = "./dist"
binding = "ASSETS"

[[d1_databases]]
binding = "DB"
database_name = "myapp-prod"
database_id = "abc-123..."
```

## Build chain

The dev-time loop:

```bash
$ meta gen                    # codegen runs locally; output is committed
$ vite dev                    # SPA dev server
$ wrangler dev                # worker dev server (proxied for /api)
```

The deploy loop:

```bash
$ meta gen                    # in case metadata changed; commit any drift
$ vite build                  # bundles the SPA into ./dist/
$ wrangler deploy             # uploads worker + assets
```

`meta gen` runs once per metadata change, not per build. The output is
committed. A CI gate can run `meta gen` then `git diff --exit-code` to
enforce that committed generated code matches the metadata — drift fails
the build.

## D1 migration loop

```bash
$ meta migrate --dialect d1 --slug my-change       # emits migrations/<seq>_my-change.sql
$ wrangler d1 migrations apply <BINDING>           # local
$ wrangler d1 migrations apply <BINDING> --remote  # production
```

`migrations_dir` in `wrangler.toml` and `--out-dir` in `meta migrate` should
agree (default `migrations/` matches Wrangler's expectation).

For the full D1 dialect documentation, see the
[`@metaobjectsdev/migrate-ts` README](../../server/typescript/packages/migrate-ts/README.md).

## Codegen dialect is `sqlite`, not `d1`

D1 is SQLite. In `metaobjects.config.ts` set `dialect: "sqlite"`: the generated tables are
`sqliteTable`, timestamps are ISO strings, and the routes use SQLite `RETURNING`. `"d1"` names
only the **`meta migrate` transport** (`migrate.dialect` in `.metaobjects/config.json`,
`--dialect d1`), which shells out to Wrangler. `meta gen` and `meta verify --codegen` refuse any
codegen dialect other than `sqlite`, `postgres` or `mysql`, and say so for `"d1"`, rather than
quietly generating Postgres.

## Generated routes and queries on a Worker, per request

Use `routesFileHono()` (not the Fastify `routesFile()`) and `queriesFile()`:

```ts
// metaobjects.config.ts
import { defineConfig } from "@metaobjectsdev/cli";
import { entityFile, queriesFile, routesFileHono, barrel } from "@metaobjectsdev/codegen-ts/generators";

export default defineConfig({
  outDir: "src/generated",
  dialect: "sqlite",            // D1 is SQLite
  extStyle: "js",
  apiPrefix: "/api",
  generators: [entityFile(), queriesFile(), routesFileHono(), barrel()],
});
```

Neither generated module imports a module-level `db`. Both take it as an argument:

- `Note.queries.ts` exports `listNotes(db, opts?)`, `findNoteById(db, id)`, `createNote(db, ...)`
  and so on, each with `db` as the first parameter.
- `Note.routes.hono.ts` exports `registerNoteRoutes(app, { db })`. The `db` is captured when the
  routes are **mounted**, not looked up per call.

A D1 binding only exists on `env`, inside `fetch`, so build the Drizzle client there and mount
the generated routes on a Hono app for that request:

```ts
// src/worker.ts
import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { registerNoteRoutes } from "./generated/Note.routes.hono.js";
import { listNotes } from "./generated/Note.queries.js";

interface Env {
  DB: D1Database;          // from @cloudflare/workers-types
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const db = drizzle(env.DB);                       // one client per request

    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ notes: (await listNotes(db, {})).length });   // queries: plain calls
    }

    const app = new Hono<{ Bindings: Env }>();
    registerNoteRoutes(app, { db });                  // routes: mounted with this request's db
    return app.fetch(request, env, ctx);
  },
};
```

Registering the five routes is cheap, so doing it per request is fine. If you would rather mount
once, build the app lazily on the first request (`let app: Hono | undefined`) and keep it for the
isolate: the binding on `env` does not change for the life of the deployed version. Do not
mount at module scope, where `env` does not exist yet, and do not pass a placeholder such as
`drizzle({} as never)`: it type-checks and then fails on the first query.

Add your guard before the mount: [Guarding generated routes](guarding-generated-routes.md).

Wrangler needs only the binding the code reads:

```toml
# wrangler.toml
name = "myapp"
main = "./src/worker.ts"
compatibility_date = "2026-01-01"
compatibility_flags = ["nodejs_compat"]

[[d1_databases]]
binding = "DB"                       # env.DB above
database_name = "myapp-prod"
database_id = "<your-database-id>"
migrations_dir = "migrations"        # where `meta migrate --dialect d1` writes
```

### What was checked

Generated from a one-entity model with `dialect: "sqlite"`, then compiled with `tsc --strict`
(`module: nodenext`) together with the `worker.ts` above against the real `drizzle-orm/d1`,
`hono` and `@metaobjectsdev/runtime-ts` types. `D1Database` and `ExecutionContext` came from a
local stub in place of `@cloudflare/workers-types`, which that environment does not install.
The same per-request mount (a new Hono app and `registerNoteRoutes` per request) was run against
an in-memory libSQL database, which shares D1's SQLite dialect: `POST /api/notes` answered 201
and `GET /api/notes` answered 200 with the row. D1 itself, `wrangler dev` and a deployed Worker
were not exercised.

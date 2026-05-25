# Recipe — Deploying MetaObjects-codegen output to Cloudflare Workers (with Vite)

Cloudflare Workers is one of the most common edge deployment targets in 2026.
This recipe documents what runs in V8 isolates, how `meta gen` slots into a
Vite + Wrangler build chain, and the gotchas that took multiple sessions to
learn the first time around.

## Which `@metaobjectsdev/*` packages run in Workers?

Workers run V8 isolates with a Node.js compatibility flag. Not every package
is V8-isolate-safe. The table below is the authoritative split as of 0.6.0:

| Package | Workers-compatible? | Notes |
|---|---|---|
| `@metaobjectsdev/cli` | Build-time only | Run on the developer's machine; never bundled into the Worker. |
| `@metaobjectsdev/metadata` | Build-time only | Same. |
| `@metaobjectsdev/codegen-ts` | Build-time only | Same. |
| `@metaobjectsdev/migrate-ts` | Build-time only | Migrations emit SQL, then `wrangler d1 migrations apply` runs them. |
| `@metaobjectsdev/render` | ✅ Runtime-safe | Pure JS, no Node-only deps. Used at request time. |
| `@metaobjectsdev/runtime-ts` | ❌ Node-only | Fastify + Kysely drivers. Not for Workers. |
| `@metaobjectsdev/runtime-web` | ✅ Runtime-safe | Pure browser/edge JS. |
| `@metaobjectsdev/react` | ✅ Runtime-safe | Browser; works in Workers if you render React on the edge. |
| `@metaobjectsdev/tanstack` | ✅ Runtime-safe | Browser-side. |
| Generated `<Entity>.entity.ts` / `<Entity>.queries.ts` | ✅ Runtime-safe | The generated code is the runtime; uses `drizzle-orm/d1`. |
| Generated `<Entity>.routes.ts` | ⚠️ Mostly | Route handlers themselves are Workers-safe, but the Fastify adapter from `runtime-ts` is not. Workers adopters skip the routes generator and write their own minimal-API mounting. |

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

## Skipping the routes generator

Workers consumers typically skip the routes generator entirely — Fastify-based
routes don't run in V8 isolates. Hand-write your `fetch` handler against the
generated queries:

```ts
// src/worker.ts
import { drizzle } from "drizzle-orm/d1";
import { findUserById, listUsers } from "./generated/User.queries";
import * as schema from "./generated/schema";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const db = drizzle(env.DB, { schema });
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/users/")) {
      const id = url.pathname.slice("/api/users/".length);
      const user = await findUserById(db, id);
      return Response.json(user);
    }
    if (url.pathname === "/api/users") {
      return Response.json(await listUsers(db, {}));
    }
    // Static assets handled by Workers Static Assets binding.
    return env.ASSETS.fetch(request);
  },
};

interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
}
```

> Note: `findUserById(db, id)` parameter-passing landing in 0.7.0 (FR2).
> If you're on 0.6.x today, the generated queries import a module-level `db`
> from `../db` instead — see the [0.6.0 release notes](../../CHANGELOG.md) for migration guidance.

# FR: Cloudflare Workers + Vite deploy recipe (TS docs)

**Status:** Design — implementation-ready
**Date:** 2026-05-25
**Scope:** TypeScript / documentation only (`README.md` + a new
`docs/recipes/cloudflare-workers.md`)
**Origin:** Friction observed in a downstream consumer assembling Cloudflare Workers +
Vite + MO codegen on their own — multiple sessions spent figuring out which packages run
in V8 isolates, how to wire `meta gen` into `vite build` + `wrangler deploy`, and how to
integrate Vite output with Workers Static Assets without wiping hand-curated files.

## Goal

Document MO's Cloudflare Workers story explicitly so adopters don't have to derive it.
Cover the four constraints that took multiple sessions of trial-and-error to learn:

1. Which `@metaobjectsdev/*` packages are V8-isolate compatible.
2. How to integrate Vite output with Workers Static Assets (the `emptyOutDir: false`
   discipline).
3. How `meta gen` slots into the dev/build chain alongside `vite build` and `wrangler deploy`.
4. The dev-only / build-time nature of codegen (run locally, commit output, never invoke
   from a request handler).

## Why TS-only

Cloudflare Workers run V8 isolates with a Node.js compatibility flag. The constraints
described here are JavaScript-runtime-specific. Java / C# / Python ports do not run in
Workers and need separate deploy recipes for their respective runtimes (already-existing
JVM containers, .NET Lambdas, FastAPI on Cloud Run, etc.) when those ports ship runtime
surfaces.

## Design

### Section 1 — Which packages run in Workers

| Package | Workers-compatible? | Notes |
|---|---|---|
| `@metaobjectsdev/cli` | Build-time only | Run on the developer's machine; never bundled. |
| `@metaobjectsdev/metadata` | Build-time only | Same. |
| `@metaobjectsdev/codegen-ts` | Build-time only | Same. |
| `@metaobjectsdev/migrate-ts` | Build-time only | Migrations emit SQL, then `wrangler d1 migrations apply` runs them. |
| `@metaobjectsdev/render` | ✅ Runtime-safe | Pure JS, no Node-only deps. |
| `@metaobjectsdev/runtime-ts` | ❌ Node-only | Fastify + Kysely drivers. Not for Workers. |
| `@metaobjectsdev/runtime-web` | ✅ Runtime-safe | Pure browser/edge JS. |
| `@metaobjectsdev/react` | ✅ Runtime-safe | Browser; works in Workers if you render React on the edge. |
| `@metaobjectsdev/tanstack` | ✅ Runtime-safe | Browser-side. |
| Generated `<Entity>.entity.ts` / `<Entity>.queries.ts` | ✅ Runtime-safe | The generated code is the runtime; uses `drizzle-orm/d1`. |
| Generated `<Entity>.routes.ts` | ⚠️ Mostly | The route handlers themselves are Workers-safe, but the Fastify adapter from `runtime-ts` is not. Worker adopters skip the routes generator and write their own minimal-API mounting. |

### Section 2 — Vite + Workers Static Assets integration

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

`vite.config.ts` must set `build.emptyOutDir: false` if you want hand-curated files in
`dist/` to survive a `vite build`. With Vite 5+'s default of `emptyOutDir: true`, the
build wipes anything Vite didn't produce itself — destroying any pre-staged assets.

`wrangler.toml` points `assets.directory = "./dist"` and `main = "./src/worker.ts"`.

### Section 3 — Build chain

The dev-time loop:

```
$ meta gen        # codegen runs locally; output is committed
$ vite dev        # SPA dev server
$ wrangler dev    # worker dev server (proxied for /api)
```

The deploy loop:

```
$ meta gen        # in case metadata changed; commit any drift
$ vite build      # bundles the SPA into ./dist/
$ wrangler deploy # uploads worker + assets
```

**`meta gen` runs once per metadata change, not per build.** The output is committed.
A CI gate can run `meta gen` then `git diff --exit-code` to enforce that committed
generated code matches the metadata — drift fails the build.

### Section 4 — D1 migration loop

```
$ meta migrate --dialect d1 --slug my-change   # emits migrations/<seq>_my-change.sql
$ wrangler d1 migrations apply <BINDING>       # local
$ wrangler d1 migrations apply <BINDING> --remote   # production
```

`migrations_dir` in `wrangler.toml` and `--out-dir` in `meta migrate` should agree
(default `migrations/` matches Wrangler's expectation).

## Out of scope

- A starter / template repo. Worth doing eventually; not part of this FR.
- Edge-side cron, queue, or workflow integrations.
- React SPA on the edge (SSR / streaming). The recipe assumes client-side render.

## Open questions

1. Should `routesFile()` get an optional `target: "fastify" | "workers" | "hono"` flag so
   Workers adopters can opt into a generated minimal-API handler instead of skipping
   route generation entirely? Useful, but a separate FR — file as follow-up if appetite
   materializes.

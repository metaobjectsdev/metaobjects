# TypeScript port

The reference implementation. Published to npm at `0.7.0-rc.1` as 12
`@metaobjectsdev/*` packages on the `latest` tag. Targets Node-compatible
runtimes; Bun-first dev workflow.

## Install

```bash
npm install --save-dev @metaobjectsdev/cli @metaobjectsdev/codegen-ts
npm install            @metaobjectsdev/metadata @metaobjectsdev/runtime-ts
```

For React + TanStack codegen / runtime, add:

```bash
npm install --save-dev @metaobjectsdev/codegen-ts-react @metaobjectsdev/codegen-ts-tanstack
npm install            @metaobjectsdev/react @metaobjectsdev/tanstack @metaobjectsdev/runtime-web
```

## Configure

Two config files, by design:

- **`metaobjects.config.ts`** — TypeScript, type-checked, generator wiring.
- **`.metaobjects/config.json`** — JSON, static project state, parseable by
  non-TS tooling.

`meta init` scaffolds both, the `metaobjects/` source directory, and the
`.gitignore` entries for `.metaobjects/.gen-state/`.

```ts
// metaobjects.config.ts
import { defineConfig } from "@metaobjectsdev/cli";
import {
  entityFile,
  queriesFile,
  routesFile,
  barrel,
} from "@metaobjectsdev/codegen-ts/generators";

export default defineConfig({
  outDir: "src/generated",
  dialect: "postgres",                 // "postgres" | "sqlite" | "d1"
  apiPrefix: "/api",
  columnNamingStrategy: "snake_case",  // "snake_case" | "literal" | "kebab-case"
  generators: [entityFile(), queriesFile(), routesFile(), barrel()],
});
```

Drop your metadata under `metaobjects/`:

```jsonc
// metaobjects/meta.blog.json
{ "metadata.root": {
    "package": "acme::blog",
    "children": [
      { "object.entity": {
        "name": "Author",
        "children": [
          { "source.rdb": { "@table": "authors" } },
          { "field.long":   { "name": "id" } },
          { "field.string": { "name": "name", "@required": true, "@maxLength": 200 } },
          { "field.string": { "name": "bio", "@maxLength": 2000 } },
          { "identity.primary": { "@fields": "id", "@generation": "increment" } }
        ]
      }}
    ]
}}
```

## Generate

```bash
meta gen                  # codegen → format → 3-way merge → write
meta gen --dry-run        # preview without writing
meta gen --watch          # re-run on metadata file change

meta migrate              # diff vs DB → emit migration SQL
meta migrate --dialect d1 # Cloudflare D1 dialect

meta verify               # report DB-vs-metadata drift
```

## Use

The generated code runs without any MetaObjects runtime dependency — Drizzle +
Zod + Kysely + Fastify are direct user-app deps.

```ts
// src/server.ts
import Fastify from "fastify";
import { db } from "./db";
import { author } from "./generated/acme/blog/Author";
import { findAuthorById } from "./generated/acme/blog/Author.queries";
import { registerAuthorRoutes } from "./generated/acme/blog/Author.routes";

const app = Fastify();
registerAuthorRoutes(app, { db });   // mounts GET/POST/PUT/DELETE under /api/author

await app.listen({ port: 3000 });
```

The `runtime-ts` package supplies the helpers that the generated routes lean on
(`parseFilterParams`, the `ObjectManager` for full-runtime CRUD).

## Capability snapshot

| Feature | Status |
|---|---|
| Entities + fields | Yes |
| Relationships + FK | Yes |
| Source kinds (table / view / storedProc) | Yes |
| `field.currency` / `field.enum` / `field.object` + `@storage` | Yes |
| Templates + render (FR-004) | Yes |
| Payload-VO codegen | Yes (via projection codegen) |
| Migrations | `meta migrate` (Postgres / SQLite / D1) |
| Drift verify | `meta verify` (DB drift) |
| Prompt-drift verify | Yes (`@metaobjectsdev/render`) |
| Web client packages | Yes (`@metaobjectsdev/react`, `@metaobjectsdev/tanstack`) |

## Test counts

- Server suite (`cd server/typescript && bun test`): 2500+ tests.
- Persistence-conformance (Docker-required): runnable via
  `scripts/integration-test.sh ts`.

## See also

- [`docs/RELEASING.md`](../RELEASING.md) — npm publish procedure (RC → smoke-test → promote)
- [`docs/recipes/`](../recipes/) — deployment recipes (Cloudflare D1, more on the way)
- All [`docs/features/`](../features/) feature docs show the TS output inline
- [`server/typescript/`](../../server/typescript/) source tree

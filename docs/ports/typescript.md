# TypeScript port

The reference implementation. Published to npm at `0.12.4` as 13
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

`meta init` scaffolds both, the `metaobjects/` source directory, the owned
codegen generators at `codegen/generators/{entity,queries,routes,barrel}.ts`
(ADR-0034 scaffold-and-own — copied from the reference templates, yours to edit),
and the `.gitignore` entries for `.metaobjects/.gen-state/`. The scaffolded config
imports those local copies; `meta gen` runs from them, not from the package.

```ts
// metaobjects.config.ts
import { defineConfig } from "@metaobjectsdev/cli";
// Owned generators scaffolded by `meta init` — yours to edit (ADR-0034).
import { entityFile } from "./codegen/generators/entity";
import { queriesFile } from "./codegen/generators/queries";
import { routesFile } from "./codegen/generators/routes";
import { barrel } from "./codegen/generators/barrel";

export default defineConfig({
  outDir: "src/generated",
  dialect: "postgres",                 // "postgres" | "sqlite" | "d1"
  apiPrefix: "/api",
  columnNamingStrategy: "snake_case",  // "snake_case" | "literal" | "kebab-case"
  generators: [entityFile(), queriesFile(), routesFile(), barrel()],
  // providers: [yourProvider],        // optional — add custom metamodel subtypes/attrs
});
```

### Custom providers (optional)

If your app needs a metamodel subtype the core doesn't ship (e.g.
`template.toolcall` for LLM tool-use envelopes), declare a
`MetaDataTypeProvider` and pass it through `defineConfig({ providers })`:

```ts
import type { MetaDataTypeProvider } from "@metaobjectsdev/metadata";
import { yourProvider } from "./codegen/your-provider";

export default defineConfig({
  // … other fields
  providers: [yourProvider],
});
```

The CLI threads the list into every `meta gen` / `meta verify` / `meta
migrate` / `meta prompt-snapshot` invocation. At the SDK level the same
list is accepted directly:

```ts
import { loadMemory } from "@metaobjectsdev/sdk";

const root = await loadMemory("./", { providers: [yourProvider] });
```

Default composition is `[...coreProviders, forgeTypesProvider,
...callerProviders]`. Pass `{ replaceDefaults: true }` to skip the core
bundle entirely (rare — usually only useful in tests). See
[`../features/extending-with-providers.md`](../features/extending-with-providers.md)
for the full contract and
[`../recipes/extending-metaobjects-with-providers.md`](../recipes/extending-metaobjects-with-providers.md)
for an end-to-end walkthrough.

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

### Hono variant (Workers / Bun / edge)

For Cloudflare Workers, Bun servers, and any other Hono-flavored runtime, swap
`routesFile()` for `routesFileHono()`. Same five CRUD verbs, same cross-port
wire contract (envelopes, status codes, filter / sort / `withCount` semantics
— see [`features/api-contract.md`](../features/api-contract.md)); the only
difference is the framework adapter the emitted code talks to.

```ts
// metaobjects.config.ts
import { defineConfig } from "@metaobjectsdev/cli";
// Owned generators scaffolded by `meta init` (ADR-0034 scaffold-and-own).
import { entityFile } from "./codegen/generators/entity";
import { queriesFile } from "./codegen/generators/queries";
import { barrel } from "./codegen/generators/barrel";
// Hono routes have no reference template yet — still imported from the package.
import { routesFileHono } from "@metaobjectsdev/codegen-ts/generators";

export default defineConfig({
  outDir: "src/generated",
  dialect: "sqlite",                    // or "postgres" / "d1"
  apiPrefix: "/api",
  generators: [entityFile(), queriesFile(), routesFileHono(), barrel()],
});
```

Generated `Author.routes.hono.ts`:

```ts
// @generated by @metaobjectsdev/codegen-ts — DO NOT EDIT.
import {
  Author,
  authors,
  AuthorInsertSchema,
  AuthorUpdateSchema,
  AuthorFilterAllowlist,
  AuthorSortAllowlist,
} from "./Author";
import { mountCrudRoutes } from "@metaobjectsdev/runtime-ts/hono";
import type { Hono } from "hono";

export function registerAuthorRoutes(
  app: Hono<any, any, any>,
  deps: { db: unknown },
): void {
  mountCrudRoutes({
    app,
    path: `/api${Author.$path}`,
    db: deps.db,
    table: authors,
    insertSchema: AuthorInsertSchema,
    updateSchema: AuthorUpdateSchema,
    filterAllowlist: AuthorFilterAllowlist,
    sortAllowlist: AuthorSortAllowlist,
    dialect: "sqlite",
  });
}
```

Consumer wiring (Workers example):

```ts
import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { registerAuthorRoutes } from "./generated/Author.routes.hono";

interface Env { DB: D1Database }

const app = new Hono<{ Bindings: Env }>();
registerAuthorRoutes(app, { db: drizzle({} as never) }); // replace with c.env.DB-derived db at request time
export default app;
```

The Hono flavor differs from Fastify in two intentional ways, both reflecting
Hono idioms rather than contract drift:

1. The exported function is `register<Entity>Routes(app, deps)` (deps-injected)
   rather than `<entity>Routes(fastify)` (module-singleton `db` import). Hono
   apps typically pull their persistence client off a per-request `c.env.DB`,
   not a module-level singleton — passing `deps.db` keeps that pattern intact.

2. `apiPrefix` composes into the resource path (`` `${apiPrefix}${$path}` ``)
   rather than wrapping the registration (`fastify.register(..., { prefix })`).
   Hono has no prefix-wrapping primitive at the verb level, and string
   concatenation produces the same URL grammar.

## FR-006 — output parsing

For every `template.output`, `outputParser()` (from `@metaobjectsdev/codegen-ts/generators`)
emits `<TemplateName>.output.ts` with a Zod-backed dual-API: `parseXxx(text)`
throws on bad input; `safeParseXxx(text)` returns a `{ success, data | error }`
discriminated union — matches Zod's idiomatic shape.

```ts
// metaobjects.config.ts (additions)
import { promptRender, outputParser } from "@metaobjectsdev/codegen-ts/generators";

export default defineConfig({
  generators: [
    entityFile(), queriesFile(), routesFile(), barrel(),
    promptRender(),    // renderXxx() per template.prompt
    outputParser(),    // parseXxx() / safeParseXxx() per template.output
  ],
});
```

```ts
// generated/NpcResponse.output.ts
import { z } from "zod";

const NpcResponseSchema = z.object({
  name: z.string(),
  level: z.number().int(),
  role: z.enum(["merchant", "guard", "elder"]),
});

export type NpcResponseData = z.infer<typeof NpcResponseSchema>;
export type NpcResponseValidationError = z.ZodError;  // alias for consumer error-handlers

export function parseNpcResponse(text: string): NpcResponseData {
  return NpcResponseSchema.parse(JSON.parse(text));  // throws ZodError
}

export function safeParseNpcResponse(text: string):
  | { success: true; data: NpcResponseData }
  | { success: false; error: z.ZodError } { ... }
```

Consumer wiring:

```ts
import { parseNpcResponse, safeParseNpcResponse } from "./generated/NpcResponse.output";

const llmResponse = await myLlmProvider.call(promptText);

// Throwing path
const npc = parseNpcResponse(llmResponse);

// Result-style
const r = safeParseNpcResponse(llmResponse);
if (!r.success) log.warn("LLM returned malformed payload", r.error);
else handle(r.data);
```

`meta verify` extends to walk `template.output` nodes (FR-006) the same way it
walks `template.prompt` (FR-004), catching payload-VO ↔ parser drift at build
time. Cross-port design is at
[ADR-0010](../../spec/decisions/ADR-0010-template-output-parser-codegen.md);
the feature reference is at
[`features/templates-and-payloads.md`](../features/templates-and-payloads.md#output-parsing-fr-006).

**Consumer dependency.** The emitted parser imports `zod`. It's likely already in
your `dependencies` (Drizzle / `@metaobjectsdev/runtime-ts` both lean on it);
if not, `npm i zod`.

## Capability snapshot

| Feature | Status |
|---|---|
| Entities + fields | Yes |
| Relationships + FK | Yes |
| Source kinds (table / view / storedProc) | Yes |
| `field.currency` / `field.enum` / `field.object` + `@storage` | Yes |
| Templates + render (FR-004) | Yes |
| Output parser codegen (FR-006) | Yes (`outputParser()` — Zod dual API) |
| Payload-VO codegen | Yes (via projection codegen) |
| Migrations | `meta migrate` (Postgres / SQLite / D1) |
| Drift verify | `meta verify` (DB drift) |
| Prompt-drift verify | Yes (`@metaobjectsdev/render`) |
| Web client packages | Yes (`@metaobjectsdev/react`, `@metaobjectsdev/tanstack`) |

## Client-side

The browser-side TypeScript tier — React forms, TanStack hooks + grids,
the framework-agnostic browser core — is documented separately and is
**universal**: it consumes any backend (TS / Java / Kotlin / C# /
Python) that speaks the cross-port REST contract.

- [`typescript-client.md`](typescript-client.md) — the browser tier
  (`@metaobjectsdev/runtime-web`, `@metaobjectsdev/react`,
  `@metaobjectsdev/tanstack` + the matching codegen packages).
- [`../features/api-contract.md`](../features/api-contract.md) — the
  URL grammar + wire format the browser client speaks.

## Test counts

- Server suite (`cd server/typescript && bun test`): 2500+ tests.
- Persistence-conformance (Docker-required): runnable via
  `scripts/integration-test.sh ts`.

## See also

- [`docs/RELEASING.md`](../RELEASING.md) — npm publish procedure (RC → smoke-test → promote)
- [`docs/recipes/`](../recipes/) — deployment recipes (Cloudflare D1, more on the way)
- All [`docs/features/`](../features/) feature docs show the TS output inline
- [`server/typescript/`](../../server/typescript/) source tree

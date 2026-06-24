# TypeScript codegen specifics

The TS port is the reference implementation, published to npm as `@metaobjectsdev/*`
packages. Codegen runs through the Node `meta` CLI (`@metaobjectsdev/cli`, binary
`meta`).

## Contents
- Install
- `metaobjects.config.ts`
- The generators
- Run
- Multiple output targets
- Field subtype → column mapping

## Install

```bash
npm install --save-dev @metaobjectsdev/cli @metaobjectsdev/codegen-ts
npm install            @metaobjectsdev/metadata @metaobjectsdev/runtime-ts
```

For the React + TanStack codegen packages, also:

```bash
npm install --save-dev @metaobjectsdev/codegen-ts-react @metaobjectsdev/codegen-ts-tanstack
```

## `metaobjects.config.ts`

Codegen is wired in a type-checked TS config at the project root. `defineConfig`
comes from `@metaobjectsdev/cli`; the generators come from their packages.

```ts
import { defineConfig } from "@metaobjectsdev/cli";
import { entityFile, queriesFile, routesFile, barrel } from "@metaobjectsdev/codegen-ts/generators";
import { formFile } from "@metaobjectsdev/codegen-ts-react";
import { tanstackQuery, tanstackGrid } from "@metaobjectsdev/codegen-ts-tanstack";

export default defineConfig({
  outDir: "src/generated",
  dialect: "postgres",                 // "postgres" | "sqlite" | "d1" (D1 is TS-only)
  apiPrefix: "/api",                   // flows to routes AND client fetch URLs
  columnNamingStrategy: "snake_case",  // "snake_case" (default) | "literal" | "kebab-case"
  timestampMode: "string",             // "string" (default, ISO-8601 wire contract) | "date" (Drizzle native Date)
  pluralizeCollections: true,          // default; table VARS auto-pluralize (AgentConfig → agentConfigs)
  collectionNameOverrides: {           // per-entity escape hatch for names the rule gets wrong
    AuditLog: "auditLog", LlmTierConfig: "llmTierConfig",
  },
  generators: [
    entityFile(), queriesFile(), routesFile(), barrel(),
    formFile(), tanstackQuery(), tanstackGrid(),
  ],
});
```

Naming + timestamp knobs are **codegen config**, not metadata attributes — a
collection variable name and a Drizzle column mode are per-port rendering choices
with no meaning to the other language ports, so they carry no cross-port
conformance cost. `collectionNameOverrides` wins over `pluralizeCollections` and is
applied consistently to the table declaration, every FK reference, the `relations()`
block, and the inferred types.

A second file, `.metaobjects/config.json`, holds static project state parseable by
non-TS tooling; `meta init` scaffolds both plus the `metaobjects/` source dir.

## The generators

From `@metaobjectsdev/codegen-ts/generators` (server-side, framework-neutral):

| Generator | Emits per entity |
|---|---|
| `entityFile()` | `<Entity>.ts` — Drizzle table + FK `.references()` + `relations()` + inferred types + Zod insert/update schemas + `<Entity>FilterAllowlist` / `<Entity>SortAllowlist` |
| `queriesFile()` | `<Entity>.queries.ts` — typed CRUD (`findPostById`, `listPosts`, `createPost`, `updatePost`, `deletePostById`) |
| `routesFile()` | `<Entity>.routes.ts` — Fastify CRUD routes on the cross-port REST contract. `routesFileHono()` is the Hono/Workers variant |
| `barrel()` | `index.ts` re-exporting each `<Entity>.ts` (one-shot, not per-entity) |
| `promptRender()` | `render<Name>()` per `template.prompt` |
| `outputParser()` | `<Name>.output.ts` (`parse*` / `safeParse*`) per `template.output` |

## Docs — `meta docs` (one door, two surfaces)

Documentation is NOT a `meta gen` generator. The single door is the `meta docs`
command, which emits two cross-linked **surfaces** under one output dir (default
`./docs`):

- **model surface** (`./docs/<Entity>.md`, `./docs/<Template>.md`) — the neutral
  metadata reference: one page per entity and per template, including the linked
  template-source section.
- **api surface** (`./docs/api/<Entity>.md`, `./docs/api/README.md`,
  `./docs/api/AGENT-API.md`) — the SDK/API reference: the concrete imports,
  function signatures, payload field shapes, and runnable examples for *this*
  project's generated code.

```bash
npx meta docs                     # both surfaces → ./docs (model) + ./docs/api (api)
npx meta docs --model             # model surface only
npx meta docs --api               # api surface only
npx meta docs --out ./site-docs   # write under a different root
```

Other flags: `--layout flat|package`, `--base-url <url>`. Configure defaults in a
`docs:` block in `metaobjects.config.ts` (`outDir`, `layout`, `baseUrl`,
`surfaces`); CLI flags override it. The api surface needs the gen config
(it documents what the codegen produced); with no config it is skipped with a note,
and the model surface still emits from metadata alone.

**Before calling any generated code, read `./docs/api/AGENT-API.md`** — it has the
exact imports, signatures, payload field shapes, and runnable examples for this
project's generated API, so you don't have to guess them.

From `@metaobjectsdev/codegen-ts-react`: `formFile()` → `<Entity>.form.tsx`.
From `@metaobjectsdev/codegen-ts-tanstack`: `tanstackQuery()` → `<Entity>.hooks.ts`
(5 React Query hooks), `tanstackGrid()` → `<Entity>.columns.tsx`,
`tanstackGridHook()` → `<Entity>.grid.tsx`.

`entityFile({ allowlists: false })` drops the `runtime-ts/drizzle-fastify` import
for edge/worker consumers that don't mount server routes. Per-entity opt-out:
`@emitTanstack: false` on the entity skips its hook + column files.

## Run

```bash
npx meta gen                 # load metadata → render → 3-way merge → write
npx meta gen --dry-run       # preview without writing
npx meta gen --watch         # re-run on metadata file change
npx meta gen Author Post     # scope to named entities
```

Generated files carry an `@generated by @metaobjectsdev/codegen-ts` header; the
runner overwrites those and refuses to touch files without it. Hand-customizations
that metadata can't express live in sibling `<Entity>.extra.ts` files.

**Output format:** `meta gen` (and the CLI generally) is TTY-aware — human-readable
text on a terminal, TOON on a pipe or agent. Override with `--format toon|json|text`.
TOON is the structured default for agents; `--format json` is also available.

## Multiple output targets

A `targets: { web: { outDir }, api: { outDir } }` registry plus a per-generator
`target` routes each artifact to its own package (model → database package, routes →
API app, hooks/forms → web app). The top-level `outDir` is the implicit `default`
(entity-module) target; set `entityModuleImportBase` on it when generators route
elsewhere so cross-target imports resolve. With no `targets`, output is
byte-identical to a single-`outDir` project.

## Field subtype → column mapping

Deterministic per dialect: `field.string` + `@maxLength` → `varchar(N)`,
`field.currency` → integer minor units (`bigint`), `field.uuid` → native `uuid`
(Postgres) + `gen_random_uuid()`, `field.enum` → `varchar` + `CHECK`. Override a
field's physical column name with `@column` on the field; the DB schema name lives
on `source.rdb` via `@schema`.

### Value-object jsonb columns

A `field.object` with `@storage: jsonb` (or the default `subdocument`) becomes a
single typed jsonb column — the referenced value-object's TS type is carried onto
the Drizzle column via `.$type<>()`, and its Zod schema is the VO's `InsertSchema`:

```ts
// field.object @objectRef=LlmConfig @storage=jsonb
llmConfigJson: jsonb("llm_config_json").$type<LlmConfig>(),
// field.object @objectRef=Triple @storage=jsonb isArray=true
triples: jsonb("triples").$type<Triple[]>(),   // one jsonb column, NOT a native jsonb[]
```

The VO type, its Zod `InsertSchema`, and this `.$type<>()` all import the VO from
the same module (layout/package/`extStyle`-aware resolution). An opaque jsonb column
(`field.string @dbColumnType: jsonb`) gets no `.$type<>()` — it stays `unknown`,
which is the correct shape for freeform payloads with no fixed VO.

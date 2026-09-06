# TypeScript port

The reference implementation. Published to npm at `0.24.5` as 14
`@metaobjectsdev/*` packages on the `latest` tag. Targets Node-compatible
runtimes; Bun-first dev workflow.

## Install

The README's quick-start — `npm i @metaobjectsdev/cli` — installs just the CLI,
which is enough to run `meta init` and `meta gen`. For a **runnable app**, install
the runtime packages too (the generated code imports `@metaobjectsdev/metadata`
and `@metaobjectsdev/runtime-ts` directly, so declare them — don't rely on them
being hoisted transitively, which breaks under pnpm's strict `node_modules`):

```bash
npm install --save-dev @metaobjectsdev/cli @metaobjectsdev/codegen-ts
npm install            @metaobjectsdev/metadata @metaobjectsdev/runtime-ts
```

For React + TanStack codegen / runtime, add:

```bash
npm install --save-dev @metaobjectsdev/codegen-ts-react @metaobjectsdev/codegen-ts-tanstack
npm install            @metaobjectsdev/react @metaobjectsdev/tanstack @metaobjectsdev/runtime-web
```

`@metaobjectsdev/codegen-ts` declares `drizzle-orm` and `zod` as non-optional
peer dependencies, so npm installs both automatically. The default Fastify
routes generator (`routesFile()`) additionally needs `fastify` at runtime — it
is an **optional** peer of `@metaobjectsdev/runtime-ts` (so it is *not*
auto-installed); add it explicitly:

```bash
npm install fastify
```

Nothing above installs a TypeScript compiler. If you intend to run the `npx tsc`
that every `meta gen` hint prints, add one:

```bash
npm install --save-dev typescript
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
import { entityFile } from "./codegen/generators/entity.js";
import { queriesFile } from "./codegen/generators/queries.js";
import { routesFile } from "./codegen/generators/routes.js";
import { barrel } from "./codegen/generators/barrel.js";

export default defineConfig({
  outDir: "src/generated",
  dialect: "postgres",                 // "postgres" | "sqlite" | "d1"
  extStyle: "js",                      // ".js"-extensioned imports — nodenext- AND bundler-safe ("none" to opt out)
  apiPrefix: "/api",
  columnNamingStrategy: "snake_case",  // "snake_case" | "literal" | "kebab-case"
  generators: [entityFile(), queriesFile(), routesFile(), barrel()],
  // providers: [yourProvider],        // optional — add custom metamodel subtypes/attrs
});
```

### Declarative template-codegen (Mustache)

Owning a generator is one of **two** authoring paths, and TypeScript has both. A
generator can be **programmatic** — the scaffolded `codegen/generators/*.ts` above,
composing this package's `render*` functions — or **declarative**: a Mustache template
plus a scope, with no generator code at all.

Reach for a template when the output *shape* is what you are iterating on, or when you
want the same output across languages; reach for a programmatic generator when the logic
is gnarly or the run is hot. Tradeoff table:
[`codegen-concepts.md` §3](../features/codegen-concepts.md).

There is **no `--template-spec` flag on `meta gen`** — deliberately.
`metaobjects.config.ts` already takes generator *values*, so a template generator is
declared there like any other, which is also what keeps it visible to
`meta verify --codegen` (that gate re-runs the config's generator list, so a generator
declared anywhere else would have its output reported as drift):

```ts
// metaobjects.config.ts
import { defineConfig } from "@metaobjectsdev/cli";
import { templateGenerator } from "@metaobjectsdev/codegen-ts";
import { entityFile } from "./codegen/generators/entity.js";

export default defineConfig({
  outDir: "src/generated",
  generators: [
    entityFile(),
    templateGenerator({
      name: "entity-service",              // kebab-case; surfaces in diagnostics
      template: "service/entity-service",  // → templates/service/entity-service.mustache
      scope: "perEntity",                  // "perEntity" | "perPackage" | "perModel"
      outputPattern: "{package}/{Name}Service.ts",
      // format: "text",                   // optional escaper; defaults to "text"
      // target: "api",                    // optional named output target
    }),
  ],
});
```

Templates resolve through the project's `templates/` directory first, then the framework
defaults — so `template: "service/entity-service"` reads
`<projectRoot>/templates/service/entity-service.mustache`. The `outputPattern`
placeholders are `{name}`, `{Name}` and `{package}` (whose `::` segments become nested
directories); an unknown placeholder throws. Abstract objects are excluded from every
scope.

`scope` and `walk` are mutually exclusive — supply exactly one. Take a `scope` when one
of the three walks fits; supply your own `walk` when it does not.

**Reusing a spec authored for another port.** C# and Python declare the same generators
as a JSON **template-spec** file, because their generator registries are closed and a
flag is the only seam they have. That spec is portable — parse it and spread the result
into `generators`:

```ts
import { readFileSync } from "node:fs";
import { parseTemplateSpec, templateSpecToGenerators } from "@metaobjectsdev/codegen-ts";

const spec = parseTemplateSpec(JSON.parse(readFileSync("./template-spec.json", "utf8")));

export default defineConfig({
  generators: [entityFile(), ...templateSpecToGenerators(spec)],
});
```

`parseTemplateSpec` validates the shape and throws on a bad `scope`, a missing required
string, or an unregistered `format`. Portability runs **one way**: TypeScript additionally
accepts a `target` field (named output targets), which the two CLI ports reject — so a
spec written here may not run there, while a spec written there always runs here. Keep
`target` out of any spec you intend to share.

The walks, the data dict and the pattern grammar are gated byte-identical across all five
ports by the shared `fixtures/template-codegen-conformance/` corpus — whose own TS runner
drives exactly the `parseTemplateSpec` → `templateSpecToGenerators` → `generators` path
shown above. The data dict your template receives is documented in
[`codegen-data-shapes.md`](../features/codegen-data-shapes.md).

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
meta gen Author Post      # scope to named entities

meta verify               # report DB-vs-metadata drift
```

### Schema — first migration on a brand-new database

`meta migrate` diffs your metadata against a **committed schema snapshot**,
not against the live database, so `--dialect` is always required (it is not
auto-detected for the offline diff path even when `--db` is present). On a
brand-new project there's no snapshot yet:

```bash
meta migrate --dialect sqlite --slug init
# meta: migrate: no schema snapshot at .../.schema.sqlite.json. For a new project
#   run `meta migrate --from-db --db <url> --dialect sqlite --slug init --apply`
#   to create your tables, or `meta migrate baseline --from-db --db <url>` to
#   adopt an existing database.
```

The CLI points you at the right command (above). Avoid the `meta migrate
baseline` subcommand **without** `--from-db` on a database that doesn't exist
yet: an offline baseline derives the "existing" snapshot **from your metadata**,
recording your entities' target shape as already applied. No table is ever
created, and every subsequent `meta migrate` reports `no changes` (exit 0) — a
silent failure that only surfaces later, at the API layer, as `SQLITE_ERROR: no
such table`. (`meta migrate baseline` now refuses when it can see the target
`--db` is empty, but the safe path for a new project is simply:)

```bash
npx meta migrate --from-db --db file:dev.sqlite --dialect sqlite --slug init --apply
```

This diffs metadata against what's *actually* in `dev.sqlite` (nothing), emits
`CREATE TABLE "authors" (...)`, and applies it. Reserve `meta migrate baseline
--from-db --db <url>` for the other case — adopting metadata onto a database
that **already** has the schema (e.g. a pre-existing non-MetaObjects setup) —
where you want to record current state without emitting any DDL.

Once a real schema exists, everyday changes go through the incremental flow:

```bash
meta migrate --dialect sqlite --slug add-user-shipping           # diff vs committed snapshot; writes up/down.sql
meta migrate --dialect sqlite --slug add-user-shipping --apply   # ...and apply it
meta migrate --dialect d1                                        # Cloudflare D1 dialect
```

### Typecheck the generated code

One prerequisite first, because the printed hint doesn't name it and a cold run
hits it:

```bash
npm install --save-dev typescript      # `npx tsc` without it hits npm's guard
                                       # package ("This is not the tsc command
                                       # you are looking for") — nothing MetaObjects
                                       # installs brings a compiler.
```

The default `routesFile()` generator emits `import { db } from "../db.js"` — the
module named by `dbImport` in `metaobjects.config.ts`. `meta init` scaffolds that
module too, at `src/db.ts`, so this typechecks on a fresh project with no extra
step. It is a *throwing stub*, not a real connection: it satisfies the import and
picks no driver, but calling anything on `db` at runtime throws a clear error
naming what to do. Typecheck first, wire the real connection before you run the
app (see the "Use" section below) — `npx tsc` doesn't need it in order.

With that, `npx tsc` (the hint every `meta gen`/`meta migrate` prints)
works out of the box with a stock `tsc --init` tsconfig: the generated code emits
`.js`-extensioned relative imports (`import { Author } from "./Author.js"`),
which resolve correctly under **both** Node's native ESM resolution
(`"module": "nodenext"`, the `tsc --init` default) **and** bundler-style
resolution (`"moduleResolution": "bundler"`, Vite/esbuild/tsx). The one project
setting to check: `package.json` must have `"type": "module"` — MetaObjects
generates ESM only, no CommonJS. (The `.js` extension names the compiled output;
`tsc`/your bundler resolves it back to the `.ts` source — this is the standard
Node-ESM TypeScript convention.)

If you prefer un-extensioned imports (some legacy bundler setups), set
`extStyle: "none"` in `metaobjects.config.ts` and use `"moduleResolution":
"bundler"`.

### `<Entity>Names` — the physical names, as constants

`meta init` scaffolds a `names` generator, so a new project gets `<Entity>.names.ts`
without configuring anything. The artifact mirrors the metadata that declared it: every
node carries its own `type`, `subType` and `name`, and a physical name sits under the key
that says **what kind of database object it is**.

```ts
export const ProgramNames = {
  type: "object",
  subType: "entity",
  name: "Program",                      // the OBJECT's name, not the table's
  sources: {
    primary: { type: "source", subType: "rdb", kind: "table", table: "programs" },
  },
  fields: {
    createdAt: { name: "createdAt", column: "created_at" },
    id:        { name: "id",        column: "id" },
  },
  identities: {
    pk:            { type: "identity", subType: "primary",   name: "pk" },
    uq_prog_slug:  { type: "identity", subType: "secondary", name: "uq_prog_slug",
                     index: "uq_prog_slug" },
  },
  indexes: {
    ix_prog_owner: { type: "index", subType: "lookup", name: "ix_prog_owner",
                     index: "ix_prog_owner" },
  },
} as const;
```

| key | means |
|---|---|
| `type` / `subType` | the metamodel type of this node — `object.entity`, `object.projection`, … |
| `name` | the **object's** metamodel name |
| `sources.<role>` | one `source.rdb` child, keyed by its `@role` (`primary` \| `replica`) |
| `sources.<role>.kind` | the source's `@kind` — `table`, `view`, `materializedView`, `storedProc`, `tableFunction` |
| `sources.<role>.table` / `.view` / `.proc` / … | the physical name, under the alias for that `kind` |
| `sources.<role>.schema` | the DB schema, emitted only when one is declared |
| `fields.<field>.name` | the **logical** name — the field as your code and the wire call it |
| `fields.<field>.column` | the **physical** column — `@column` if declared, else `name` through `columnNamingStrategy` |
| `identities.<name>` / `indexes.<name>` | one `identity.*` / `index.*` child, keyed by its metamodel name |
| `…​.index` | the database index name — on `identity.secondary` and `index.lookup` only |

**Why the physical name is not just `name`.** One key cannot hold a table, a view and a
stored procedure and still mean something. In a single run it used to:

```
LedgerNames.name          = "TBL_LDG_ENTRY"    kind: "table"
CustomerSummaryNames.name = "V_CUST_ROLLUP"    kind: "view"
RollupOutNames.name       = "SP_CUST_ROLLUP"   kind: "storedProc"
```

A consumer reading `.name` could not know what it had without reading a second key, and in
none of the three did `name` hold the object's own name. Now the key says what the thing is,
and `as const` enforces it: `LedgerNames.sources.replica.table` is a **compile error**,
because that source is a view.

**A write-through entity has two physical names, and both have a home.** It writes to a
table and reads through a replica view; keying sources by role is what gives the view a slot:

```ts
sources: {
  primary: { type: "source", subType: "rdb", kind: "table", table: "TBL_LDG_ENTRY" },
  replica: { type: "source", subType: "rdb", kind: "view",  view:  "V_LDG_ENTRY_RO" },
},
```

**Both `name` and `column` are always present on a field, and `createdAt` / `created_at` is
why.** They are two different names for one field, they differ the moment a case boundary or
a `@column` appears, and a consumer that has only one of them cannot recover the other:
`@column` is free-form, so `callPurpose` may map to `purpose_code`, which is neither the
logical name nor any transformation of it.

**`readOnly` is not carried.** It was a derivation over `@kind`, not something anyone
declared, and nothing in any port read it. Ask `sources.primary.kind` — that is what the
author actually wrote.

Existing projects (scaffolded before this generator existed) add one line:

```ts
import { namesFile } from "./codegen/generators/names";
export default defineConfig({ generators: [/* … */, namesFile()] });
```

The generated entity module reads these constants rather than embedding the same physical
names a second time, so the constant and the table binding cannot drift apart. With the
generator in the run, **no generated TypeScript spells a physical name at all** — table,
view, procedure, column, schema and index name all travel as references.

**Prefer a typed handle where one exists.** If you are writing a Drizzle query, use the
column object (`programs.createdAt`) — it is type-checked against the schema, and swapping
it for `ProgramNames.fields.createdAt.column` trades a compile error for a runtime one.
These constants are for the places that have no typed handle: raw SQL, a migration script,
a log line, an external system's column mapping.

**It follows `extends`, so a name you do not find here is on the parent.** An artifact whose
object extends another spreads the parent's collections rather than restating them:

```ts
export const CopayAuthNames = {
  type: "object",
  subType: "entity",
  name: "CopayAuth",
  sources: { ...AuthNames.sources },     // the SHARED table, named once on the base
  fields: {
    ...AuthNames.fields,
    copayAmount: { name: "copayAmount", column: "copay_cents" },
  },
  identities: { ...AuthNames.identities },
  indexes:    { ...AuthNames.indexes },
} as const;
```

Two forms, and which one you get is structural. An object with its OWN source declares that
source and spreads only the inherited collections. One that INHERITS its source — a TPH
subtype, which shares its base's single table — spreads `sources` too, so the table name is
stated once, on the base. Either way each object keeps its own `name`/`type`/`subType`,
which is what a single-table hierarchy legitimately has two of.

An abstract base a persisted entity extends gets an artifact of its own, carrying the
columns it declares and an **empty `sources`** — it has no table, and must never acquire
one. Reading `CopayAuthNames.sources.primary.table` still works: the spread resolves it,
with the literal types intact.

## Use

The generated code runs without any MetaObjects runtime dependency — Drizzle +
Zod + Fastify are direct user-app deps. With the default (flat)
`outputLayout`, entity output lands directly under `outDir` — `src/generated/Author.ts`,
`Author.queries.ts`, `Author.routes.ts` — with no per-package subdirectory.

The generated `Author.routes.ts` and `Author.queries.ts` files import a
module-level `db` singleton from the path configured by `dbImport` in
`metaobjects.config.ts` (`meta init` scaffolds `dbImport: "../db"`); replace the
scaffolded throwing stub at `src/db.ts` with a real connection — see
[`docs/recipes/wiring-generated-queries.md`](../recipes/wiring-generated-queries.md)
for the per-dialect setup (SQLite/libsql, Cloudflare D1, Postgres, multi-tenant):

```ts
// src/db.ts
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";

export const db = drizzle(createClient({ url: "file:dev.sqlite" }));
```

```ts
// src/server.ts
import Fastify from "fastify";
import { authorRoutes } from "./generated/Author.routes.js";

const app = Fastify();
await app.register(authorRoutes);   // mounts GET/POST/PATCH/PUT/DELETE for Author

await app.listen({ port: 3000 });
```

`authorRoutes` is a Fastify plugin — `async function authorRoutes(fastify:
FastifyInstance)` — registered with `fastify.register(...)`; `db` is the
module-level singleton wired above, so `server.ts` never passes it explicitly.
(`apiPrefix` in `metaobjects.config.ts` wraps the registration in a
`fastify.register(..., { prefix })` block when set — see
[`features/api-contract.md`](../features/api-contract.md).) The per-verb query
helpers (`findAuthorById`, ...) live in the sibling `./generated/Author.queries`
file and take `db` as an explicit first argument — useful directly in request
handlers, tests, or any runtime where a module singleton doesn't fit (see the
recipe above).

### Prove it works

Boot the server:

```bash
bun src/server.ts          # Bun
npx tsx src/server.ts      # stock Node
```

Node's built-in TypeScript support is **not** enough here — `node src/server.ts`
(type stripping, on by default in Node 24; `--experimental-strip-types` before
that) strips the types but deliberately does not rewrite module specifiers, so
the generated `import … from "./generated/Author.routes.js"` fails with
`ERR_MODULE_NOT_FOUND`. Run it through `tsx` as above, or compile with `npx tsc`
first and run the emitted JavaScript.

Now exercise the generated routes. Three calls are enough to show codegen,
persistence and validation are all live:

```bash
# 1. create -> 201 with the persisted row (id assigned by the DB)
curl -isS -X POST localhost:3000/authors \
  -H 'content-type: application/json' \
  -d '{"name":"Ada Lovelace"}' | head -1
# HTTP/1.1 201 Created

# 2. read it back -> 200 and a JSON array containing the row
curl -sS localhost:3000/authors

# 3. violate a declared constraint -> 400, NOT a 500
curl -isS -X POST localhost:3000/authors \
  -H 'content-type: application/json' \
  -d '{"name":""}' | head -1
# HTTP/1.1 400 Bad Request
```

A 400 on step 3 is the point: `@required` in the metadata became a real wire-tier
rejection, with no hand-written validation. If you set `apiPrefix` in
`metaobjects.config.ts`, prefix the paths accordingly (`/api/authors`).

The `runtime-ts` package supplies the helpers the generated routes lean on
(`mountCrudRoutes`, `parseFilterParams`, the `ObjectManager` for full-runtime CRUD).

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
import { entityFile } from "./codegen/generators/entity.js";
import { queriesFile } from "./codegen/generators/queries.js";
import { barrel } from "./codegen/generators/barrel.js";
// Hono routes are NOT scaffolded eagerly by `meta init` (the default emit targets
// Fastify) but have the same reference template + ownership route as entity/queries/
// routes/barrel — take it with `meta eject routes-hono`, which copies it to
// codegen/generators/routes-hono.ts.
import { routesFileHono } from "./codegen/generators/routes-hono.js";

export default defineConfig({
  outDir: "src/generated",
  dialect: "sqlite",                    // or "postgres" / "d1"
  extStyle: "js",
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
} from "./Author.js";
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
import { registerAuthorRoutes } from "./generated/Author.routes.hono.js";

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

## FR-006 — response parsing

For every `template.prompt` declaring `@responseRef`, `outputParser()` (from
`@metaobjectsdev/codegen-ts/generators`) emits `<PromptName>.response.ts` with a
Zod-backed dual-API: `parseXxx(text)` throws on bad input; `safeParseXxx(text)`
returns a `{ success, data | error }` discriminated union — matches Zod's idiomatic
shape.

ADR-0052: the shape parsed INTO is `@responseRef`, never `@payloadRef` (which types the
request the prompt renders outbound), and `template.output` gets no parser at all. The
strict tier is JSON-only — an `@responseFormat: xml` reply gets the tolerant extract and
nothing strict.

```ts
// metaobjects.config.ts (additions)
import { promptRender, outputParser } from "@metaobjectsdev/codegen-ts/generators";

export default defineConfig({
  generators: [
    entityFile(), queriesFile(), routesFile(), barrel(),
    promptRender(),    // renderXxx() per template.prompt
    outputParser(),    // parseXxx() / safeParseXxx() per responding template.prompt
  ],
});
```

```ts
// generated/NpcResponse.response.ts
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
import { parseNpcResponse, safeParseNpcResponse } from "./generated/NpcResponse.output.js";

const llmResponse = await myLlmProvider.call(promptText);

// Throwing path
const npc = parseNpcResponse(llmResponse);

// Result-style
const r = safeParseNpcResponse(llmResponse);
if (!r.success) log.warn("LLM returned malformed payload", r.error);
else handle(r.data);
```

`meta verify` walks both template subtypes, catching payload ↔ template drift at build
time. Cross-port design is at
[ADR-0010](../../spec/decisions/ADR-0010-template-output-parser-codegen.md);
the feature reference is at
[`features/templates-and-payloads.md`](../features/templates-and-payloads.md#response-parsing-fr-006).

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

- Server suite: `cd server/typescript && bun test` (scope it per package — a
  whole-suite run is slow).
- Persistence-conformance (Docker-required): runnable via
  `scripts/integration-test.sh ts`.
- Which conformance corpus gates what: [`docs/CONFORMANCE.md`](../CONFORMANCE.md).

## See also

- [`docs/RELEASING.md`](../RELEASING.md) — npm publish procedure (RC → smoke-test → promote)
- [`docs/recipes/`](../recipes/) — deployment recipes (Cloudflare D1, more on the way)
- All [`docs/features/`](../features/) feature docs show the TS output inline
- [`examples/advanced-modeling/`](../../examples/advanced-modeling/) — a worked,
  runnable model past the CRUD quickstart (projections, value objects, TPH,
  prompt payloads on one spine)
- [`server/typescript/`](../../server/typescript/) source tree

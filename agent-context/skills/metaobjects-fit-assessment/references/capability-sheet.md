# Capability sheet — what each port ships at 1.0.8 (never promise across these lines)

## Contents
- Contract-only generation, per port
- What contract-only does not do
- Full-stack caps per port
- Not shipped, never promise

Paths are relative to the MetaObjects repository on GitHub.

**Contract-only generation (types, DTOs, validators; no ORM, no routes)** — the CONTRACT SPINE
building block. Every generator is a reference helper an adopter selects, ejects and owns
(`docs/features/own-your-codegen.md`); none is run unless wired.

| Port | Select | Emits for a contract | Source |
|---|---|---|---|
| TypeScript | the `entity` reference generator in a target with `runtime: false` | Zod schemas + inferred TS types; no `drizzle-orm`, no `runtime-ts` import, for entities, value objects and projections alike | `server/typescript/packages/codegen-ts/src/metaobjects-config.ts` (`TargetConfig.runtime`), `.../src/templates/entity-file.ts` |
| Java | `SpringDtoGenerator` (a record per concrete entity or projection, whatever its source, with jakarta validation annotations) and `SpringValueObjectGenerator` (a record per value object) | Java 21 records; your JPA/JDBC entity stays hand-written | `server/java/codegen-spring/src/main/java/com/metaobjects/generator/spring/` |
| Kotlin | `KotlinEntityGenerator` (+ `KotlinValidatorGenerator`) | plain Jackson-compatible data classes per entity and value object | `server/java/codegen-kotlin/src/main/kotlin/com/metaobjects/generator/kotlin/` |
| C# | `EntityGenerator`, with the contract declared **sourceless** | a POCO with DataAnnotations and no EF mapping (a sourced entity gets `[Table]`/`[Key]`/`[Column]`) | `server/csharp/MetaObjects.Codegen/Generators/EntityGenerator.cs` |
| Python | the `entity` generator | Pydantic models (no ORM of any kind) | `server/python/src/metaobjects/codegen/generator_registry.py` |

- **A sourceless object is shape only.** Declared without a `source.rdb`, an object generates its
  type and nothing else: no table, no migration, no routes (#248; `docs/features/libraries.md`).
  A TypeScript model of only value objects and sourceless projections needs no `dialect`
  (`server/typescript/packages/codegen-ts/src/db-emitting.ts`).
- **The drift gate per port** — regenerate into a temp tree and diff: `meta verify --codegen`
  (TS); `mvn metaobjects:verify` (Java/Kotlin; `codegen` is the default mode); `dotnet meta
  verify --codegen` (C#; bare `verify` means `--templates` there); `metaobjects verify` (Python;
  `--codegen` is the default). Source: `docs/features/cli.md`.
- **Generated code compiles**: a codegen-compile gate compiles every port's emitted model tier
  with its real compiler in CI (`docs/CONFORMANCE.md`, "Split coverage").
- **Sharing a model** (`docs/features/metadata-dependencies.md`): in one repository, every port
  reads the same metadata directory (`sources`), so a TS service and a Java, C# or Python
  service can generate from one declaration today. **Across repositories**, a published model
  with a hash-locked snapshot and `meta verify --deps` works for **TypeScript publishers and
  TypeScript/Python consumers only**; Java, Kotlin and C# neither publish nor consume one yet
  (Phase 2) and must share by monorepo or a vendored copy (`docs/features/metadata-sources.md`,
  "Vendoring"), which carries no upstream hash check.
- **Libraries** (`docs/features/libraries.md`): `iam` (preview) and `ai` (stable) ship as
  declared designs; the core layer is sourceless and adds no tables. Mention one only when the
  target is hand-building the same design.

**Out of the box, contract-only does not** (say so when it matters, and say the fix):
- ship a generator for a Prisma schema, TypeORM entities, SQLAlchemy/Django models or JPA
  entities — alongside those ORMs the shipped contract is Zod/TS types, records, POCOs or
  Pydantic models *next to* the ORM model;
- ship an OpenAPI, AsyncAPI or JSON Schema generator;
- reach a consumer outside the five ports (Go, Rust, Ruby, PHP, Swift…) directly.

**Each of those is a generator the project writes**, and that is the primary codegen path, not
a workaround: a generator is a function from the loaded model to files, a few dozen lines, and
`verify --codegen` gates its output like any other. `meta generator new <name>` scaffolds one in
TypeScript; `docs/recipes/write-your-own-generator.md` shows every port and ships JSON Schema and
OpenAPI 3.1 example generators to copy. An OpenAPI or JSON Schema generator also reaches the
languages outside the five ports through their own generators. Price it in the wedge (a day or
two for a first generator), and do not report it as impossible.

**Contract-only cannot** bind a shape to a queue, topic or transport as declared vocabulary
(`api.*`, `operation.*`, `binding.*` are not shipped); a generator can still emit per-transport
code from the shapes.
- promise byte-identical JSON from type-only output: field-name casing on the wire follows each
  consumer's serializer settings (the byte-identical REST wire is a property of the *generated
  routes*, gated by `fixtures/api-contract-conformance/`). Check it in the wedge.

**Full-stack caps per port:**
- **Schema pillar** (`meta migrate`, `verify --db`): Node `meta` CLI only; Postgres, SQLite, D1
  only. Any other database: out for that database; data access unaffected.
- **TS**: Drizzle/Zod + Fastify or Hono routes with the filter-operator grammar, TanStack/React UI
  codegen + runtime, migrations. The only port with UI codegen + runtime.
- **Java/Spring**: DTO records, controllers (full filter grammar via the generated allowlist +
  `FilterParser`), filter/sort allowlists, repository *interfaces* (the consumer implements them;
  the existing ORM sits behind unchanged), payload records, output parsers. Entities stay
  hand-written on this lane. `mvn metaobjects:generate` / `:verify` (no live-DB mode).
- **Kotlin/JVM**: entity + Exposed table + Spring controller + payload + relations + filter
  allowlist + validators + output parsers.
- **C#**: EF Core entities + `AppDbContext` + CRUD minimal-API routes + render/payload/verify via
  `dotnet meta`; no metadata-driven runtime tier; no migrate surface.
- **Python**: Pydantic + router + payload/parsers + `ObjectManager` runtime; the consumer wires the
  FastAPI router and repository; `metaobjects gen`/`verify` (no migrate).
- **Prompt pillar** (all five ports): render + payload codegen + `verify` templates + the reply
  parser for a responding `template.prompt` (`@responseRef`) + the output-format fragment and
  tolerant `extract`. `template.output` emits no parser. MCP exposure of declared prompts/tools
  is not shipped.
- **Not shipped, never promise**: the `api.*`/`operation.*`/`binding.*` declared-API surface;
  the cut `byte`/`short`/`class` field stubs; `index.fulltext`/`vector`/`spatial`; native PG enums
  and int-backed enums.

# Capability sheet — what each port ships at 1.1.4 / Maven 8.1.4 (never promise across these lines)

## Contents
- Contract-only generation, per port
- What contract-only does not do
- Full-stack caps per port
- Reporting, requirements and the wire setting (1.1)
- Not shipped, never promise

Paths are relative to the MetaObjects repository on GitHub.

**Contract-only generation (types, DTOs, validators; no ORM, no routes)** — the CONTRACT SPINE
building block. Every generator is a reference helper an adopter selects, ejects and owns
(`docs/features/own-your-codegen.md`); none is run unless wired.

| Port | Select | Emits for a contract | Source |
|---|---|---|---|
| TypeScript | the `entity` reference generator in a target with `runtime: false` | Zod schemas + inferred TS types; no `drizzle-orm`, no `runtime-ts` import, for entities, value objects and projections alike | `server/typescript/packages/codegen-ts/src/metaobjects-config.ts` (`TargetConfig.runtime`), `.../src/templates/entity-file.ts` |
| Java | `SpringDtoGenerator` (a record per concrete entity or projection, whatever its source, with jakarta validation annotations) and `SpringValueObjectGenerator` (a record per value object) | Java 21 records; your JPA/JDBC entity stays hand-written | `server/java/codegen-spring/src/main/java/com/metaobjects/generator/spring/` |
| Kotlin | `KotlinEntityGenerator` | plain Jackson-compatible data classes per entity and value object | `server/java/codegen-kotlin/src/main/kotlin/com/metaobjects/generator/kotlin/` |
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

- **Reporting** (`docs/features/reporting.md`, metamodel 1.1; relative `startOf` windows 1.2): `dimension.*`,
  `measure.*`, `segment.filter` and `object.report` load and validate in all five ports. A report with
  a read-only `source.rdb @kind: view` is lowered to a SQL view by `meta migrate` (Postgres, SQLite,
  D1; MySQL SQL from `buildReportViews`) and every port's generators serve it as one read-only list
  route (rows past a 10,000 cap answer `report_too_large`). The TypeScript `cube-model` reference
  generator exports it to Cube. TanStack gets a list hook only: no grid or form for a report.
- **Requirements** (`docs/features/requirements.md`): `requirement.functional` / `.architectural`
  load in all five ports and the `verify` gate runs in each. The strict form is
  `--require-implementers` (TS, Python, C#), `-Dmeta.verify.requireImplementers=true` (Java/Kotlin),
  or `META_REQUIRE_IMPLEMENTERS=1`. A green run proves links resolve, not that a claim is true.
- **Wire setting**: `"wire": {"decimals", "nullMembers"}` in `.metaobjects/config.json`, read by every
  port's codegen. Default `native`: each language's standard JSON (C#/Java/Kotlin decimals as numbers,
  Python/TypeScript as strings). `decimals: "string"` + `nullMembers: "omit"` gives the identical
  cross-port form (`docs/features/api-contract.md`, "The wire setting"). Physical names default to
  `snake_case` in every port via `naming` (`literal` keeps field names).
- **Eject** works in every port (`meta eject`, `metaobjects eject`, `mvn metaobjects:eject`,
  `dotnet meta eject`); documentation pages are generators in the generator list in every port.

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
  allowlist + a startup validator that checks the Exposed tables against the model (not field validation) + output parsers.
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

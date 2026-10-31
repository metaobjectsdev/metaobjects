# Capability sheet — what each port ships at 1.2.0 / Maven 8.2.0 (never promise across these lines)

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
  (TS); `mvn metaobjects:verify` (Java/Kotlin; unset `meta.verify.mode` runs both the codegen and the template gate); `dotnet meta
  verify --codegen` (C#; bare `verify` runs it when `csharp.outDir` (or `--out`) and `codegen/Generators.cs` are present);
  `metaobjects verify` (Python; `--codegen` is part of the default). Since 1.2 a bare `verify` runs
  codegen drift, prompt templates and the requirement ledger in every port, and skips with a note
  a gate it has no configuration for. Source: `docs/features/cli.md`.
- **Generated code compiles**: a codegen-compile gate compiles every port's emitted model tier
  with its real compiler in CI (`docs/CONFORMANCE.md`, "Split coverage").
- **Sharing a model** (`docs/features/metadata-dependencies.md`): in one repository, every port
  reads the same metadata directory (`sources`), so a TS service and a Java, C# or Python
  service can generate from one declaration today. **Across repositories**, a published model
  with a hash-locked snapshot works for **TypeScript publishers only**; **TypeScript, Python,
  Java, Kotlin and C# consume** it at build time (a committed `.metaobjects/deps/` snapshot loaded
  ahead of the project's own files; `extends`/overlay onto a dependency's node resolves; imported
  nodes are not generated unless `scope.include` names their package). The Node `meta deps sync`
  is the only writer of the lock and snapshot, so a Java, Kotlin or C# consumer needs Node to
  sync. Dependencies come from a `path`, an npm package or a Python package; the Maven and NuGet
  transports are design only. Java, Kotlin, Python and C# cannot publish; the Spring runtime does
  not yet auto-load the snapshot, and the Java/Kotlin `verify` does not yet check dependency
  drift. Plain vendoring (`docs/features/metadata-sources.md`, "Vendoring") still works and
  carries no upstream hash check. Source: `docs/features/metadata-dependencies.md`, "Phase 2".
- **Libraries** (`docs/features/libraries.md`): `iam` (preview) and `ai` (stable) ship as
  declared designs; the core layer is sourceless and adds no tables. Mention one only when the
  target is hand-building the same design.

**Out of the box, contract-only does not** (say so when it matters, and say the fix):
- ship a generator for TypeORM entities, SQLAlchemy/Django models or JPA entities — alongside
  those ORMs the shipped contract is Zod/TS types, records, POCOs or Pydantic models *next to*
  the ORM model. **Prisma is the exception (TypeScript):** under `orm: "prisma"`, `prisma-schema`
  generates `schema.prisma` from the model for Postgres, MySQL or SQLite, `verify --codegen` fails
  on a hand edit, and `verify --db` checks the database Prisma pushed (Postgres, SQLite).
  Views, expression/partial indexes and SQLite CHECKs are refused, not dropped
  (`docs/recipes/prisma.md`);
- ship an AsyncAPI generator;
- reach a consumer outside the five ports (Go, Rust, Ruby, PHP, Swift…) directly.

**Each of those is a generator the project writes**, and that is the primary codegen path, not
a workaround: a generator is a function from the loaded model to files, a few dozen lines, and
`verify --codegen` gates its output like any other. `meta generator new <name>` scaffolds one in
TypeScript; `docs/recipes/write-your-own-generator.md` shows every port. Price it in the wedge (a
day or two for a first generator), and do not report it as impossible.

**OpenAPI and JSON Schema are stock generators, unreleased, targeting 1.2.1.** `openapi` writes one
OpenAPI 3.1 document for the generated REST surface, and `contract-schema` writes JSON Schema 2020-12
for each object's read, create and update shapes, plus a strict structured-output subset. A project
on any port runs them through the Node `meta` CLI. They reach the languages outside the five ports
through those languages' own OpenAPI tooling, and oasdiff over two emitted documents checks a change
against the last release (`docs/features/contract-emitters.md`). Until 1.2.1 ships, an assessment of
a released version counts these as generators the project writes, from the examples in
`docs/recipes/write-your-own-generator.md`.

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
  route (rows past a 10,000 cap answer `report_too_large`); the `report-export` generator adds
  `?format=csv|json|xml` in every port (`docs/features/reporting.md`, "Exporting a report"). The TypeScript `cube-model` reference
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
  only. Any other database: out for that database; data access unaffected. On Postgres, drift is
  decided by applying the model to a scratch (shadow) database and diffing catalogs
  (`--shadow-db`, `SHADOW_DATABASE_URL` or `migrate.shadowDatabaseUrl`; else a database `CREATE`d
  on the server when the role may, else a rolled-back probe); SQLite, D1 and offline plans compare
  by text (`docs/features/migrations-and-drift.md`).
- **Credentials and excluded fields** (`docs/features/api-contract.md`, "Credentials and excluded
  fields"): in every port the generated create/PATCH/PUT ignore a `@formExclude` field or a
  `view.password` credential, and a credential is never returned; your own code still reads and
  writes it. A `@required` field with either mark makes the generated create fail.
- **TS**: Drizzle/Zod + Fastify or Hono routes with the filter-operator grammar, TanStack/React UI
  codegen + runtime, migrations. The only port with UI codegen + runtime.
- **Java/Spring**: DTO records, controllers (full filter grammar via the generated allowlist +
  `FilterParser`), filter/sort allowlists, repository *interfaces* (the consumer implements them;
  the existing ORM sits behind unchanged), payload records, output parsers. Entities stay
  hand-written on this lane. `mvn metaobjects:generate` / `:verify` (no live-DB mode).
- **Kotlin/JVM**: entity + Exposed table + Spring controller + payload + relations + filter
  allowlist + a startup validator that checks the Exposed tables against the model (not field validation) + output parsers.
- **C#**: EF Core entities + `AppDbContext` + CRUD minimal-API routes + render/payload/verify via
  `dotnet meta`; no metadata-driven runtime tier; no migrate surface. Namespaces come from the
  metadata package bindings; with none set, each type takes its own package (`acme::billing` is
  `Acme.Billing`), and `csharp.namespace` forces one flat namespace (`docs/ports/csharp.md`).
- **Python**: Pydantic + router + payload/parsers + `ObjectManager` runtime; the consumer wires the
  FastAPI router and repository; `metaobjects gen`/`verify` (no migrate).
- **Prompt pillar** (all five ports): render + payload codegen + `verify` templates + the reply
  parser for a responding `template.prompt` (`@responseRef`) + the output-format fragment and
  tolerant `extract`. `template.output` emits no parser. A template body may be Jinja (`.jinja`,
  `.j2`, `.jinja2`) in Python and TypeScript only; Java, Kotlin and C# render Mustache and refuse
  a Jinja-only body with `ERR_TEMPLATE_ENGINE_UNSUPPORTED`. MCP exposure of declared prompts/tools
  is not shipped.
- **Not shipped, never promise**: the `api.*`/`operation.*`/`binding.*` declared-API surface;
  the cut `byte`/`short`/`class` field stubs; `index.fulltext`/`vector`/`spatial`; native PG enums
  and int-backed enums.

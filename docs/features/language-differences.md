# What differs by language

One model, five ports. The metamodel, the loader, the drift gates and the cross-port REST
contract behave the same everywhere, and the shared conformance corpora check that they do.
Most of what a port *generates* follows its own language's conventions instead, and in a few
places the ports also differ in behaviour. This page lists those differences, so you can find
them here rather than discover them in production.

This is the one place the list is kept. When a release changes a row, it changes it here, and
the port pages link to this page rather than repeating it. The table describes `main`.

## You need Node for the schema, whatever your language

**Schema migrations and database checks run in the Node `meta` tool, for every port**
([ADR-0015](../../spec/decisions/ADR-0015-single-shared-migrate-engine.md)). A .NET, Java, Kotlin or Python
team generates code with its own build tool (`dotnet meta`, `mvn metaobjects:*`,
`metaobjects`), but `meta migrate`, `meta migrate apply-pending`, `meta verify --db` and
`meta verify --replay` exist only in the Node CLI. So does `meta deps sync`, and so does
`meta agent-docs`, which writes the agent instructions. Install it per project with
`npm i -D @metaobjectsdev/cli` and run it as `npx meta`. Node is needed on the machine that
writes or applies migrations (a developer machine, CI, the deploy step), not in your running
service. `npx meta init --config-only` writes just `.metaobjects/config.json`, so a Maven- or
pip-rooted project can point the Node CLI at its metadata without gaining a TypeScript
project.

## The table

| | TypeScript | C# | Java | Kotlin | Python |
|---|---|---|---|---|---|
| **Generate code** | `npx meta gen` | `dotnet meta gen` | `mvn metaobjects:generate` | `mvn metaobjects:generate` | `metaobjects gen` |
| **Codegen drift check** | `npx meta verify --codegen` | `dotnet meta verify` | `mvn metaobjects:verify` | `mvn metaobjects:verify` | `metaobjects verify` |
| **Schema migrations** | `npx meta migrate` | `npx meta migrate` (Node), or `dotnet ef migrations add` over the generated `AppDbContext` ([C# port](../ports/csharp.md)) | `npx meta migrate` (Node); `--migration-format flyway` writes Flyway-named files | `npx meta migrate` (Node); `--migration-format flyway` as for Java | `npx meta migrate` (Node) |
| **Database drift check** | `npx meta verify --db` | `npx meta verify --db` (Node) | `npx meta verify --db` (Node) | `npx meta verify --db` (Node) | `npx meta verify --db` (Node) |
| **Generated data access** | Drizzle tables and row types (`entityFile()`), CRUD queries (`queriesFile()`) | EF Core entities and `AppDbContext` | Spring DTOs and a repository interface | Exposed tables and a repository base | None: the generated router calls a repository `Protocol` you implement |
| **Runtime metadata access** | `ObjectManager` on Kysely (`@metaobjectsdev/runtime-ts`) | None yet (roadmap) | OMDB (JDBC, Spring transactions) | Through Java's OMDB | `ObjectManager` on DB-API 2; not wired to the generated router |
| **Generated REST routes** | Fastify (`routesFile()`; Hono and Drizzle mounts in `runtime-ts`) | ASP.NET minimal API | Spring `@RestController` | Spring `@RestController` | FastAPI `APIRouter` |
| **List with no `limit`** | Every matching row | Every matching row | First 50 | First 50 | First 50 |
| **Largest `limit` on an entity list** | No cap (an opaque raw-SQL view: 1,000) | No cap | No cap | No cap | No cap |
| **Largest report page** | 10,000 rows, then 400 `report_too_large` | Same | Same | Same | Same |
| **Validation error body** | 400 `{"error": "validation", "issues": [...]}` | 400 `{"error": "validation"}` | 400 `{"error": "validation"}` | 400 `{"error": "validation"}` | 400 `{"error": "validation"}` |
| **Filter and sort errors** | 400 with `field`, plus `op`, `expected` and the allowed fields | 400 with `field` | 400 with `field` | 400 with `field` | 400 with `field` |
| **`?status=active` (a bare field, not `filter[status][eq]`)** | 400 `filter.bare_field`, naming the form that works | Ignored: every row comes back | Ignored | Ignored | Ignored |
| **Filter extras beyond the nine operators** | `?search=`, `filter[or]` / `filter[and]`, leading-`%` refusal, filter-value format check | None | None | None | None |
| **Malformed JSON, a malformed id, a bad page bound, a database constraint, a server error** | Pinned bodies: `invalid_json`, `invalid_id`, `pagination.invalid_value`, `constraint_violation`, 500 `internal` | As the framework answers (a report's bad page bound is pinned in every port) | Same as C# | Same as C# | Same as C# |
| **Field names in code** | The model's names (`createdAt`) | PascalCase properties (`CreatedAt`) | The model's names | The model's names | The model's names, not snake_case (`createdAt`) |
| **Field names on the wire** | The model's names, in every port | | | | |
| **Decimals and null members on the wire** | Each port writes its serializer's default; a `wire` setting makes them identical. The per-port table is under [The wire setting](api-contract.md#the-wire-setting) | | | | |
| **Hand edits to a generated file** | Merged (three-way) on the machine that generated it; refused by name elsewhere | Refused by name | Refused by name, or overwritten with `<handEdits>overwrite</handEdits>` | Same as Java | Refused by name |
| **Own a generator** | `npx meta eject` | `dotnet meta eject` | `mvn metaobjects:eject` | `mvn metaobjects:eject` | `metaobjects eject` |
| **Requirement authoring lint** | Yes (advisory) | No | No | No | No |

The REST rows are the detail behind the [cross-port REST contract](api-contract.md): what that
contract pins is identical in every port, and these rows are what it leaves open. When an
agent or a client talks to a generated API, the safe subset is the one every port shares:
`filter[<field>][<op>]=<value>` with the nine operators, an explicit `limit`, and a 400 that
carries `error` (and `field` for a filter or sort error).

## Why these differ

Two rules produce most of the table. First, **each port writes its own language's idiom**:
EF Core in C#, Spring in Java, Exposed in Kotlin, Pydantic and FastAPI in Python. Identical
output is something a project opts into (the `wire` setting), not a default the ports are
bent to fit ([ADR-0019 Amendment 2](../../spec/decisions/ADR-0019-runtime-return-type-contract.md)).
Second, **generated application code is a reference helper**, not a guarantee
([ADR-0034 Amendment 3](../../spec/decisions/ADR-0034-codegen-scaffold-and-own.md)): a route,
a repository or a DTO is a starting point you can eject and change, so a difference in what
the reference writes is a difference you can remove in your own copy.

The rest (the list default, the validation detail, Python's field names and data access) are
known gaps rather than design, and the roadmap closes several of them. When one closes, its row
here changes in the same pull request.

## See also

- [Cross-port REST API contract](api-contract.md): the shared contract and its gates.
- [CLI architecture](cli.md): which commands each port's own CLI carries.
- [Migrations and drift](migrations-and-drift.md): the schema workflow every port uses.
- The port pages: [TypeScript](../ports/typescript.md), [C#](../ports/csharp.md),
  [Java](../ports/java.md), [Kotlin](../ports/kotlin.md), [Python](../ports/python.md).

# MetaObjects — C#

The C# port of the cross-language MetaObjects metadata standard. Targets .NET 8 (C# 12).

## What it covers

- **Loader** (`MetaObjects`) — multi-file JSON / YAML loader with overlay merge and cross-file `extends:` resolution.
- **Canonical serializer** — byte-identical output to the TypeScript reference (the cross-language wire format).
- **YAML authoring front-end** — sigil-free attrs + `[]`-array suffix + fused-key default subtype + the D2 type-coercion guard (ADR-0006), via [YamlDotNet](https://github.com/aaubry/YamlDotNet). The cross-language interchange remains canonical JSON; YAML lowers to it.
- **Codegen** (`MetaObjects.Codegen`) — idiomatic .NET emit: EF Core entities, an `AppDbContext`, ASP.NET minimal-API CRUD routes, filter allowlists, payload records, output parsers/prompts, TPH per-subtype surfaces and M:N navigation.
- **Render + verify** (`MetaObjects.Render`) — Mustache render, payload value-object codegen and the `verify` drift gates, byte-identical with the other four ports against the shared render corpus.
- **CLI** (`MetaObjects.Cli`) — packaged as a .NET tool invoked **`dotnet meta`**, with `gen` and `verify` verbs.
- **Conformance runners** — auto-discover the shared corpora under `fixtures/` (metamodel, yaml, render, verify, validation, api-contract, persistence, registry manifest). The corpora are the **oracles** — when a fixture goes red the port is wrong, never the fixture.

## What it does NOT cover (out of scope)

- **Schema migrations.** Per [ADR-0015](../../spec/decisions/ADR-0015-single-shared-migrate-engine.md) the migration engine is owned by the TypeScript toolchain; the C# migrate engine and its `migrate` / `--from-db` CLI surface were removed. Use the Node `meta` CLI (`meta migrate`, `meta verify --db`) for schema. This is *only* about schema — C# codegen and runtime data access are first-class here.
- **Byte-equal generated code.** Each language emits its own idiomatic output; byte equivalence is a goal at the render/canonical-serializer layer, not the codegen layer. Cross-port codegen parity is enforced behaviourally, through the api-contract corpus.
- The `dbProvider` provider — the metamodel conformance corpus uses only `metaobjects-core-types`.

## AI assistant context

To scaffold MetaObjects context files (`.metaobjects/AGENTS.md`, `.metaobjects/CLAUDE.md`, and
`.claude/skills/metaobjects-*/`) into your project so your AI assistant understands how to
author metadata and run codegen, use the Node `meta` CLI:

```bash
npx meta agent-docs --server csharp
```

(Running `dotnet meta agent-docs` prints this redirect and exits.)

## Running

```bash
cd server/csharp
dotnet test
```

The test suite includes per-fixture `Lint` and `Conformance` theories over the shared corpus at `../fixtures/conformance/` plus unit tests for the parser, serializer, registry, tree, and loader.

## Layout

- `MetaObjects/` — class library (`MetaObjects.csproj`)
  - `Constants.cs`, `Errors.cs`, `Registry.cs`, `Provider.cs`, `DataType.cs`, `DataConverter.cs`
  - `Meta/MetaData.cs` and the concrete node classes (`MetaRoot`, `MetaObject`, `MetaField`, etc.)
  - `CoreAttrSchemas.cs`, `CoreTypes.cs` — the `metaobjects-core-types` provider
  - `Parser.cs`, `SuperResolve.cs`, `SerializerJson.cs`
  - `YamlDesugar.cs`, `ParserYaml.cs` — YAML authoring front-end (ADR-0006)
  - `Loader/` — `IMetaDataSource`, `InMemoryStringSource`, `FileSource`, `DirectorySource`, `UriSource`, `MetaDataLoader` (with `FromDirectory`/`FromUris`/`FromString` static factories), `ValidationPasses`
- `MetaObjects.Conformance.Tests/` — xUnit test project + conformance harness
  - `ConformanceAdapter.cs`, `FixtureDiscovery.cs`, `OperationScript.cs`, `FixtureLint.cs`, `Navigator.cs`, `CapabilityBinding.cs`, `Result.cs`, `ExpectedFailures.cs`, `conformance-expected-failures.json`, `ConformanceTests.cs`
  - `YamlConformanceTests.cs`, `YamlDesugarTests.cs`, `yaml-conformance-expected-failures.json` — YAML conformance + unit tests
  - Per-pipeline-stage unit tests (`ErrorsTests`, `RegistryTests`, `TreeTests`, `ParserTests`, `SerializerTests`, `LoaderTests`, `SuperResolveTests`, `ValidationTests`, …)
- `MetaObjects.Codegen/` — the .NET emit pipeline (`Generators/` holds entity, db-context, routes, payload, filter-allowlist, output-parser/prompt, extractor, template) + `CodegenRunner`, `GeneratorRegistry`, `CodegenDrift`
- `MetaObjects.Render/` — Mustache render, payload value objects, `verify`
- `MetaObjects.Cli/` — the `dotnet meta` tool (`gen`, `verify`)
- `MetaObjects.Codegen.Tests/`, `MetaObjects.Render.Tests/`, `MetaObjects.Cli.Tests/` — per-project unit + golden tests
- `MetaObjects.IntegrationTests/` — the generated ASP.NET stack booted over HTTP against Testcontainers Postgres (api-contract + persistence corpora)

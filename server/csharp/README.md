# MetaObjects — C#

C# implementation of the MetaObjects metadata Loader. Targets .NET 8 (C# 12).

## What it covers

- **Loader** — multi-file JSON / YAML loader with overlay merge and cross-file `extends:` resolution.
- **Canonical serializer** — byte-identical output to the TypeScript reference (the cross-language wire format).
- **YAML authoring front-end** — sigil-free attrs + `[]`-array suffix + fused-key default subtype + the D2 type-coercion guard (ADR-0006), via [YamlDotNet](https://github.com/aaubry/YamlDotNet). The cross-language interchange remains canonical JSON; YAML lowers to it.
- **Conformance runners** — auto-discover `fixtures/conformance/*` AND `fixtures/yaml-conformance/*`, both shared with the other ports (TS/Python/Java). The conformance corpora are the **oracles** — when a fixture goes red the port is wrong, never the fixture.

## What it does NOT cover (out of scope)

- Codegen (each language emits its own idiomatic per-language code; byte equivalence is not a goal at the codegen layer).
- Runtime helpers (ObjectManager, filter parsing, CRUD endpoints) — per-language runtime concerns.
- The `dbProvider` provider — the conformance corpus uses only `metaobjects-core-types`.

## Running

```bash
cd csharp
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
  - `Loader/` — `IMetaDataSource`, `InMemorySource`, `FileSource`, `MetaDataLoader`, `FileMetaDataLoader`, `ValidationPasses`
- `MetaObjects.Conformance.Tests/` — xUnit test project + conformance harness
  - `ConformanceAdapter.cs`, `FixtureDiscovery.cs`, `OperationScript.cs`, `FixtureLint.cs`, `Navigator.cs`, `CapabilityBinding.cs`, `Result.cs`, `ExpectedFailures.cs`, `conformance-expected-failures.json`, `ConformanceTests.cs`
  - `YamlConformanceTests.cs`, `YamlDesugarTests.cs`, `yaml-conformance-expected-failures.json` — YAML conformance + unit tests
  - Per-pipeline-stage unit tests (`ErrorsTests`, `RegistryTests`, `TreeTests`, `ParserTests`, `SerializerTests`, `LoaderTests`, `SuperResolveTests`, `ValidationTests`, …)

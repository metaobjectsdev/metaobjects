# MetaObjects — C#

C# implementation of the MetaObjects metadata Loader. Targets .NET 8 (C# 12).

## What it covers

- **Loader** — multi-file JSON loader with overlay merge and cross-file `extends:` resolution.
- **Canonical serializer** — byte-identical output to the TypeScript reference (the cross-language wire format).
- **Conformance runner** — auto-discovers `fixtures/conformance/*` and runs the shared corpus as `dotnet test`. The conformance corpus is the **oracle** — when a fixture goes red the port is wrong, never the fixture.

## What it does NOT cover (out of scope)

- Codegen (each language emits its own idiomatic per-language code; byte equivalence is not a goal at the codegen layer).
- Runtime helpers (ObjectManager, filter parsing, CRUD endpoints) — per-language runtime concerns.
- The `dbProvider` provider — the conformance corpus uses only `metaobjects-core-types`.
- YAML parsing — the corpus is JSON only. A `MetaDataFormat.Yaml` enum value exists for source-discovery parity; the base loader throws on YAML content. The `ParseSource` seam is `protected virtual` so a future YAML port can drop in.

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
  - `Loader/` — `IMetaDataSource`, `InMemorySource`, `FileSource`, `MetaDataLoader`, `FileMetaDataLoader`, `ValidationPasses`
- `MetaObjects.Conformance.Tests/` — xUnit test project + conformance harness
  - `ConformanceAdapter.cs`, `FixtureDiscovery.cs`, `OperationScript.cs`, `FixtureLint.cs`, `Navigator.cs`, `CapabilityBinding.cs`, `Result.cs`, `ExpectedFailures.cs`, `conformance-expected-failures.json`, `ConformanceTests.cs`
  - Per-pipeline-stage unit tests (`ErrorsTests`, `RegistryTests`, `TreeTests`, `ParserTests`, `SerializerTests`, `LoaderTests`, `SuperResolveTests`, `ValidationTests`, …)

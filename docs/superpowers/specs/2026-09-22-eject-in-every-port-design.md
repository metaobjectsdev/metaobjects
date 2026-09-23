# Eject in every port — design

_2026-09-22. Implements Phase 3 of the core/helper reframe
([ADR-0034 Amendment 3](../../../spec/decisions/ADR-0034-codegen-scaffold-and-own.md)), which
supersedes ADR-0035 §3 A4. Until a port ships this, its generators are labelled preview._

## Goal

In every port, an adopter can copy a reference generator into their repo, edit its emit logic,
and have that port's `gen` and `verify --codegen` run the copy instead of the packaged one. The
TypeScript `meta eject` is the model: copy verbatim, never overwrite without `--force`, never edit
the adopter's config, print exactly what to wire, and let `--list` say whether an owned copy has
drifted from the reference.

## What every port shares

- **One command per port**, with the port's own CLI verb: `metaobjects eject`, `dotnet meta eject`,
  `mvn metaobjects:eject -Dnames=…`.
- **Copies are verbatim** except where the language forces a change (a JVM package rename, below).
- **No config edits.** Eject prints the one line or element to add, and the entry to remove.
- **`--list` marks owned copies** `identical`, or `DIFFERS: N behind, M of your own`, comparing
  sorted, whitespace-normalised lines against the packaged reference, as `owned-copy.ts` does.
- **A copy imports only public API.** Where a reference generator uses an internal helper, the
  helper is made public in the same change. The alternative, copying helpers alongside, would give
  the adopter code they did not ask to own. Making them public widens the engine's API surface,
  and that surface is covered by the compatibility policy from then on.

## Python — smallest

- **Copy:** `metaobjects eject <name>...` writes the generator module to
  `codegen/generators/<name_with_underscores>.py`, and creates the two `__init__.py` files if they
  are missing. The registry entry gains the source module and the exported factory symbol.
- **Wiring:** a `generators` entry, and a `--generators` token, may be `module:symbol`. This is the
  same syntax `providers` already accepts, resolved with the config directory on `sys.path` (reuse
  `_resolve_providers`). `generators` stays `list[str]`.
- **Public API:** the codegen package exports nothing today, so a copy imports deep paths such as
  `metaobjects.codegen.generator` or `metaobjects.codegen.format`. Those module paths become the
  documented public API for owned generators; no symbol moves.
- **Registry names in output:** an owned generator keeps its stable `name`, so `.hashes.json`
  ownership and `verify --codegen` are unchanged.

## C# — the adopter owns a small console project

The tool ships compiled, so there is no source on disk to copy, and nothing loads adopter code.

- **Reference source ships as embedded resources** in `MetaObjects.Codegen`, the way the spec
  JSON already is, with a byte-identity test against the source files.
- **Copy:** `dotnet meta eject <name>...` writes `codegen/generators/<Name>Generator.cs`, and on
  first use writes `codegen/Codegen.csproj` (a console project referencing the `MetaObjects.Codegen`
  package at the tool's version) plus `codegen/Program.cs`, which lists the generators with `new`.
  Everything binds at compile time (ADR-0001 spirit, AOT-safe).
- **Runner:** the run logic in `GenCommand.Run` — load, resolve, `CodegenRunner.Run`, hash manifest,
  merge — moves into a public `MetaObjects.Codegen` API that `Program.cs` calls.
- **Hand-off:** when `codegen/Codegen.csproj` exists, `dotnet meta gen` and `dotnet meta verify
  --codegen` run `dotnet run --project codegen -- <same args>` instead of the built-in list.
- **Public API:** `Fr010FieldMapping`, `FindInbound`, `ExtractDelegateEmitter`,
  `OutputFormatSpecEmitter`, `ValueObjectNames.Names`, `FilterAllowlistGenerator.OpsForField`,
  `RoutesGenerator.Filter` and `EntityGenerator.M2mNavProperty` become public.

## JVM (Java and Kotlin) — a codegen module

The Maven plugin already loads adopter classes from the project classpath, parent-first from the
plugin's own loader, and at `generate-sources` nothing in the same module is compiled yet.

- **Copy:** `mvn metaobjects:eject -Dnames=<a,b>` writes the source into a `codegen/` Maven module
  under a new package (default `<groupId>.codegen`), because a copy that keeps the reference's
  class name would silently lose to the plugin's copy. The package rename is the only edit.
- **Module:** on first use eject writes `codegen/pom.xml` depending on `codegen-spring` or
  `codegen-kotlin`, and prints the `<module>` entry for the parent and the `<generator><classname>`
  change for the app module, whose plugin gains a dependency on the codegen module.
- **Source:** the reference source comes from the published `-sources` jars, resolved by the plugin.
- **Registries:** the Java and Kotlin stable-name registries gain the source path per entry, and
  eject reads them.
- **Public API:** Java `SpringRecordBuilder` and `OutputFormatSpecEmitter`; Kotlin
  `KotlinEnumEmitter`, `Fr019SharedEnum`, `KotlinExtractSchemaEmitter` and
  `KotlinOutputFormatSpecEmitter` become public.

## Order and size

Python first (about 2 days), then C# (about 4 days), then the JVM (about 5 days). Each port drops its
preview label, in the catalog, the README capability matrix and `own-your-codegen.md`, in the same
change that ships its eject.

## Proof per port

A test ejects one generator, edits one line of its emit, runs `gen`, and asserts the edit is in the
output and that `verify --codegen` passes. A second run with the copy unchanged must produce output
byte-identical to the packaged generator's. The adopter estate repeats the same check before the
port's preview label comes off.

# Own your codegen

MetaObjects treats generated code as a **disposable artifact** and the metamodel as
the **durable spine**. You own the generated code in your repo — it runs without any
MetaObjects runtime dependency, and if `@metaobjectsdev/*` (or the Maven/PyPI/NuGet
packages) disappeared, you keep working code.

"Own your codegen" means two related things, and how far each goes is **idiomatic per
port** — this is intentional (ADR-0035 §3, ratified), not a parity gap:

1. **You own the invocation** — codegen runs through your own build, on your terms,
   in every port.
2. **You own the templates** — in TypeScript, `meta init` scaffolds the reference
   generators *into your repo* so you can edit them (ADR-0034 scaffold-and-own). The
   JVM/Python/C# ports own codegen through **build configuration** rather than copied
   template files; template customization there is via the declarative
   template-codegen surface (`--template-spec` / Mustache) and the generator-selection
   SPI.

Either way, hand-edits inside a generated file survive regeneration: the TS toolchain
three-way-merges against a committed merge base, so your edits are preserved.

## Per port

| Port | Invocation | Template ownership model |
|---|---|---|
| **TypeScript** | `meta init` → `meta gen` (Bun/Node CLI) | **Scaffold-and-own** — `meta init` copies `entityFile`/`queriesFile`/`routesFile`/`barrel` into `codegen/generators/*.ts`; `metaobjects.config.ts` imports those local copies. Edit them freely. |
| **C#** | `dotnet meta gen` / `dotnet meta verify` (.NET tool) | Build-config: the generator set (EF Core entities + `AppDbContext` + CRUD routes) is selected via config; customize via template-spec. |
| **Java / Kotlin** | `mvn metaobjects:generate` / `mvn metaobjects:verify` (`metaobjects-maven-plugin`) | Build-config: generators selected in `pom.xml`, by **stable name** (`entity`/`routes`/…) through the `GeneratorRegistryProvider` ServiceLoader SPI. Kotlin generators run through the same goal. |
| **Python** | `metaobjects gen` / `metaobjects verify` (console-script) | Build-config: the generator set (Pydantic + FastAPI + SQLAlchemy) selected via config; customize via template-spec. |

*(Full command/flag matrix and rationale: [`docs/features/cli.md`](cli.md), locked per
ADR-0015. Schema migrations are TypeScript-owned across all ports.)*

## What's shared vs. per-port

- **Shared (the durable contract):** the metamodel vocabulary, the canonical/YAML
  format, the wire/normalization contract, and the *shape* of the generated artifacts
  (verified byte-for-byte by the codegen + api-contract conformance corpora across all
  five ports). A given entity produces the same logical model, routes, and validation
  everywhere.
- **Per-port (idiomatic):** *how* you invoke codegen (npm CLI vs `dotnet` tool vs
  Maven goal vs console-script) and *how far* template ownership goes (TS copies
  editable templates into your repo; the other ports own codegen via build config +
  the declarative template surface). This split follows each ecosystem's norms
  rather than forcing a single mechanism.

## Custom types (custom providers)

Beyond owning the *generators*, you can extend the *metamodel itself* — register your
own type/subtype (a project-specific `view.*`, `field.*`, `validator.*`, …) through a
**consumer provider**. The metadata **loaders already accept consumer providers in
every language**: a runtime/library app that loads the metamodel plugs its provider in
and it merges on top of the core set. The only per-port question is how the **CLI /
build tool** hands that provider to the loader it already uses.

A provider carries **code**, not just declarations — a `factory` (how to construct the
node) plus an optional imperative validator. So the mechanism must load your **native
provider class** in each language: a JSON file could express the declarative surface
(types / attrs / child-rules) but not the factory or validator.

| Port | How the CLI / build tool loads your provider |
|---|---|
| **TypeScript** | `metaobjects.config.ts` → `providers: [myProvider]`. Threaded into `meta gen`, `meta verify`, `meta docs`, **and** the offline `meta migrate` paths (baseline + generate). |
| **Python** | `metaobjects gen \| verify \| docs --provider module:symbol` (repeatable). The symbol resolves to a `Provider` (or a list, or a zero-arg factory returning one) and is composed **on top of** the core providers — parity with TS `config.providers`. E.g. `metaobjects gen ./metaobjects --out ./gen --provider myapp.providers:view_provider`. |
| **Java / Kotlin** | Put your compiled `MetaDataTypeProvider` on the **project classpath** with a `META-INF/services/com.metaobjects.registry.MetaDataTypeProvider` entry. `metaobjects-maven-plugin` builds the loader with the project classloader, so **Java ServiceLoader auto-discovers it** — no plugin config needed. |
| **C#** | The loader accepts providers like every port; a first-class `dotnet meta` consumer-provider hook is tracked for a future release ([#158](https://github.com/metaobjectsdev/metaobjects/issues/158)). Today, extend the metamodel from an app that constructs the loader directly. |

This split follows each ecosystem's norms — interpreted ports (TS / Python) name or
import the provider module; compiled ports (JVM) discover it on the build classpath —
the same "idiomatic per port" principle as generator ownership (ADR-0035 §3).

## Deprecated (removed at 1.0)

Importing the built-in generators from `@metaobjectsdev/codegen-ts/generators`
(`entityFile`, `queriesFile`, `routesFile`, `barrel`) is **deprecated** (ADR-0034) and
**removed at the 1.0/8.0 release**. Use the owned copies `meta init` scaffolds into
`codegen/generators/*` and import those from your `metaobjects.config.ts`.

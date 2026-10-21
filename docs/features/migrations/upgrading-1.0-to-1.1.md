# Upgrading from 1.0 to 1.1 (1.0.x → 1.1.0)

This is the one page for moving a project from any 1.0.x release to 1.1.0 (npm, PyPI and NuGet
`1.1.0`; Maven Central `8.1.0`). It lists the steps in order and every change that needs
something from you, per port, each with its fix. The per-change detail is in `CHANGELOG.md`
under `[1.1.0]`, and the longer guides it links are written for a coding agent to apply.

1.1.0 is a MINOR: `metamodelVersion` moves from `1.0` to `1.1`, the vocabulary is additive (a
model that uses none of the new names keeps its meaning), and the reporting feature is new.
Five changes still need action in an existing project, and three of them fail nothing when you
skip them, so read the whole list before you regenerate.

## Before you start

- **Upgrade every port together.** All five ports read `.metaobjects/config.json`, and a 1.0.x
  reader refuses a key it does not know: once you add `naming` (step 3), a 1.0.x TypeScript,
  C#, Java, Kotlin or Python tool in the same estate fails with "Unrecognized key(s) in object:
  'naming'". From 1.1.0 on, an unknown key there is a warning, not a failure, so the next key a
  release adds is not the same trap.
- **Mixed-version exports.** A 1.1 `meta export` file can hold a root-level reference written
  `::Name`, which 1.0.x refuses (`ERR_RELATIVE_REF_IN_CANONICAL`). Read 1.1 exports with 1.1
  tools.
- **Commit first.** Every step below shows its effect as a diff; a clean tree makes the diff
  the whole story.

## The steps

1. **Bump every MetaObjects package together**: all `@metaobjectsdev/*` at `1.1.0`,
   `metaobjects` `1.1.0` (PyPI), `MetaObjects*` `1.1.0` (NuGet), `com.metaobjects:*` `8.1.0`
   (Maven, including the `metaobjects-maven-plugin` version in each `pom.xml`). Reinstall
   cleanly and read the resolved versions back.
2. **`meta upgrade`**, then `meta upgrade --apply` if it reports anything. Then load the model
   (`meta verify`): a bare cross-package `extends` now fails with `ERR_UNRESOLVED_SUPER`, and the
   message names the spelling to write (see "References and `extends`").
3. **Set the physical naming rule** if your database's columns are named like the fields (C#,
   Java, the JVM runtime and Python; see "Column and table names"). This is the step that
   fails nothing when skipped.
4. **Move documentation into the generator list** if you ran `meta docs`, `dotnet meta docs`,
   `metaobjects docs` or the `metaobjects:docs` goal (see "Documentation is generated").
5. **Java and Kotlin: let `mvn metaobjects:generate` write the hash manifest, then commit
   `.metaobjects/.gen-state/.hashes.json`** in every module (see "JVM hash manifest").
6. **Resync the generators you own.** `meta eject --list` (TypeScript; `metaobjects eject
   --list`, `dotnet meta gen --list`, `mvn metaobjects:eject -Dlist=true` in the other ports)
   reports each owned copy, and every file it owns beside it (in TypeScript the renderers
   under `codegen/templates/`), as identical to the 1.1.0 reference or not. An owned copy keeps the logic it was copied with: it gets no
   report output and none of the 1.1 fixes until you resync it. For a copy you never edited,
   `meta eject <name> --force` (Java: `mvn metaobjects:eject -Dnames=<name> -Dforce=true`)
   takes the new reference; for one you edited, three-way merge it.
7. **Regenerate** (`meta gen`, `dotnet meta gen`, `metaobjects gen`, `mvn metaobjects:generate`),
   then build and run your tests. Read the generated diff against "Diffs to expect".
8. **Run the drift gates**: `meta verify --codegen` (and your port's `verify`). They should be
   clean; a column-name mismatch is reported naming the `naming` setting.
9. **Refresh the agent context**: `meta init --docs-only --refresh-docs` (or `npx meta
   agent-docs`). A file you edited is left alone and the new copy written beside it as
   `<file>.new`; merge it by hand and delete the `.new`.

## Changes that need action

### Column and table names (C#, Java, the JVM runtime, Python)

Column and table names the metadata does not give come from one `naming` setting in
`.metaobjects/config.json`, defaulting to `snake_case` in every port. In 1.0 the default in C#,
Java codegen, the JVM runtime (OMDB, Java and Kotlin) and Python was the field name. A database
whose columns are named exactly like the fields adds:

```json
{ "naming": { "columns": "literal" } }
```

The per-port flags that carried the rule are removed and refused with a message naming the
setting: `--column-naming` (C#, Python), the `columnNaming` generator arg (Java/Kotlin pom),
`SimpleMappingHandlerDB.setColumnNaming(...)` (Java), `ObjectManager(column_naming=)` (Python)
and `columnNamingStrategy` (TypeScript, whose default was already `snake_case`). Kotlin
codegen's Exposed tables were already `snake_case` in 1.0: a Kotlin/Exposed project whose tables
came from 1.0 Kotlin codegen adds nothing.

The runtimes read the same file codegen reads:

- **Python** — `MetaDataLoader.from_directory(...)` and `from_uris(...)` find
  `.metaobjects/config.json` by walking up from the metadata directory (or the first file URI);
  `from_string(..., project_dir=...)` takes the project explicitly. A model loaded any other way
  (a package resource) takes the project's rules with `attach_naming(root, project_dir)` from
  `metaobjects.naming`.
- **Spring** — the runtime reads `classpath:.metaobjects/config.json` when it is on the
  classpath (package the project's file as a resource), or the location
  `metaobjects.physical-naming-config` names (a `classpath:` location or a file path).
- **Java and Kotlin outside Spring** — `MetaDataLoader.fromUris(...)` and `fromDirectory(...)`
  read the `.metaobjects/config.json` above the metadata; set the rules explicitly with
  `root.setPhysicalNaming(SourceResolver.resolvePhysicalNaming(projectDir))` for any other
  source.
- When a runtime finds no project config it says once that it is using the `snake_case`
  default, so a missing file is visible in the log rather than as a query against a column
  that does not exist.

Full table, per port: [physical-naming.md](physical-naming.md).

### Documentation is generated (every port)

Every generator, documentation included, is an entry in the project's generator list; one
command runs the list, and nothing is generated that the list does not declare. The docs
commands are removed and exit 2 naming where their work went: `meta docs` and
`meta verify --docs` (TypeScript), `dotnet meta docs` (C#), `metaobjects docs` (Python), the
`metaobjects:docs` goal (Java/Kotlin). A gen command given a 1.0 docs configuration fails before
it writes anything. Before and after configs per port, and the one-time `--baseline=fresh` run
that records the existing pages: [docs-are-generators.md](docs-are-generators.md).

### JVM hash manifest (Java and Kotlin)

`mvn metaobjects:generate` records what it writes in `.metaobjects/.gen-state/.hashes.json`,
the committed manifest the other ports already use, and decides overwrites from it. An edited
generated file is refused by name (1.0 overwrote it), and a file no generator emits any more is
deleted. The first run adopts your existing generated files and tells you to commit the
manifest. Details, including the two-executions case: [jvm-codegen-hash-manifest.md](jvm-codegen-hash-manifest.md).

### References and `extends` (TypeScript, Python, C#)

A bare `extends` no longer binds an object in another package (ADR-0042, ADR-0059). In 1.0,
TypeScript, Python and C# searched every package; Java did not. Now a bare name binds the
declaring file's own package, then the root, in all five ports. The load error names the fix:

```
ERR_UNRESOLVED_SUPER: … An object named "Base" exists in: acme::common::Base.
Qualify it with its package (FQN): write extends: "acme::common::Base".
```

Make that edit. When two or more packages declare an object of that name the message lists
them all; pick the one the object meant. In 1.0 the TypeScript, Python and C# loaders bound the
first match in load order, so with one candidate the qualified spelling keeps the meaning it
had. `meta upgrade` does not make this edit: choosing the package needs the whole model.

### Decimals on the wire (every port)

A `field.decimal` crosses the generated API as one canonical string in every port (ADR-0019
Amendment 1): `12.50` is sent `"12.5"`, zero `"0"`, never a number and never an exponent. In
1.0 C#, Java, Kotlin and Python sent a number. A client that reads a decimal from those ports
parses a string now; format it for display with the field's `@scale` (display is a view's job).
On input a string or a JSON number is accepted, read exactly, and a value with more fraction
digits than `@scale` or more integer digits than `@precision - @scale` is `400 validation`
rather than rounded. A decimal filter operand is compared exactly; a bad one is
`400 invalid_filter_value`. On SQLite and D1 a decimal keeps 15 significant digits, and
`meta migrate` warns for one declared with `@precision` above 15. An owned routes generator
keeps its 1.0 decimal handling until you resync it (step 6).

## Diffs to expect after regenerating

- **References are written fully qualified (ADR-0059).** `meta export` and canonical
  serialization write every reference as `pkg::Name` (a root-level target referenced from a
  package as `::Name`), and a model spanning packages gets a `package` on each top-level object.
  The neutral template data's `targetRef` carries the same canonical value
  (`rel product -> shop::Product`), so a Mustache template that prints it changes.
  `meta fmt` and documentation pages keep references as you wrote them.
- **Inherited references resolve in the declaring package (ADR-0059 Decisions 3 and 7).** A reference
  an object inherits through `extends` resolves where the base declares it, not where the
  inheriting object lives. A model that relied on the 1.0 behaviour (the same bare name meaning
  different objects in base and subtype packages) now binds the base's.
- **Orphaned generated files are deleted.** The first full `meta gen` after the upgrade deletes
  generated files that no generator in the list emits any more (the hash manifest records what
  was generated). Review the deletions in the diff; a file you want to keep, take out of the
  manifest or rename.
- **A keyless projection regenerates differently.** No `/:id` route, no by-id function, and no
  write verbs in its API docs; `meta verify --codegen` reports those pages stale until you
  regenerate.
- **A multi-hop enum field references the shared enum** in every port, instead of getting an
  enum type of its own; Java and Kotlin have two more enum diffs and two build settings
  (`emitSharedEnums=true`, an `<args>` entry on `SpringValueObjectGenerator` or
  `SpringOutputParserGenerator`; Kotlin's `providedEnumNamespace` / `providedEnumPackages` in the
  plugin's `<globals>`). See the CHANGELOG entry.
- **Decimal wire files.** C# writes `DecimalWire.g.cs` per namespace and Kotlin
  `MetaDecimalWire.kt` per package; Java's DTOs and allowlists gain decimal annotations and
  `DECIMAL_FIELDS`; TypeScript and Python routes call their decimal wire. See "Decimals on the
  wire".
- **C# array properties are `IList<T>`** (scalar and enum arrays on entities, TPH subtypes,
  value objects and report rows; they were `ICollection<T>`, which EF Core 8 cannot read on
  SQLite). Code that assigns a `HashSet<T>` to one assigns a `List<T>`.
- **Owned Java Spring generators** made before 1.1.0 keep their old rules: re-eject with
  `mvn metaobjects:eject -Dnames=<generator> -Dforce=true` and merge your edits back from
  `git diff`.

## CLI behaviour that changed

- `meta init` in a project that is already initialised is a no-op that exits 0 (1.0 exited 1,
  "already exists; use --force"). `--force` still re-scaffolds.

## New in 1.1, nothing to do

Reporting (dimensions, measures, segments, `object.report`, served read-only routes, the Cube
exporter): [reporting.md](../reporting.md). Requirements (the existence and coverage gate in
every port's `verify`): [requirements.md](../requirements.md). A project that declares neither
sees no change from them.

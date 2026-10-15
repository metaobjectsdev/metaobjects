# ADR-0058: One physical-naming setting, read by every port

## Status

**Accepted** (2026-10-14), for 1.1.0. Registers no vocabulary: `metamodelVersion` stays `1.1`
and `fixtures/registry-conformance/expected-registry.json` is untouched. `@column`, `@table`,
`@view`, `@proc`, `@function` and a source's structural `name` keep their meaning and their
precedence ([ADR-0018](ADR-0018-per-kind-physical-name-attrs.md)'s four-step rule).
[ADR-0015](ADR-0015-single-shared-migrate-engine.md) is unchanged: `meta migrate` stays
TypeScript's.

## Context

Every port reads and writes the same database, and `meta migrate` creates it. A field with no
`@column` became a column name by a rule each port configured on its own, in its own place:

| Port | Where the rule lived | Default |
|---|---|---|
| TypeScript | `columnNamingStrategy` in `metaobjects.config.ts`, an `ObjectManager` option, engine options | `snake_case` |
| C# | `dotnet meta gen --column-naming` | `literal` |
| Java | the `columnNaming` generator arg in the pom, `SimpleMappingHandlerDB.setColumnNaming` | `literal` |
| Kotlin | the `columnNaming` generator arg in the pom | `literal` |
| Python | `metaobjects gen --column-naming`, `ObjectManager(column_naming=)` | `literal` |

So the one database had five answers to "what is this column called", and two of them could
disagree inside one port: codegen and the runtime were configured separately, and nothing
checked they agreed. The application-building test of 1.1.0-rc.3 found the consequence in
Python: following the migration guide, a plain `metaobjects gen` rewrote every `*_names.py`
with camelCase column names that do not exist in the snake_case database `meta migrate` built.
`meta verify --codegen` then advised regenerating, which would commit the wrong names.

Table names had the opposite problem: one rule in every port (snake_case of the entity name,
through the frozen legacy pluralizer), and no way to configure it at all.

## Decision

**1. One setting.** The `naming` block of `.metaobjects/config.json`, the port-neutral file
every port already reads for `sources`, `dependencies` and `libraries`:

```json
{ "schema_version": 1, "naming": { "columns": "snake_case", "tables": "snake_case" } }
```

- `columns`: `snake_case` | `literal` | `kebab-case`. Applies to a field with no `@column`.
- `tables`: `snake_case` | `literal`. Applies to a source with no physical-name attribute: its
  structural `name` is cased by the rule; with no name either, the owning object's name is cased
  by the rule and then pluralized by the frozen legacy pluralizer, under every rule.
- Both default to `snake_case`, in every port: what `meta migrate` has always created.
- An unknown key, an unknown value, or a non-object `naming` is refused when the file is read.

**2. Metadata first.** A physical name is the metadata's override when there is one (`@column`;
the kind-matching physical-name attribute, then legacy `@table`, then the source's `name`), and
the configured rule otherwise. Index names stay the metamodel `name` (the name already IS the
override), and constraint names stay derived by `meta migrate`.

**3. The loaded root carries it.** The project-aware load in each port (the one that already
reads `.metaobjects/config.json` for `sources` and `libraries`) sets the rules on the loaded root.
Every resolver reads them from the root: codegen including the names generators, `meta migrate`,
each runtime `ObjectManager`, and `verify`. Codegen and the runtime cannot disagree, because
neither is configured separately. A tree loaded with no project gets the default.

A runtime that loads metadata from somewhere other than the project directory (a classpath, a
packaged resource) gives its loader the project's `.metaobjects/config.json`, and the loader sets
the root from it. It never takes a rule value of its own.

**4. No second way.** Each place a rule used to be configured refuses, with an exact message
naming the setting and the migration guide
(`docs/features/migrations/physical-naming.md`): the `--column-naming` flag (C#, Python), the
pom `columnNaming` generator arg (Java, Kotlin), `columnNamingStrategy` in `metaobjects.config.ts`
and as a generator option (TypeScript), and the runtime setters (`ObjectManager`'s
`columnNamingStrategy` option in TypeScript, `SimpleMappingHandlerDB.setColumnNaming` in Java,
`ObjectManager(column_naming=)` in Python). A refusal never guesses: the old value may have been
right for that adopter's database, and silently dropping it would rename every column.

**5. Conformance.** `fixtures/naming-conformance/physical-names/` holds a model and the expected
table and column name of every object and field under each rule combination, with overrides,
plus the `naming` blocks that must be refused. Every port parses each block with its own config
reader and resolves the names through its own resolver.

## Consequences

- **The default flips for four ports.** C#, Java, Kotlin and Python generated and read
  `literal` column names by default; they now default to `snake_case`, the names `meta migrate`
  creates. An adopter whose database really has literal column names adds one line,
  `"naming": { "columns": "literal" }`, and the migration guide says so for each port. That is
  the intended fix, not a side effect: a default that disagreed with the database the toolchain
  itself creates was the defect.
- **Language-side names are untouched.** Properties, classes, DTO fields and wire keys keep
  their names; only physical database identifiers move.
- `verify --codegen` drift that a different column rule would reproduce exactly says so, naming
  `naming.columns` in `.metaobjects/config.json`, instead of advising a regenerate that would
  commit the wrong names.

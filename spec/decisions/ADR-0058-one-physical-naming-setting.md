# ADR-0058: One physical-naming setting, read by every port

## Status

**Accepted** (2026-10-14), for 1.1.0. Registers no vocabulary: `metamodelVersion` stays `1.1`.
`fixtures/registry-conformance/expected-registry.json` changes in prose only: the `@column` and
`@table` descriptions name the `naming` setting instead of the removed `columnNamingStrategy`.
`@column`, `@table`, `@view`, `@proc`, `@function` and a source's structural `name` keep their
meaning and their precedence ([ADR-0018](ADR-0018-per-kind-physical-name-attrs.md)'s four-step rule).
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

- `columns`: `snake_case` | `literal` | `kebab-case` | `pascal`. Applies to a field with no
  `@column`. (`pascal` was added after the decision: the first letter upper-cased, the rest verbatim.
  It is a column rule only, like `kebab-case`. Amendment 1 opens both settings to names an
  application registers.)
- `tables`: `snake_case` | `literal` (Amendment 1: or an application-registered name). Applies to a source with no physical-name attribute: its
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
- `verify --codegen` drift that a different column rule, a different table rule, or both would
  reproduce exactly says so, naming the `naming` block in `.metaobjects/config.json` that
  reproduces it, instead of advising a regenerate that would commit the wrong names. C# and
  Python, the ports with this probe, print the same message and probe in the same order.

## Amendment 1 (2026-11-07): the strategies are a registry an application extends

**Context.** Decision 1 gave each setting a closed set, and each port resolved it with a
hard-coded switch. A real schema does not always follow one of them. A C# adopter's EF-built
database is `pascal` except for the acronyms it spells in capitals (`NPI`, `SSN`, `ID`); the
closed set left it one `@column` per such field across the whole model, in metadata that is
otherwise port-neutral, for a fact that is a rule. The same pressure applies to a table prefix
(`tbl_`) or any house convention. Widening the closed set for each one would put one adopter's
convention into every port forever.

The `pascal` rule itself was briefly spelled `upperFirst` on an unreleased branch. It is
`pascal`: the name the convention is known by, read with the definition beside it (the first
letter upper-cased, no word split). `upperFirst` was never released and has no alias.

**Decision.**

1. **Every rule is a named strategy in a registry**, one registry per port: a function from a
   bare metadata name to a physical name. The built-ins (`snake_case`, `literal`, `kebab-case`,
   `pascal` for columns; `snake_case`, `literal` for tables) are registered by name, not a
   switch. A built-in name cannot be replaced.
2. **An application registers its own strategy** through its port's extension point, and a
   strategy may delegate to a built-in, in one line. TypeScript: `namingStrategies` in
   `metaobjects.config.ts` (every `meta` command registers it before reading
   `.metaobjects/config.json`) or `registerColumnNamingStrategy` / `registerTableNamingRule`.
   C#: `NamingStrategies.RegisterColumns` / `RegisterTables`. Java and Kotlin:
   `NamingStrategies.registerColumns` / `registerTables`. Python:
   `register_column_naming_strategy` / `register_table_naming_rule`. Each is process-wide, the
   way each port's type registry is. In TypeScript the registry lives on `globalThis` under a
   `Symbol.for` key, so two physical copies of `@metaobjectsdev/metadata` (a global CLI and a
   project dependency) share it.
3. **`.metaobjects/config.json` selects a strategy by name**, built in or registered: `columns`
   and `tables` accept either. A name no registered strategy answers is refused when the file is
   read, with one message in every port, naming the setting, the name, the port, the built-ins
   and what the application registered. It never falls back to the default.
4. **Every resolution goes through the registry**: codegen (the names generators included), the
   runtime, `verify` (whose naming probe now tries the registered strategies after the
   built-ins, in registration order), `meta migrate` and the TypeScript view and docs
   generators. `@column`, `@table` and the other physical-name attributes still win over every
   strategy.
5. **Conformance.** `fixtures/naming-conformance/physical-names/cases.json` declares
   application strategies as data (`strategies`: a delegate built-in, an optional `prefix`, and
   names to upper-case). Each port's runner registers them through its own registry, the way an
   application would, and resolves one case through them; the corpus also pins the refusal of an
   unregistered name and of a column strategy named as a table rule.

**Consequences.**

- A port's stock CLI knows only the built-ins unless the host registers more: TypeScript's
  `meta` reads them from `metaobjects.config.ts`. The Python console script imports the project's
  providers (`providers:` in `metaobjects.config.yaml`) before it reads `.metaobjects/config.json`,
  so a provider module that registers a strategy when it is imported is in time; no host runner is
  needed. (This bullet first said the console script had no hook; it had one all along.)
  `dotnet meta` and the Maven plugin have no hook of their own, so an application with its own
  strategy runs codegen from a host that registers it first (its own codegen runner). `dotnet meta
  verify --codegen` hands its gate to that runner before it checks the name, so verify passes
  where gen does. A hook for those tools is not part of this amendment.
- An estate that reads one database from several ports registers the same strategy in each:
  each port resolves names itself, and the corpus case is the check that they agree.
- C#'s `ColumnNamingStrategy` and `TableNamingRule` change from enums to classes compared by
  name, with the built-ins as static members of the same names (`ColumnNamingStrategy.Pascal`
  replaces the unreleased `UpperFirst`). Code that `switch`ed on them, or used one as a constant
  default parameter or attribute argument, moves to `strategy.Apply(name)`, a nullable parameter,
  or the name string.
- Registers no metamodel vocabulary: `metamodelVersion` does not move.

**Addendum (2026-11-08).**

- **Resolved by name, in every port.** A strategy is looked up in the registry each time it
  applies a name, not captured when the config is read, so a registration made or replaced after
  the read is the one used. TypeScript, Java and Python did this from the start; C# held the
  object it read and now resolves by name too. A C# caller that hands the config to another
  process to resolve (stock `dotnet meta verify` handing `--codegen` to the codegen runner) reads
  it with `validateNaming: false`, which keeps an unregistered name for resolution to refuse.
- **C#: `default(ColumnNamingStrategy)` applies as `Literal`.** `Apply` is an extension method,
  so the `null` a defaulted value holds since the enum became a class applies as the enum's
  default member did, instead of throwing.
- **A test-only reset in every port** (`resetNamingStrategiesForTesting`, `ResetForTesting`,
  `resetForTesting`, `reset_naming_strategies_for_testing`) forgets the application's strategies
  and keeps the built-ins, so a test that registers one can leave the process-wide registry as it
  found it.

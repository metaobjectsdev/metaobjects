# Migration: one physical-naming setting, read by every port

**Changed in:** 1.1.0 (Maven 8.1.0) · **Ports affected:** all five
**Automatic fix:** none. Each section below is written so you, or a coding agent working in
your repository, can make the change by hand. Decision record:
[ADR-0058](https://github.com/metaobjectsdev/metaobjects/blob/main/spec/decisions/ADR-0058-one-physical-naming-setting.md).

## What changed

A database column or table name comes from your metadata when the metadata gives one
(`@column` on a field; `@table`, `@view` or a source's `name` on a source). When it does not,
it comes from a rule. Through 1.0 each port configured that rule in a place of its own, with
a default of its own, and nothing checked that a port's codegen and its runtime agreed. In
1.1.0 the rule is one project setting, in the file every port already reads:

```json
{
  "schema_version": 1,
  "naming": { "columns": "snake_case", "tables": "snake_case" }
}
```

That is `.metaobjects/config.json`. Codegen (the names generators included), `meta migrate`,
every runtime `ObjectManager` and `verify` read it, so they always produce the same names.

| Key | Values | Applies to | Default |
|---|---|---|---|
| `columns` | `snake_case`, `literal`, `kebab-case` | a field with no `@column` | `snake_case` |
| `tables` | `snake_case`, `literal` | a source with no `@table`/`@view`/`@proc`/`@function`: its `name`, else the object's name made plural | `snake_case` |

An unknown key or value fails when the file is read. Index and constraint names are unchanged.

**Upgrade every port of an estate together.** A 1.0.x TypeScript tool refuses the new `naming` key,
but a 1.0.x C#, Java or Python tool ignores an unknown top-level key silently and keeps the old
column names, so a mixed estate disagrees about the schema without any error.

**The default is now `snake_case` in every port.** It is what `meta migrate` has always
created. C#, Java, Kotlin's runtime and Python used `literal` by default. **If your database's
columns are named exactly like your fields** (`firstName`, not `first_name`), add one line to
`.metaobjects/config.json` before you regenerate:

```json
"naming": { "columns": "literal" }
```

Without it, regenerated code and the runtime look for snake_case columns your database does
not have. If your database was created by `meta migrate`, its columns are already snake_case
and you need no line at all.

Every place the rule used to be set now fails with a message that names this setting, for
example:

```
--column-naming was removed in 1.1.0. Column and table naming is one project setting now, read by every port: "naming" in .metaobjects/config.json, for example "naming": { "columns": "literal" }. Move it there and delete --column-naming. See https://github.com/metaobjectsdev/metaobjects/blob/v1.1.0/docs/features/migrations/physical-naming.md
```

It never falls back to the default, because the old value may be the one that matches your
database, and the default would rename every column.

## TypeScript

Default unchanged (`snake_case`).

| 1.0 | 1.1.0 |
|---|---|
| `columnNamingStrategy` in `metaobjects.config.ts` | `"naming": { "columns": "<value>" }` in `.metaobjects/config.json`. `meta gen`, `meta migrate` and `meta verify` refuse a config that still sets it (exit 2) |
| `new ObjectManager({ metadata, driver, columnNamingStrategy })` | `new ObjectManager({ metadata, driver })`. The manager reads the rule from the loaded root; load the model with `loadMemory(projectRoot)` so the root carries it. The option throws |
| `agentDocsFile({ columnNamingStrategy })` | `agentDocsFile()`. The option throws |
| `columnNamingStrategy` on `buildExpectedSchema`, `buildProjectionViews`, `buildReportViews`, `computeDrift`, `planOffline`, and the third argument of `baselineFromMetadata` | removed: each reads the rule from the root it is given |

A model loaded without a project (`new MetaDataLoader().load(...)`) has the default rules;
`loadMemory(projectRoot)` and every `meta` command load through the project and apply the
`naming` block.

## C#

| 1.0 | 1.1.0 |
|---|---|
| `dotnet meta gen --column-naming <strategy>`, `dotnet meta verify --codegen --column-naming <strategy>` | `"naming": { "columns": "<strategy>" }` in `.metaobjects/config.json`. The flag is refused (exit 2) |
| no flag: generated EF mappings used the field names (`literal`) | no setting: snake_case. Add `"naming": { "columns": "literal" }` to keep 1.0's column names |

`dotnet meta verify --codegen` reports drift that another column rule, another table rule, or
both would reproduce exactly as a naming mismatch, naming the setting, instead of advising a
regenerate.

## Java and Kotlin

| 1.0 | 1.1.0 |
|---|---|
| the `columnNaming` generator arg in `pom.xml` | `"naming": { "columns": "<value>" }` in `.metaobjects/config.json`. `mvn metaobjects:generate` fails while any generator still passes it |
| `SimpleMappingHandlerDB.setColumnNaming(...)` | the rule comes from the loaded metadata; the setter throws. A Spring application reads `classpath:.metaobjects/config.json` when the project packages that file as a resource, or the location `metaobjects.physical-naming-config` names (a `classpath:` location or a file path; a named location that does not exist fails startup). `MetaDataLoader.fromUris` and `fromDirectory` find the `.metaobjects/config.json` above the metadata. With no file found, the loader logs one WARN and uses snake_case |
| no arg, Java codegen and the JVM runtime (OMDB, Java and Kotlin alike): the field names (`literal`) | no setting: snake_case. Add `"naming": { "columns": "literal" }` to keep 1.0's column names |
| no arg, Kotlin codegen (the Exposed tables): already snake_case in 1.0 | no setting: snake_case, unchanged. A Kotlin/Exposed project whose tables came from 1.0 Kotlin codegen adds nothing: adding `literal` would rename its columns |

## Python

| 1.0 | 1.1.0 |
|---|---|
| `metaobjects gen --column-naming <strategy>`, `metaobjects verify --codegen --column-naming <strategy>` | `"naming": { "columns": "<strategy>" }` in `.metaobjects/config.json`. The flag is refused (exit 2) |
| `ObjectManager(..., column_naming="<strategy>")` | `ObjectManager(...)`. The manager reads the rule from the loaded root; the argument raises. `MetaDataLoader.from_directory(...)` and `from_uris(...)` find the `.metaobjects/config.json` above the metadata, and warn once and use snake_case when there is none. `from_string(..., project_dir=...)` takes the project explicitly. A model loaded any other way gets the project's rules with `attach_naming(root, project_dir)` from `metaobjects.naming`, which reads that project's `.metaobjects/config.json` and returns the root, so `root = attach_naming(root, project_dir)` |
| no flag: `*_names.py` and the `ObjectManager` used the field names (`literal`) | no setting: snake_case. Add `"naming": { "columns": "literal" }` to keep 1.0's column names |

`metaobjects verify --codegen` reports drift that another column rule, another table rule, or
both would reproduce exactly as a naming mismatch, naming the setting, instead of advising a
regenerate.

The 1.1.0 release candidates read a `columnNaming` key in `metaobjects.config.yaml`. It is
refused the same way; move its value to `naming` in `.metaobjects/config.json`.

## Checking the result

After the change, regenerate and run your port's `verify --codegen`. It should report no
drift. If you see every generated column name change, your database's columns follow a
different rule than the one now set: set `naming.columns` to the rule the database uses
rather than committing the regenerated names.

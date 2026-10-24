# Upgrading from 1.0 to 1.1 (1.0.x → 1.1.0)

This is the one page for moving a project from any 1.0.x release to 1.1.0 (npm, PyPI and NuGet
`1.1.0`; Maven Central `8.1.0`). It lists the steps in order and every change that needs
something from you, per port, each with its fix. The per-change detail is in `CHANGELOG.md`
under `[1.1.0]`, and the longer guides it links are written for a coding agent to apply.

1.1.0 is a MINOR: `metamodelVersion` moves from `1.0` to `1.1`, the vocabulary is additive (a
model that uses none of the new names keeps its meaning), and the reporting feature is new.
Six changes still need action in an existing project, and several of them fail nothing when you
skip them, so read the whole list before you regenerate.

## Before you start

- **Upgrade every port together, because the failure is silent.** All five ports read
  `.metaobjects/config.json`. Once you add `naming` (step 3), a 1.0.x TypeScript tool refuses
  it ("Unrecognized key(s) in object: 'naming'"), but a 1.0.x C#, Java or Python tool ignores
  the unknown key without a word and keeps its old column names. A mixed estate therefore does
  not fail: the old port reads and writes columns named like the fields while the new ones use
  `snake_case`. From 1.1.0 on, an unknown key there is a warning in TypeScript, so the next key
  a release adds is not the same trap.
- **Mixed-version exports.** A 1.1 `meta export` file can hold a root-level reference written
  `::Name`, which 1.0.x refuses (`ERR_RELATIVE_REF_IN_CANONICAL`). Read 1.1 exports with 1.1
  tools.
- **Commit first.** Every step below shows its effect as a diff; a clean tree makes the diff
  the whole story.

## The steps

1. **Refresh the agent context first**: `meta init --docs-only --refresh-docs` (or `npx meta
   agent-docs`). A coding agent doing this upgrade reads the `metaobjects-*` skills in
   `.claude/skills/`, and until this step they are the OLD version's, which describe the old
   behaviour (the 1.0.x skill told C# and Python adopters they had no generator seam, which
   was never true). Do it before anything below, so the rest of the upgrade is done on the
   new skills. C#, Java and Python projects run this one command through Node `meta`
   (`dotnet meta agent-docs` only prints a redirect). A file you edited is left alone and the
   new copy written beside it as `<file>.new`; merge it by hand and delete the `.new`.
2. **Bump every MetaObjects package together**: all `@metaobjectsdev/*` at `1.1.0`,
   `metaobjects` `1.1.0` (PyPI), `MetaObjects*` `1.1.0` (NuGet), `com.metaobjects:*` `8.1.0`
   (Maven, including the `metaobjects-maven-plugin` version in each `pom.xml`). Reinstall
   cleanly and read the resolved versions back.
3. **Set the physical naming rule** if your database's columns are named like the fields (C#,
   Java, the JVM runtime and Python; see "Column and table names"). TypeScript: move
   `columnNamingStrategy` to the same setting. This is the step that fails nothing when
   skipped.
4. **Give every port a generator list, and move documentation into it.** TypeScript: remove
   the `docs` block from `metaobjects.config.ts` and declare each docs generator. C#: run
   `dotnet meta init` once to write `codegen/Generators.cs`; without it `dotnet meta gen` and
   `verify --codegen` exit 2. Python: write the target's `generators` in
   `metaobjects.config.yaml`; without that file `metaobjects gen` exits 2, and the `gen <dir>
   --out` form is gone. Java and Kotlin: the `<generators>` list in the pom, and the
   `metaobjects:docs` goal is removed. Do this whether or not you ever ran a docs command (see
   "Documentation is generated").
5. **`meta upgrade`**, then `meta upgrade --apply` if it reports anything. Then load the model
   (`meta verify`), which refuses a leftover `columnNamingStrategy` or `docs` block until steps
   3 and 4 are done: a bare cross-package `extends` now fails with `ERR_UNRESOLVED_SUPER`, and
   the message names the spelling to write (see "References and `extends`").
6. **Java and Kotlin: let `mvn metaobjects:generate` write the hash manifest, then commit
   `.metaobjects/.gen-state/.hashes.json`** in every module (see "JVM hash manifest").
7. **Resync the generators you own.** `meta eject --list` (TypeScript; `metaobjects gen --list`
   in Python, which has no `eject --list`; `dotnet meta gen --list`,
   `mvn metaobjects:eject -Dlist=true` in the other ports)
   reports each owned copy, and every file it owns beside it (in TypeScript the renderers
   under `codegen/templates/`), as identical to the 1.1.0 reference or not. An owned copy keeps the logic it was copied with: it gets no
   report output and none of the 1.1 fixes until you resync it. For a copy you never edited,
   `meta eject <name> --force` (Java: `mvn metaobjects:eject -Dnames=<name> -Dforce=true`)
   takes the new reference; for one you edited, three-way merge it.
8. **Regenerate** (`meta gen`, `dotnet meta gen`, `metaobjects gen`, `mvn metaobjects:generate`),
   then build and run your tests. Read the generated diff against "Diffs to expect".
9. **Run the drift gates**: `meta verify --codegen` (and your port's `verify`). They should be
   clean; a column-name mismatch is reported naming the `naming` setting.
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

### Decimals and null members on the wire (every port)

**Upgrade to 1.1.2 or later, not 1.1.0 or 1.1.1.** 1.1.0 and 1.1.1 changed what every generated
API writes, with no opt-out: a decimal became a canonical string (`12.50` was sent as `"12.5"`),
and C#, Java and Kotlin stopped writing a value object's null members. From 1.1.2 the output is
the project setting `wire` in `.metaobjects/config.json` (ADR-0019 Amendment 2), and with no
setting each port writes its language's standard JSON:

- **C#, Java and Kotlin:** a decimal is a JSON number and a null member is `null`, as in 1.0.x.
  Nothing changes for your clients.
- **TypeScript:** a decimal is the string the driver returns, which keeps its scale (`"12.50"`):
  the 1.0.x output on Postgres and MySQL.
- **Python:** a decimal is the string Pydantic writes for a `Decimal`, `str(value)` (`"12.50"`).
  1.0.x routers returned plain dicts, and FastAPI's encoder turned a `Decimal` into a float
  (`12.5`, losing digits past a double's precision). A client that read a number now reads a
  string. There is no float option, by decision: a float that loses precision is not the
  Python-normal form, and Pydantic's `str(Decimal)` is. Update a client that parsed the number to
  parse the string (`"decimals": "string"` gives the canonical `"12.5"` instead).

To have every port write one form, which suits clients in several languages or a browser that
must read decimals exactly, declare the form 1.1.0 wrote and regenerate:

```json
{ "schema_version": 1, "wire": { "decimals": "string", "nullMembers": "omit" } }
```

If you already upgraded to 1.1.0 or 1.1.1 and your clients now expect that form, declare that
block before you move to 1.1.2, or your output changes back. [api-contract.md, "The wire
setting"](../api-contract.md#the-wire-setting) has the full per-port table.

Input is the same in every mode. A string or a JSON number is accepted and read exactly
(TypeScript reads a JSON number exactly to 15 significant digits, so send a string for more). A
value with more fraction digits than `@scale`, or more integer digits than
`@precision - @scale`, is `400 validation` rather than rounded. A decimal filter operand is
compared exactly; a bad one is `400 invalid_filter_value`. On SQLite and D1 a decimal keeps 15
significant digits, and `meta migrate` warns for one declared with `@precision` above 15. An
owned routes generator keeps its 1.0 decimal handling until you resync it (step 7).

### Fractional validator bounds (TypeScript, C#, Python)

An integer attribute (`attr.int`, `attr.long`) no longer accepts a fraction. A
`validator.numeric` declares `@min` and `@max` as integers, so a bound such as `@min: 0.5` on a
`decimal` or `double` field is now `ERR_BAD_ATTR_VALUE` at load in TypeScript, C# and Python.
Java already refused it, so the five ports now agree. Write an integer bound (`@min: 0`). A
whole number written `1.0` still loads, as `1`.

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
- **Decimal wire files.** C# writes `DecimalWire.g.cs` per namespace (named
  `DecimalWire.<Namespace>.g.cs` when the model binds more than one namespace) and Kotlin
  `MetaDecimalWire.kt` per package. Java's allowlists gain `DECIMAL_FIELDS`, and TypeScript and
  Python routes call their decimal wire. These check input in every mode. The output
  annotations appear only under `"wire": { "decimals": "string" }`. See "Decimals and null
  members on the wire".
- **C# array properties are `IList<T>`** (scalar and enum arrays on entities, TPH subtypes,
  value objects and report rows; they were `ICollection<T>`, which EF Core 8 cannot read on
  SQLite). Code that assigns a `HashSet<T>` to one assigns a `List<T>`.
- **Owned Java Spring generators** made before 1.1.0 keep their old rules: re-eject with
  `mvn metaobjects:eject -Dnames=<generator> -Dforce=true` and merge your edits back from
  `git diff`.

## Changes to generated text (for subclassed or post-processed generators)

"Diffs to expect" is for someone who regenerates and reads the diff. If you subclass a
packaged generator (the sanctioned extension path, ADR-0002) or rewrite its output afterwards,
a rule keyed to the old text silently stops matching, so this is the list of emit-shape
changes, with the `protected virtual` seam that replaces a text rewrite. Prefer the seam: it
survives the next change to the text. The list is C#, where the request that produced it came
from; the Java/Kotlin and Python generators have their own extension seams and the changes
that reach them are in the CHANGELOG.

| Changed in | Old text | New text | Seam instead of a rewrite |
|---|---|---|---|
| 1.0.5 and after | `HasForeignKey(nameof(Owner.Prop))` | `HasForeignKey(e => e.Prop)`, or `e => new { e.A, e.B }` for a composite (the `M:N` `UsingEntity` sides too) | `DbContextGenerator.EmitOnModelCreatingBody(sb, modelLines, ctx)` receives the lines as a list before they are written. There is no seam for the key expression itself, so match the lambda form |
| 1.1.0 | scalar and enum arrays `ICollection<T>` | `IList<T>`; a non-required value-object array is nullable and has no initializer | `EntityGenerator.ScalarProperty(...)` / `EnumProperty(...)` return the property text; override the one you changed |
| 1.1.0, narrowed in 1.1.2 | no `JsonIgnore` on value-object members | 1.1.0 and 1.1.1: on every nullable member, `[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]` beside `[JsonPropertyName("…")]`. From 1.1.2, only under `"wire": { "nullMembers": "omit" }`; with no setting there is none, as in 1.0 | to drop or keep the attribute, set `wire.nullMembers` and regenerate (do not strip it). `EntityGenerator.EmitPropertyAttributes(sb, owner, field, ctx)` adds other attributes; to change the POCO itself, override `EmitValueObjectPoco(vo, ctx)` |
| 1.1.0, changed in 1.1.2 | `decimal` written and read as a JSON number | 1.1.0 and 1.1.1: a `[DecimalWire…]` string-converter attribute on each decimal member. From 1.1.2, with no setting, `[DecimalWire.Number]` (or `[DecimalWire.Number(p, s)]` with `@precision`), which writes a JSON number and keeps the strict input check; the string converters, or `[DecimalWire.Declared(p, s)]`, only under `"wire": { "decimals": "string" }`. One `DecimalWire.g.cs` per namespace in every mode (`DecimalWire.<Namespace>.g.cs` when there is more than one); do not delete it, because the input check lives there | to change the output form, set `wire.decimals` and regenerate (do not strip the attribute). `EntityGenerator.ScalarProperty(...)` for the member; `EmitFileUsings(sb, entity, ctx)` for the usings the attribute needs |
| 1.0.13 | `DbSet` and navigation names from the 1.0 pluralizer (`CallScriptses`) | an already-plural entity name stays as it is (`CallScripts`) | `DbContextGenerator.EmitDbSetDeclarations(sb, objects, ctx)`; the name itself is `CSharpNaming`'s, so a rewrite keyed to the old plural has to be re-keyed |
| 1.1.0 | a reference written bare in canonical output | `pkg::Name` (a root-level target is `::Name`), so `MetaReferenceIdentity.TargetEntity` is a qualified reference | none needed: resolve a reference through the model (`ValueObjectNames.ResolveFieldRef(field, ctx.Root)` for an `@objectRef`) instead of comparing the string |

Per-entry overrides that need no text rewrite at all: `new EntityGenerator { Include = o => … }`
scopes a packaged generator to some objects (1.1.2; see `references/csharp.md` in the
`metaobjects-codegen` skill), and `PropertyName(field)` renames a property.

## CLI behaviour that changed

- `meta gen` on a model that does not load exits 1 (1.0.13 exited 2).
- The removed docs commands exit 2; the Maven `docs` goal fails the build, so `mvn` exits 1.
- `meta init` in a project that is already initialised is a no-op that exits 0 (1.0 exited 1,
  "already exists; use --force"). `--force` still re-scaffolds.
- TypeScript `ObjectManager` now enforces numeric bounds, array bounds, uri/inet format and an
  assigned primary key; `RequirementTestArgs` and `RequirementView` gained required fields (a
  compile break for code that builds them by hand).
- Java: every regenerated class has a one-time header diff; `entity` no longer writes
  `<Name>Extractor`; a decimal filter operand is a `BigDecimal`, not a `String`, so a
  hand-written repository that casts `(String) p.value()` breaks.
- Kotlin also emits `MetaPortableColumnTypes.kt` and `<Report>Names`; `portableUuid` binds text
  on MySQL and SQLite, which differs from an Exposed-created `BINARY(16)` column.
- Python refuses a project module that shadows the standard library, and answers 400, not 422,
  for a malformed body.
- The `mermaid-er` generator is removed.

## New in 1.1, nothing to do

Reporting (dimensions, measures, segments, `object.report`, served read-only routes, the Cube
exporter): [reporting.md](../reporting.md). Requirements (the existence and coverage gate in
every port's `verify`): [requirements.md](../requirements.md). A project that declares neither
sees no change from them.

# Program A — the four-port fan-out (C#, Java, Kotlin, Python) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the `<Entity>Names` data-name artifact in C#, Java, Kotlin and Python, make each
port's generated code read it wherever that port emits a physical name, and finish the four
TypeScript consumption sites the first plan left behind — so Program A is complete in all five
ports.

**Architecture:** Each port emits one names artifact per declared object, in its own idiom, from
its own resolvers (§A3). Three ports (C#, Java, Kotlin) are forced by their `const` keyword to a
FLAT scalar surface; TypeScript keeps the nested `as const` object it already ships and Python
follows the flat shape for cross-port recognisability. Consumption (§A6) is real in TypeScript,
C# and Kotlin and **structurally impossible in Java and Python**, whose generated code contains no
physical name at all — that asymmetry is designed for, not papered over.

**Tech Stack:** C# (.NET, `MetaObjects.Codegen`), Java 21 (`codegen-spring`, Maven), Kotlin
(`codegen-kotlin`, Exposed), Python 3 (`metaobjects.codegen`, Pydantic), TypeScript (`codegen-ts`,
Drizzle, Bun test).

**Spec:** [`docs/superpowers/specs/2026-08-30-name-constants-and-magic-string-elimination-design.md`](../specs/2026-08-30-name-constants-and-magic-string-elimination-design.md) §A1–A6
(approved for implementation 2026-09-01; scope is all five ports).

**Predecessor:** [`docs/superpowers/plans/2026-08-30-program-a-data-name-constants.md`](2026-08-30-program-a-data-name-constants.md)
— the TypeScript vertical. Its Tasks 1–6 are shipped; the Task 5b that ruling split out of Task 5
mid-execution was never written into that document and is **Task 2 here**.

---

## What recon changed about the spec

Four findings from per-port recon contradict or extend the spec. They are binding on this plan.

1. **§A3 names the wrong Java resolver.** It says "`getTableName()` + `ATTR_COLUMN` on the JVM".
   `MetaSource.getTableName()` (`server/java/metadata/src/main/java/com/metaobjects/source/MetaSource.java:182`)
   returns the RAW `@table` attribute and is `null` whenever `@table` is unset. The resolved
   physical name is **`MetaSource.getPhysicalName()`** (same file, `:278`). The RULE in §A3 is
   right; its Java citation is wrong. Use `getPhysicalName()`.

2. **§A5's C# claim is partially refuted.** C# does not carry physical names "only inside attribute
   arguments". It has four site classes: `[Table]`/`[Column]` attributes (which genuinely require a
   compile-time constant), EF Core fluent calls (`ToView`/`ToJson`/`HasColumnName` — ordinary
   runtime strings), and raw SQL literals. **`const` is load-bearing for the attributes only.** The
   raw-SQL class is excluded by §A6's own words ("Not string interpolation inside generated SQL
   text").

3. **§A6 has no consumption site in Java or Python.** Verified by reading generated output, not by
   absent greps: `codegen-spring` emits no JPA annotations and binds to a consumer-implemented
   repository interface; in Python only `m2m_codegen.py` computes a physical name and it never
   prints one into generated text. So §A6's payoff argument — "a wrong name fails the persistence
   and api-contract corpora, with no new corpus written" — **is unavailable in exactly the two ports
   §A5 calls "the largest real gap"**. Those two ports get their own gates (Tasks 7 and 9) instead
   of inheriting a coverage claim that is not true for them.

4. **Kotlin's `const val` cannot hold the TypeScript shape.** `const` is legal only on `String` and
   primitive properties — never a `Map`, `List`, or nullable reference. The in-repo proof is the
   very artifact §A1 tells us to copy: `KotlinFilterAllowlistGenerator`'s `FIELDS: Set<String>` is
   declared `val`, not `const val`. This is what forces the flat surface decision below.

---

## Design decisions

**D1 — Shape: FLAT scalar constants in C#, Java, Kotlin and Python; TypeScript keeps its nested
`as const`.** Three ports' `const` keyword forbids a map, so flatness is not a preference there,
it is the language. Python follows flat for cross-port recognisability and because mypy narrows a
`Final[str]` to a literal type while a dict lookup is merely `str`. TypeScript already ships nested
and `as const` gives TS the same literal-type property, so it is TS's idiomatic equivalent of the
same thing. §A1 says explicitly: *"Do not force one shape."*

**D2 — Every artifact carries the same five object-level keys and both per-field names.** Object:
`KIND`, `NAME`, `SCHEMA` (omitted entirely when undeclared), `READ_ONLY`. Per field, always both
and always distinguished (§A2): `<FIELD>_FIELD` (logical) and `<FIELD>_COLUMN` (physical). Cased per
port convention. `NAME` matches TypeScript's key deliberately — §A1's whole argument is one concept
recognisable in every port, so a reader who learned `SubscriberNames.name` finds `SubscriberNames.NAME`.

**D3 — One forward map per artifact, no inverse.** Alongside the scalars each port emits a
`field name -> column` map in the shape its own filter allowlist already uses (`Map.of` in Java,
`mapOf` in Kotlin, a `Dictionary` in C#, a `dict` in Python), so a consumer can iterate columns
without hand-writing a list. **No inverse map.** The handoff asked for this to be settled: Python's
`ObjectManager` builds `{column: field}` at `object_manager.py:304`, but that is *runtime* code
building from *loaded metadata*, and it can never import a per-project generated module — a
different consumer with a different lifetime. It is evidence the direction is needed by someone, not
evidence this artifact must ship it. An inverse is one expression away from the forward map, and
shipping both creates a second thing that can disagree with the first.

**D4 — Emit a name constant only where it provably equals the string the binding already emitted.**
This is the guard the TypeScript vertical landed at `templates/drizzle-schema.ts:66-73` after Task 5
found the divergent case reachable. C# has the identical hazard: `MetaObject.DbTable` resolves the
primary **writable** source while `MetaSource.PhysicalName` resolves the **primary** source, and an
`object.base` carrying `view @role:primary` + `table @role:replica` loads clean with the two
disagreeing. Every consumption task carries the equality check. **No task in this plan arbitrates
that divergence** — the open ruling stays open.

**D5 — Java gets a `columnNaming` generator arg; Python gets a `--column-naming` CLI flag.** Neither
is an invention. Kotlin already reads `columnNaming` off the identical `Generator.setArgs` SPI via
the identical Maven `<args>` block, so Java is JVM parity. C# already ships `--column-naming`, so
Python is CLI parity. Java's default is `ColumnNaming.DEFAULT` (`literal`) to match `ObjectManagerDB`,
**not** Kotlin's `snake_case` — a Java artifact defaulting differently from the Java runtime would be
the exact §A3 lie this program exists to remove.

**D6 — Default ON in C# and Python (§A5); opt-in by construction in Java and Kotlin.** Java and
Kotlin generators are selected by FQCN in `pom.xml`, so "default" has no meaning there. Default-ON
carries a committed-output cost: `examples/showcase/generated/{csharp,python}` are real `meta gen`
output and release preflight runs `regen-showcase --check --all-ports`, which refuses to skip a port.
Each default-ON task regenerates its own showcase directory.

**D7 — `names` enters the shared generator manifest in Task 1 and each port appends itself.**
`fixtures/generator-registry-conformance/registry.json` is gated by a **bidirectional set-equality**
test in every port. Seeding the entry with `ports: ["typescript"]` and having each port's task append
its own id keeps every commit green; adding all five up front would redden four ports until the last
one landed.

---

## Global Constraints

Every task's requirements implicitly include this section.

- **§A3, the rule the whole program rests on.** Every name must be produced by the **same resolver,
  in the same generator run, with the same arguments** as the DDL/ORM binding it describes. A name
  computed twice is a name that can disagree with itself.
- **Never re-derive a column name by string transformation.** Call the port's resolver:
  `resolveColumnName` (TS), `CSharpNaming.Column` (C#), `ColumnNaming.resolve` (Java),
  `KotlinGenUtil.resolveColumnName` (Kotlin), `resolve_column_name` (Python). An adopter got a
  hand-rolled `to_snake_case(field.name)` derivation wrong three times, each failing silently.
- **Never call `own*()` accessors** unless emitting a generated subclass; resolving accessors are the
  default. An own-only read silently drops everything inherited through `extends` — including an
  inherited `@column`, which is the §A4 defect class. (ADR-0039.)
- **No new metamodel vocabulary.** Every artifact in this plan reads already-registered attributes.
  No provider registration, no `registry-conformance` fixture, no `metamodelVersion` move. (ADR-0023.)
- **`bun test` NEVER typechecks.** Every TypeScript task must run
  `bun run --filter '*' build && bun run --filter '*' typecheck` from the repo root and report the
  exit code. A type-only error is invisible to the entire test suite.
- **`dotnet test` prints `Passed!` for a project that failed to compile.** Every C# task must grep the
  build output for `error CS` separately from reading the `Passed!` line.
- **Scoped tests only.** `cd server/typescript && bun test <path>`. A bare `bun test` at the repo root
  walks `java/`, `python/`, `csharp/` and takes many minutes.
- **Public repository.** No adopter or private project names, no absolute home paths, in code, docs,
  fixtures **or commit messages**. Use `<repo-root>` and "an adopter project".
- **Work on `main`, forward-only.** Stage explicitly — never `git add -A`. Stage in one Bash call and
  commit in the next: the public-repo guard reads the STAGED blob. Never `--no-verify`. Use
  `git commit -F <file>` — backticks interpolate inside a heredoc.
- **Use absolute paths in Bash.** The working directory silently resets between calls. Commands below
  are written `cd <repo-root>/...`; substitute the checkout's real absolute path when running them.
  `<repo-root>` is a placeholder because this file is committed to a public repository — never paste a
  local home path into a tracked file, a doc, or a commit message.
- **Maven: never pass `-T`.** `server/java/README.md:85` claims `threadSafe` support since #233 and no
  script in the repo passes it; treat that as unproven and keep the reactor serial.

---

### Task 1: Put `names` in the generator registry and the cross-port manifest

The TypeScript vertical shipped `namesFile()` as an exported factory, a reference template and a
`meta init` scaffold entry — but **never registered it**. `codegen-ts/src/generator-registry.ts` does
not import it and `fixtures/generator-registry-conformance/registry.json` has no `names` key. The
conformance gate passes only because both sides omit it.

This is not cosmetic. `generatorRegistry` is also what resolves the **stable-name string form** of
generator selection (`metaobjects-config.ts:354`), documented there as *"the cross-port-consistent
selection mechanism (matches C#/Python `--generators entity,routes`)"*. §A5 rules C# and Python
default ON, and in those ports selection **is** by stable name — so without a manifest entry the
artifact is unreachable in the two ports the spec most wants it in. Every later task in this plan
appends its port id to the entry this task creates.

**Files:**
- Modify: `fixtures/generator-registry-conformance/registry.json` (add a `names` entry)
- Modify: `server/typescript/packages/codegen-ts/src/generator-registry.ts:20-38` (import) and the
  registry object (add the entry)
- Test: `server/typescript/packages/codegen-ts/test/generator-registry.test.ts:16-30`
  (`EXPECTED_NATIVE`)

**Interfaces:**
- Produces: the manifest key `names`, with `"ports": ["typescript"]`. Tasks 3, 5, 7 and 9 each append
  exactly one port id to that array: `"csharp"`, `"kotlin"`, `"java"`, `"python"` respectively.
- Produces: `generatorRegistry["names"]`, so `defineConfig({ generators: ["names"] })` resolves.

- [ ] **Step 1: Write the failing test**

Add `"names"` to `EXPECTED_NATIVE` in `test/generator-registry.test.ts` (after `"barrel"`, matching
the order the registry object will use), and add this test to the same file:

```ts
test("names is selectable by stable name (the C#/Python parity path)", () => {
  const entry = getGenerator("names");
  expect(entry?.name).toBe("names");
  expect(entry?.tier).toBe("native");
  // The factory must construct without throwing — `--list` calls every factory.
  const gen = entry?.factory();
  expect(gen?.name).toBe("names");
  // §A6: the marker the runner aggregates into includeNames. Registering the
  // generator without it would emit the artifact while every template still
  // embedded its own literal.
  expect(gen?.emitsNames).toBe(true);
});
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
cd <repo-root>/server/typescript && bun test packages/codegen-ts/test/generator-registry.test.ts
```
Expected: FAIL — `contains every expected stable name` reports `names` missing, and
`getGenerator("names")` returns `undefined`.

- [ ] **Step 3: Register the generator**

In `server/typescript/packages/codegen-ts/src/generator-registry.ts`, add `namesFile` to the import
list from `./generators/index.js`, then add this entry immediately after the `barrel` entry:

```ts
  names: {
    name: "names",
    description: "Per-entity physical database name constants (table/view, schema, columns).",
    tier: "native",
    factory: () => namesFile(),
  },
```

No `options` key: `namesFile()` takes no options today. (Plan 1's Task 5 review flagged that this
makes it unreachable on a non-default target; that is recorded as a known limit, not fixed here.)

- [ ] **Step 4: Add the manifest entry**

In `fixtures/generator-registry-conformance/registry.json`, add to `generators`, after `"barrel"`:

```json
    "names": {
      "concept": "Per-entity physical database name constants (table/view name, schema, column names).",
      "tier": "native",
      "ports": ["typescript"]
    },
```

`ports` lists **only** `typescript` — the four other ports have no such generator yet, and the
conformance test checks presence in BOTH directions, so naming a port before it registers turns that
port's build red.

- [ ] **Step 5: Run the TypeScript gates**

```bash
cd <repo-root>/server/typescript && bun test packages/codegen-ts/test/generator-registry.test.ts packages/codegen-ts/test/golden/generator-registry-conformance.test.ts
```
Expected: PASS, both files.

- [ ] **Step 6: Prove no other port went red**

The manifest is shared. The four other ports each run a conformance test against their own slice, and
this change must be invisible to all of them because `ports` names only `typescript`.

```bash
cd <repo-root>/server/csharp && dotnet test MetaObjects.Codegen.Tests/MetaObjects.Codegen.Tests.csproj --nologo --verbosity quiet 2>&1 | tee /tmp/cs.log; grep -c "error CS" /tmp/cs.log
cd <repo-root>/server/python && uv run --extra integration pytest tests/conformance/test_generator_registry_conformance.py -q
```
Expected: C# passes with `0` occurrences of `error CS`; Python passes.

- [ ] **Step 7: Typecheck and commit**

```bash
cd <repo-root> && bun run --filter '*' build && bun run --filter '*' typecheck; echo "EXIT=$?"
```
Expected: `EXIT=0`. Then:

```bash
cd <repo-root>
git add fixtures/generator-registry-conformance/registry.json \
        server/typescript/packages/codegen-ts/src/generator-registry.ts \
        server/typescript/packages/codegen-ts/test/generator-registry.test.ts
```
```bash
cd <repo-root> && printf '%s\n' \
  'feat(codegen): the names generator was shipped but never registered' '' \
  'namesFile() has been exported, scaffolded by meta init and ejectable since' \
  '0.24.x, but it was absent from the stable-name registry and from the shared' \
  'cross-port manifest. The conformance gate passed only because both sides' \
  'omitted it.' '' \
  'That made it invisible to meta gen --list, and unreachable through the' \
  'stable-name string form of generator selection -- which is the mechanism the' \
  'C# and Python ports use, and the two the spec puts it on by default.' \
  > /tmp/msg.txt && git commit -F /tmp/msg.txt
```

---

### Task 2: Finish §A6 in TypeScript — the four remaining consumption sites

Plan 1's ruling split Task 5 in two, sending the descriptor and the remaining consumption sites to a
"Task 5b" that was never written into that plan and never executed. `includeNames` has exactly one
consumer today, `templates/drizzle-schema.ts:50`. Four sites still embed a physical name a second
time. The Task 5 reviewer enumerated them and rated every one **risk: NONE**, because each already
calls the same resolver the artifact does.

| site | what it embeds | resolver today |
|---|---|---|
| `templates/entity-constants.ts:224` | `$table` in the descriptor | `resolveTableName` — same as the artifact |
| `templates/projection-decl.ts:146` | per-field `dbCol` | `resolveColumnName` — same as the artifact |
| `templates/view-decl.ts:88,110` | view name + per-column `dbName` | passed-in name; `mapColumnType().dbName` |
| `templates/routes-file.ts:312` | M:N join column names | `resolveColumnName` — same as the artifact |

**Deliberately NOT in scope.** `templates/drizzle-schema.ts:190` builds the unique-index identifier
from the string-taking `columnNameFromField`, which structurally cannot see `@column` — the same
defect class §A4 fixed. It is cosmetic (migrate names uniques by a different convention that nothing
reconciles, so the Drizzle index name is a codegen-local identifier, not a DDL authority) and an index
name is not one of §A2's names. `entity-constants.ts:70`'s `resourcePath` is also out: a URL path is
not a database name and §A2's shape carries nothing for it, so it needs a spec decision, not an
implementation.

**Files:**
- Modify: `server/typescript/packages/codegen-ts/src/templates/entity-constants.ts:218-224`
- Modify: `server/typescript/packages/codegen-ts/src/templates/projection-decl.ts:141-152`
- Modify: `server/typescript/packages/codegen-ts/src/templates/view-decl.ts:80-112`
- Modify: `server/typescript/packages/codegen-ts/src/templates/routes-file.ts:305-313`
- Modify: `server/typescript/packages/codegen-ts/src/templates/entity-file.ts` (pass the new optional
  argument at the two `renderEntityConstants` / `renderProjectionDecl` call sites)
- Test: `server/typescript/packages/codegen-ts/test/names-consumption.test.ts` (extend)
- Golden: `server/typescript/packages/codegen-ts/test/golden/__snapshots__/**`

**Interfaces:**
- Consumes: `resolveObjectNames(obj, strategy)` from `src/names.ts`, and `RenderContext.includeNames`.
- Produces: nothing new for later tasks — this task closes the TypeScript vertical.

> **The one signature hazard.** `renderEntityConstants(entity, ctx.apiPrefix)` is called from
> `src/reference/entity.ts:118`, which ADR-0034 copies **verbatim into every adopter repo**. A
> required third parameter would break every ejected copy. Add an **optional** third parameter so a
> 2-argument call keeps compiling and keeps its current output. `renderProjectionDecl` and
> `renderExistingViewDecl` both already take an options object, so adding a key there is free.

- [ ] **Step 1: Write the failing test**

Append to `test/names-consumption.test.ts`, reusing that file's existing `runGenToMap` helper and
`MODEL` fixture. This asserts the descriptor references the constant rather
than repeating the literal, and — the discriminating half — that it still emits the literal when the
names generator is NOT in the run:

```ts
test("the descriptor references <Entity>Names.name when the artifact is in the run", async () => {
  const files = await runGenToMap([entityFile(), namesFile()], MODEL);
  const entity = files.get("Post.ts")!;
  expect(entity).toContain("$table: PostNames.name");
  // The literal must be GONE, not merely accompanied.
  expect(entity).not.toContain('$table: "posts"');
});

test("the descriptor keeps its literal when the names generator is absent", async () => {
  const files = await runGenToMap([entityFile()], MODEL);
  const entity = files.get("Post.ts")!;
  expect(entity).toContain('$table: "posts"');
  expect(entity).not.toContain("PostNames");
});

test("a projection's dbCol references the constant, honouring an inherited @column", async () => {
  // PostSummary extends Post.callPurpose, whose @column is `purpose_code` — deliberately
  // NOT the snake_case of the field name, so a re-derivation would produce `call_purpose`
  // and this assertion would catch it.
  const files = await runGenToMap([entityFile(), namesFile()], MODEL);
  const proj = files.get("PostSummary.ts")!;
  expect(proj).toContain("dbCol: PostSummaryNames.fields.callPurpose.column");
  expect(proj).not.toContain('dbCol: "purpose_code"');
});
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
cd <repo-root>/server/typescript && bun test packages/codegen-ts/test/names-consumption.test.ts
```
Expected: FAIL on the three new tests — the descriptor and projection still emit literals.

- [ ] **Step 3: Thread the names through `renderEntityConstants`**

In `src/templates/entity-constants.ts`, widen the signature with an OPTIONAL third parameter and use
it only when the physical name provably matches (D4):

```ts
export function renderEntityConstants(
  obj: MetaObject,
  apiPrefix = "",
  // §A6. OPTIONAL, and it must stay optional: `src/reference/entity.ts` is copied
  // verbatim into adopter repos by ADR-0034 scaffold-and-own and calls this with two
  // arguments. A required parameter would fail to compile in every ejected copy.
  names?: { readonly name: string; readonly symbol: Code } | undefined,
): Code {
  const entityName = obj.name;
  const tableName = resolveTableName(obj);
  const path = resourcePath(obj);

  // D4 — reference the constant only where it is provably the same string this
  // descriptor already emitted. `resolveTableName` is the artifact's own resolver, so
  // the two agree by construction here; the check is what keeps that TRUE rather than
  // assumed, and mirrors the guard drizzle-schema.ts:66 already carries.
  const tableExpr: Code =
    names !== undefined && names.name === tableName
      ? code`${names.symbol}.name`
      : code`${JSON.stringify(tableName)}`;
```

Then replace the `$table` emission with `tableExpr`.

- [ ] **Step 4: Pass it from the built-in entity template**

In `src/templates/entity-file.ts`, at the `renderEntityConstants` call, build the same
`resolveObjectNames` + `imp(...)` pair `drizzle-schema.ts:50-57` already builds and pass it through.
Import `resolveObjectNames` from `../names.js` and `siblingSpecifier` from the module
`drizzle-schema.ts` uses, so both sites derive the specifier identically rather than concatenating a
path.

- [ ] **Step 5: Convert the projection, view and M:N sites**

`projection-decl.ts` — add an optional `names` key to its options object and, in the
`constFieldLines` map at `:141-152`, emit `${namesSym}.fields.${f.name}.column` when
`names.fields[f.name]?.column === dbCol`, else keep `JSON.stringify(dbCol)`.

`view-decl.ts` — same treatment for `spec.dbName` at `:88` and the view name at `:110`, through
`ViewDeclOpts`.

`routes-file.ts:312` — this function already receives `ctx`, so read `ctx.includeNames` and return
the constant reference when the resolved column matches.

Every one of these is the same three-line shape: resolve, compare, substitute-or-fall-back. Do not
introduce a shared helper for it — the four call sites differ in how they reach the symbol, and Task
5's review found the explicit form easier to verify.

- [ ] **Step 6: Run the tests and regenerate goldens**

```bash
cd <repo-root>/server/typescript && bun test packages/codegen-ts/test/names-consumption.test.ts
```
Expected: PASS. Then regenerate the goldens this necessarily moves and **read the diff** — every
changed line must be a literal becoming a constant reference, nothing else:

```bash
cd <repo-root>/server/typescript && UPDATE_GOLDEN=1 bun test packages/codegen-ts/test/golden/golden-output.test.ts packages/codegen-ts/test/golden/package-layout.test.ts
cd <repo-root> && git diff --stat server/typescript/packages/codegen-ts/test/golden/
```

- [ ] **Step 7: Run the full codegen-ts and cli suites**

```bash
cd <repo-root>/server/typescript && bun test packages/codegen-ts packages/cli packages/migrate-ts
```
Expected: PASS. `migrate-ts` is in the list deliberately — it consumes the same `resolveTableName`
and a regression there would mean the descriptor and the migration disagree about a table.

- [ ] **Step 8: Typecheck and commit**

```bash
cd <repo-root> && bun run --filter '*' build && bun run --filter '*' typecheck; echo "EXIT=$?"
```
Expected: `EXIT=0`.

```bash
cd <repo-root>
git add server/typescript/packages/codegen-ts/src/templates/ \
        server/typescript/packages/codegen-ts/test/names-consumption.test.ts \
        server/typescript/packages/codegen-ts/test/golden/
```
```bash
cd <repo-root> && printf '%s\n' \
  'feat(codegen-ts): the descriptor, projections and views read the name constants' '' \
  'A6 asks that the names artifact be the single definition of each physical name' \
  'in a run. One site read it; four still spelled the name a second time -- the' \
  'descriptor table, a projection dbCol, a view name and its columns, and the M:N' \
  'join columns.' '' \
  'renderEntityConstants takes the names as an OPTIONAL third argument on purpose:' \
  'the reference entity template is copied verbatim into adopter repos, so a' \
  'required parameter would stop every ejected copy compiling.' \
  > /tmp/msg.txt && git commit -F /tmp/msg.txt
```

---

### Task 3: The C# names artifact

C# is the best-wired port for this: `ColumnNamingStrategy` already exists, is already threaded to
every emit site as `ctx.Config.ColumnNamingStrategy`, and is already settable with
`--column-naming`. Nothing about configuration needs inventing. §A5 rules C# **default ON**.

**Files:**
- Create: `server/csharp/MetaObjects.Codegen/Generators/NamesGenerator.cs`
- Modify: `server/csharp/MetaObjects.Codegen/CSharpNaming.cs:178-241` (add `NamesClassName`)
- Modify: `server/csharp/MetaObjects.Codegen/GeneratorRegistry.cs:90-175` (registry entry)
- Modify: `server/csharp/MetaObjects.Cli/GenCommand.cs:44-45` (`DefaultGeneratorNames`)
- Modify: `fixtures/generator-registry-conformance/registry.json` (append `"csharp"`)
- Modify: `server/csharp/MetaObjects.Codegen.Tests/GeneratorRegistryTests.cs:17-23`
- Modify: `server/csharp/MetaObjects.Cli.Tests/GenListAndSelectionTests.cs:40,59-61`
- Modify: `server/csharp/MetaObjects.Codegen.Tests/CodegenDriftTests.cs:41-44`
- Create: `server/csharp/MetaObjects.Codegen.Tests/NamesGeneratorTests.cs`
- Regenerate: `examples/showcase/generated/csharp/`

**Interfaces:**
- Produces: `public static class <Entity>Names` in `<Entity>Names.g.cs`, with `const string Kind`,
  `const string Name`, `const string Schema` (omitted when undeclared), `const bool ReadOnly`,
  per-field `const string <Field>Field` / `const string <Field>Column`, and
  `static readonly Dictionary<string, string> ColumnsByField`.
- Task 4 consumes those constants from `EntityGenerator` and `DbContextGenerator`.

> **Four hardcoded pins will go red.** `GeneratorRegistryTests.cs:28` asserts
> `ExpectedNames.Length == GeneratorRegistry.Entries.Count`; `GenListAndSelectionTests.cs:40`
> asserts `Assert.Equal(11, lines.Count)`; `GenListAndSelectionTests.cs:59-61` pins the default
> suite as an inline 8-element array. The fourth is the dangerous one:
> `CodegenDriftTests.cs:41-44` holds a **second, independent** `DefaultNames` array kept in sync
> with `GenCommand.DefaultGeneratorNames` **by a source comment only** — no assertion ties them.
> Forgetting it does not fail; the new generator is simply never drift-tested. Step 6 fixes that by
> deriving it instead of copying the literal a third time.

- [ ] **Step 1: Write the failing test**

Create `server/csharp/MetaObjects.Codegen.Tests/NamesGeneratorTests.cs`. Model the fixture setup on
`FilterAllowlistGeneratorTests.cs` (an `InMemoryStringSource` model literal). The model must declare
a field whose `@column` is deliberately **not** the snake_case of its name — that is the coverage gap
that hid the §A4 defect, and without it neither arm of the resolver is discriminated:

```csharp
[Fact]
public void Emits_const_string_members_for_table_and_columns()
{
    var src = GenerateOne("Subscriber");

    Assert.Contains("public static class SubscriberNames", src);
    Assert.Contains("public const string Kind = \"table\";", src);
    Assert.Contains("public const string Name = \"subscribers\";", src);
    Assert.Contains("public const bool ReadOnly = false;", src);

    // Both names, always, always distinguished (A2). createdAt/created_at is the
    // collision that makes the pair non-optional.
    Assert.Contains("public const string CreatedAtField = \"createdAt\";", src);
    Assert.Contains("public const string CreatedAtColumn = \"created_at\";", src);
}

[Fact]
public void An_explicit_column_wins_over_the_naming_strategy()
{
    // callPurpose carries @column: "purpose_code". A re-derivation would say
    // "call_purpose"; only the resolver says "purpose_code".
    var src = GenerateOne("Subscriber");
    Assert.Contains("public const string CallPurposeColumn = \"purpose_code\";", src);
    Assert.DoesNotContain("call_purpose", src);
}

[Fact]
public void Schema_line_is_omitted_when_undeclared()
{
    var src = GenerateOne("Subscriber");
    Assert.DoesNotContain("public const string Schema", src);
}

[Fact]
public void An_object_with_no_primary_source_emits_nothing()
{
    // #248 — participation in the database derives from a declared primary source,
    // never from the object subtype.
    Assert.Empty(new NamesGenerator().Generate(CtxFor("AddressValue")));
}
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
cd <repo-root>/server/csharp && dotnet test MetaObjects.Codegen.Tests/MetaObjects.Codegen.Tests.csproj --nologo 2>&1 | tee /tmp/cs.log; grep -c "error CS" /tmp/cs.log
```
Expected: compile errors naming `NamesGenerator` — the type does not exist yet. **Read the `error CS`
count, not the `Passed!` line**: `dotnet test` prints `Passed!` for a project that failed to build.

- [ ] **Step 3: Add the naming rule**

In `server/csharp/MetaObjects.Codegen/CSharpNaming.cs`, beside `FilterAllowlistName`:

```csharp
public static string NamesClassName(MetaObject entity) => Pascal(entity.Name) + "Names";
```

- [ ] **Step 4: Write the generator**

Create `server/csharp/MetaObjects.Codegen/Generators/NamesGenerator.cs`, modelled on
`FilterAllowlistGenerator.cs:43-92`:

```csharp
/// <summary>
/// GENERATED per-object physical database names (spec A1/A2/A6).
///
/// `const`, not `static readonly`: a [Table("...")]/[Column("...")] attribute argument
/// requires a compile-time constant, and those two sites are the whole reason this
/// artifact can replace a literal at all. The ColumnsByField map is `static readonly`
/// because a Dictionary cannot be const — it serves iteration, not the attributes.
/// </summary>
public sealed class NamesGenerator : PerEntityGenerator
{
    public override string Name => "names";

    protected override EmittedFile? GenerateOne(MetaObject entity, GenContext ctx)
    {
        // #248: participation derives from a declared primary source, never from the
        // object subtype. No primary source, no physical name, no file.
        var source = entity.FindPrimarySource();
        if (source is null) return null;

        var strategy = ctx.Config.ColumnNamingStrategy;
        var cls = CSharpNaming.NamesClassName(entity);

        // A3: the SAME resolvers the EF bindings use, in the same run, with the same
        // arguments. PhysicalName (not DbTable) because DbTable resolves the primary
        // WRITABLE source and this artifact describes the PRIMARY one; where they differ
        // Task 4's guard falls back to the literal rather than arbitrating.
        var physicalName = source.PhysicalName;
        var schema = source.Schema;

        // ADR-0039: Fields() is the RESOLVING accessor. An inherited @column must
        // resolve here or the constant disagrees with the column EF actually binds.
        var fields = entity.Fields()
            .Select(f => (Member: CSharpNaming.Pascal(f.Name), Field: f.Name,
                          Column: CSharpNaming.Column(f, strategy)))
            .OrderBy(t => t.Field, StringComparer.Ordinal)
            .ToList();

        // Two fields whose Pascal forms collide would emit duplicate const members.
        // C# would refuse to compile it, but the error would name a generated file and
        // read as a codegen bug rather than a model one. Fail here, naming the model.
        var dupe = fields.GroupBy(t => t.Member).FirstOrDefault(g => g.Count() > 1);
        if (dupe is not null)
            throw new GeneratorException(
                $"{entity.Name}: fields {string.Join(", ", dupe.Select(d => d.Field))} " +
                $"both yield the constant member '{dupe.Key}'. Rename one, or give it an " +
                $"explicit @column.");

        var sb = new StringBuilder();
        sb.AppendLine("// <auto-generated/>");
        sb.AppendLine("// Generated by MetaObjects names-generator. Do not edit by hand.");
        sb.AppendLine("#nullable enable");
        sb.AppendLine("using System.Collections.Generic;");
        sb.AppendLine();
        sb.AppendLine($"namespace {ctx.Config.Namespace};");
        sb.AppendLine();
        sb.AppendLine($"public static class {cls}");
        sb.AppendLine("{");
        sb.AppendLine($"    public const string Kind = \"{source.EffectiveKind}\";");
        sb.AppendLine($"    public const string Name = \"{physicalName}\";");
        // Omitted, never emitted as null: absent means undeclared, and a `null` constant
        // would read as "declared empty".
        if (!string.IsNullOrEmpty(schema))
            sb.AppendLine($"    public const string Schema = \"{schema}\";");
        sb.AppendLine($"    public const bool ReadOnly = {(source.IsReadOnly() ? "true" : "false")};");
        sb.AppendLine();
        foreach (var (member, field, column) in fields)
        {
            sb.AppendLine($"    public const string {member}Field = \"{field}\";");
            sb.AppendLine($"    public const string {member}Column = \"{column}\";");
        }
        sb.AppendLine();
        sb.AppendLine("    public static readonly Dictionary<string, string> ColumnsByField = new(System.StringComparer.Ordinal)");
        sb.AppendLine("    {");
        foreach (var (member, field, _) in fields)
            sb.AppendLine($"        [\"{field}\"] = {member}Column,");
        sb.AppendLine("    };");
        sb.AppendLine("}");

        return new EmittedFile($"{cls}.g.cs", sb.ToString());
    }
}
```

Note the map's values are **references to the constants**, not repeated literals — the artifact must
not spell a name twice inside itself.

- [ ] **Step 5: Register it and turn it on**

Add a `GeneratorRegistryEntry` to `GeneratorRegistry.cs` with `Name = "names"`, `Tier = Native`, a
one-line description and a `Factory` that constructs without throwing. Add `"names"` to
`GenCommand.DefaultGeneratorNames` (`GenCommand.cs:45`). Append `"csharp"` to the `names` entry's
`ports` array in `fixtures/generator-registry-conformance/registry.json`.

`verify --codegen` needs no wiring — `VerifyCommand.cs:236-238` reads `DefaultGeneratorNames`.

- [ ] **Step 6: Move the pins, and delete the third copy of the default list**

Add `"names"` to `GeneratorRegistryTests.ExpectedNames` (`:17-23`). Bump
`GenListAndSelectionTests.cs:40` from `11` to `12` and add the name to the set on `:41-47`. Add
`"names"` to the inline default-suite array at `:59-61`.

Then fix `CodegenDriftTests.cs:41-44` **by derivation rather than by editing the literal**:

```csharp
// Was a hand-copied duplicate of GenCommand.DefaultGeneratorNames, "kept in sync" by a
// comment with nothing asserting it. A generator added to the real list and forgotten
// here is silently never drift-tested -- a gate that loses coverage fails nothing.
private static readonly IReadOnlyList<string> DefaultNames = GenCommand.DefaultGeneratorNames;
```

If that introduces a project reference `MetaObjects.Codegen.Tests` does not have, add an assertion in
`GenListAndSelectionTests` that the two sequences are equal instead — either is acceptable; a third
hand-maintained copy is not.

- [ ] **Step 7: Run the C# suite**

```bash
cd <repo-root>/server/csharp && dotnet test --nologo 2>&1 | tee /tmp/cs.log; grep -c "error CS" /tmp/cs.log; grep -E "^(Passed|Failed)!" /tmp/cs.log
```
Expected: `0` for the `error CS` count, and four `Passed!` lines (Conformance, Render, Codegen, Cli).

- [ ] **Step 8: Regenerate the showcase**

Default-ON means the committed showcase output is now stale, and release preflight runs
`regen-showcase --check --all-ports`, which refuses to skip a port.

```bash
cd <repo-root> && bun scripts/regen-showcase.ts
cd <repo-root> && git status --short examples/showcase/generated/csharp/
```
Expected: one new file, `SubscriberNames.g.cs`, and no modification to any existing file — Task 3 adds
an artifact and changes no bytes elsewhere. **If an existing file changed, stop**: that means the
generator moved something it should not have.

- [ ] **Step 9: Commit**

```bash
cd <repo-root>
git add server/csharp/MetaObjects.Codegen/Generators/NamesGenerator.cs \
        server/csharp/MetaObjects.Codegen/CSharpNaming.cs \
        server/csharp/MetaObjects.Codegen/GeneratorRegistry.cs \
        server/csharp/MetaObjects.Cli/GenCommand.cs \
        server/csharp/MetaObjects.Codegen.Tests/ \
        server/csharp/MetaObjects.Cli.Tests/GenListAndSelectionTests.cs \
        fixtures/generator-registry-conformance/registry.json \
        examples/showcase/generated/csharp/
```
```bash
cd <repo-root> && printf '%s\n' \
  'feat(csharp): per-object physical database name constants' '' \
  'const string, not static readonly, because a [Table]/[Column] attribute argument' \
  'requires a compile-time constant -- and those two sites are the only reason this' \
  'artifact can replace a literal rather than sit beside one.' '' \
  'The drift test held a second hand-copied default-generator list kept in sync by a' \
  'comment. It now derives from the real one; a generator added to one and forgotten' \
  'in the other was silently never drift-tested.' \
  > /tmp/msg.txt && git commit -F /tmp/msg.txt
```

---

### Task 4: C# generated code reads the constants

Three of C#'s four site classes become references. The fourth does not, on the spec's own
instruction.

| site | file | verdict |
|---|---|---|
| `[Table("...")]` | `EntityGenerator.cs:325-326` | convert — needs `const`, which is what we emit |
| `[Column("...")]` ×7 | `EntityGenerator.cs:496,503,519,964,1007,1032,1305` | convert |
| `.ToView` / `.ToJson` / `.HasColumnName` | `DbContextGenerator.cs:92,180,802,805,819` | convert — ordinary string args, no `const` needed, but single-source-of-truth still applies |
| raw SQL literals | `CallableGenerator.cs:114`, `RoutesGenerator.cs:698-712` | **do not convert** — §A6: *"Not string interpolation inside generated SQL text or comments, where a constant reference is less readable than the name it replaces and buys nothing."* |

**Files:**
- Modify: `server/csharp/MetaObjects.Codegen/Generators/EntityGenerator.cs`
- Modify: `server/csharp/MetaObjects.Codegen/Generators/DbContextGenerator.cs`
- Test: `server/csharp/MetaObjects.Codegen.Tests/NamesGeneratorTests.cs` (extend)
- Regenerate: `examples/showcase/generated/csharp/`, `server/csharp/MetaObjects.IntegrationTests/Generated/`

**Interfaces:**
- Consumes: `<Entity>Names.Name`, `<Entity>Names.<Field>Column` from Task 3.

> **D4 applies here with a real hazard.** `CSharpNaming.Table(entity)` resolves
> `entity.DbTable`, which is the primary **WRITABLE** source; `<Entity>Names.Name` is the
> **PRIMARY** source's `PhysicalName`. For every ordinary object those are one source and one string.
> They diverge for an `object.base` carrying `view @role:primary` + `table @role:replica`, which
> loads clean — the case Plan 1's Task 5 proved reachable in TypeScript. **Compare the two strings
> and fall back to the literal when they differ. Do not pick one.**

- [ ] **Step 1: Write the failing test**

```csharp
[Fact]
public void The_entity_attributes_reference_the_name_constants()
{
    var src = GenerateEntity("Subscriber");
    Assert.Contains("[Table(SubscriberNames.Name)]", src);
    Assert.Contains("[Column(SubscriberNames.CreatedAtColumn)]", src);
    Assert.DoesNotContain("[Table(\"subscribers\")]", src);
    Assert.DoesNotContain("[Column(\"created_at\")]", src);
}

[Fact]
public void A_divergent_primary_source_keeps_the_literal_rather_than_renaming_the_table()
{
    // object.base with a read-only PRIMARY view and a writable REPLICA table: DbTable
    // and PhysicalName answer genuinely different questions. Emitting either constant
    // would rename a table. The guard must fall back.
    var src = GenerateEntity("WeirdBase");
    Assert.Contains("[Table(\"weirds\")]", src);
    Assert.DoesNotContain("WeirdBaseNames.Name", src);
}
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
cd <repo-root>/server/csharp && dotnet test MetaObjects.Codegen.Tests/MetaObjects.Codegen.Tests.csproj --nologo 2>&1 | tee /tmp/cs.log; grep -c "error CS" /tmp/cs.log
```
Expected: `0` compile errors, the two new tests FAIL on the literals still being present.

- [ ] **Step 3: Convert `[Table]`**

In `EntityGenerator.cs:325-326`, resolve the object's names once at the top of the method and compare
before substituting:

```csharp
// A6/D4 -- reference the constant only where it is provably the same string this
// attribute already emitted. CSharpNaming.Table resolves the primary WRITABLE source,
// <Entity>Names.Name the PRIMARY one; for every authorable object those are one source
// and one string, and where they are not, renaming the table is not this task's call.
var tableName = CSharpNaming.Table(entity);
var names = entity.FindPrimarySource();
var tableExpr = names is not null && names.PhysicalName == tableName
    ? $"{CSharpNaming.NamesClassName(entity)}.Name"
    : $"\"{tableName}\"";
if (!isProjection)
    sb.AppendLine($"[Table({tableExpr})]");
```

- [ ] **Step 4: Convert `[Column]` at all seven sites and the three fluent sites**

Same shape per field: compute `CSharpNaming.Column(field, strategy)`, compare it to the artifact's
answer for that field, and substitute `{cls}.{Pascal(field.Name)}Column` on a match. A miss is normal
and must not throw — the TPH fold emits columns for fields belonging to SUBTYPE entities, and the
base's artifact carries only the base's own fields.

The generated entity file must `using` nothing new: the names class lands in the same
`ctx.Config.Namespace`.

- [ ] **Step 5: Run the suite and check for stragglers**

```bash
cd <repo-root>/server/csharp && dotnet test --nologo 2>&1 | tee /tmp/cs.log; grep -c "error CS" /tmp/cs.log; grep -E "^(Passed|Failed)!" /tmp/cs.log
```
Expected: `0` errors, all `Passed!`.

- [ ] **Step 6: Regenerate both committed output sets and read the diff**

```bash
cd <repo-root> && bun scripts/regen-showcase.ts
cd <repo-root> && git diff examples/showcase/generated/csharp/ server/csharp/MetaObjects.IntegrationTests/Generated/ | head -100
```
Every changed line must be a literal becoming a constant reference. `MetaObjects.IntegrationTests/Generated/`
is regenerated by `IntegrationFixtureDriftTests`' own helper — follow that test's documented path
rather than hand-editing the files.

- [ ] **Step 7: Prove it still runs against a real database**

The point of §A6 is that a wrong name now fails a behaviour corpus rather than sitting unread. Prove
the claim rather than asserting it:

```bash
cd <repo-root> && ./scripts/integration-test.sh csharp
```
Expected: PASS. This boots the generated EF model against a real Postgres — if a constant resolved to
the wrong column, the query fails here.

- [ ] **Step 8: Commit**

```bash
cd <repo-root>
git add server/csharp/MetaObjects.Codegen/Generators/EntityGenerator.cs \
        server/csharp/MetaObjects.Codegen/Generators/DbContextGenerator.cs \
        server/csharp/MetaObjects.Codegen.Tests/NamesGeneratorTests.cs \
        server/csharp/MetaObjects.IntegrationTests/Generated/ \
        examples/showcase/generated/csharp/
```
```bash
cd <repo-root> && printf '%s\n' \
  'feat(csharp): the EF bindings read the name constants instead of respelling them' '' \
  'Table and Column attributes and the three fluent mapping calls now reference' \
  '<Entity>Names. Raw SQL literals are deliberately left alone -- the spec excludes' \
  'interpolation inside generated SQL, where a constant reads worse than the name.' '' \
  'The substitution is guarded: DbTable resolves the primary WRITABLE source while the' \
  'artifact resolves the PRIMARY one, and an object.base with a read-only primary view' \
  'beside a writable replica table makes those differ. On a mismatch the literal stays.' \
  > /tmp/msg.txt && git commit -F /tmp/msg.txt
```

---

### Task 5: The Kotlin names artifact

Kotlin already contains the exact pattern this program is trying to generalise:
`KotlinStoredProcGenerator.kt:141,166` emits `const val PROC_NAME = "get_order_report"` and then
consumes its own constant — `exec("SELECT * FROM ${PROC_NAME}(?)", ...)`. Model the arm on it.

**Files:**
- Create: `server/java/codegen-kotlin/src/main/kotlin/com/metaobjects/generator/kotlin/KotlinNamesGenerator.kt`
- Modify: `server/java/codegen-kotlin/src/main/kotlin/com/metaobjects/generator/kotlin/KotlinNaming.kt`
- Modify: `server/java/codegen-kotlin/src/main/kotlin/com/metaobjects/generator/kotlin/GeneratorRegistry.kt`
- Modify: `fixtures/generator-registry-conformance/registry.json` (append `"kotlin"`)
- Modify: `server/java/codegen-kotlin/src/test/kotlin/.../KotlinCodegenSnapshotTest.kt:48-63` (the `when` block)
- Create: `server/java/codegen-kotlin/src/test/kotlin/.../KotlinNamesGeneratorTest.kt`

**Interfaces:**
- Produces: `object <Entity>Names { const val KIND/NAME/SCHEMA/READ_ONLY; const val <FIELD>_FIELD;
  const val <FIELD>_COLUMN; val COLUMNS_BY_FIELD: Map<String, String> }` in `<Entity>Names.kt`.
- Task 6 consumes `NAME` and the `_COLUMN` constants from `KotlinExposedTableGenerator`.

> **`const val` is a hard language constraint, and it is what forced D1.** `const` is legal only on
> `String` and primitive properties — never a `Map`, `List`, or **nullable** reference. The in-repo
> proof is the artifact we were told to copy: `KotlinFilterAllowlistGenerator`'s `FIELDS: Set<String>`
> is `val`, not `const val`. Two consequences: an absent `@schema` must **omit the line** (never emit
> `const val SCHEMA: String? = null`, which does not compile — and this matches what
> `names-decl.ts:25` already does in TypeScript), and `COLUMNS_BY_FIELD` must be a plain `val`.

> **Do not use KotlinPoet.** Every generator in this package hand-rolls the file body with
> `buildString { append(...) }`. `KotlinExposedTableGenerator.kt:33-37` says why outright: PropertySpec
> forces an explicit type, and *"rather than fight the API, this generator hand-rolls the file body as
> a string."*

- [ ] **Step 1: Write the failing test**

Create `KotlinNamesGeneratorTest.kt`, modelled on `KotlinFilterAllowlistGeneratorTest.kt` (substring
assertions on emitted source). The fixture must include a field whose `@column` differs from the
strategy's answer:

```kotlin
@Test
fun `emits const val members for the table and every column`() {
    val src = emitFor("Author")
    assertTrue(src.contains("object AuthorNames {"))
    assertTrue(src.contains("const val KIND: String = \"table\""))
    assertTrue(src.contains("const val NAME: String = \"authors\""))
    assertTrue(src.contains("const val READ_ONLY: Boolean = false"))
    assertTrue(src.contains("const val CREATED_AT_FIELD: String = \"createdAt\""))
    // Kotlin's generator default is snake_case, unlike the shared JVM default.
    assertTrue(src.contains("const val CREATED_AT_COLUMN: String = \"created_at\""))
}

@Test
fun `an explicit column beats the strategy`() {
    val src = emitFor("Author")
    assertTrue(src.contains("const val CALL_PURPOSE_COLUMN: String = \"purpose_code\""))
    assertFalse(src.contains("call_purpose"))
}

@Test
fun `an absent schema omits the line rather than emitting a null const`() {
    // `const val SCHEMA: String? = null` does not compile. Absent means absent.
    assertFalse(emitFor("Author").contains("SCHEMA"))
}

@Test
fun `the columnNaming arg is honoured`() {
    // Modelled on KotlinExposedTableColumnNamingTest, which proves the arg reaches
    // the table generator. The artifact must answer the SAME way or A3 is violated.
    val src = emitFor("Author", mapOf("columnNaming" to "literal"))
    assertTrue(src.contains("const val CREATED_AT_COLUMN: String = \"createdAt\""))
}
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
cd <repo-root>/server/java && mvn -pl codegen-kotlin -am install -DskipTests -q && mvn -pl codegen-kotlin test -Dtest=KotlinNamesGeneratorTest -q
```
Expected: compilation failure — `KotlinNamesGenerator` does not exist.

- [ ] **Step 3: Add the naming rule**

In `KotlinNaming.kt` (the naming SSOT — its own header says not to change a literal here without
changing the generator), beside the existing `Table`/`FilterAllowlist`/`Payload` rules:

```kotlin
fun namesObjectName(shortName: String): String = "${shortName}Names"
```

- [ ] **Step 4: Write the generator**

```kotlin
/**
 * GENERATED per-object physical database names (spec A1/A2/A6).
 *
 * `const val`, so a consumer's reference inlines at compile time — the same shape
 * KotlinStoredProcGenerator already uses for PROC_NAME. Collections cannot be `const`,
 * so COLUMNS_BY_FIELD is a plain `val`, exactly as the filter allowlist's FIELDS is.
 */
class KotlinNamesGenerator : MultiFileDirectGeneratorBase<MetaObject>() {

    override fun emit(entity: MetaObject, outRoot: Path, loader: MetaDataLoader) {
        // #248 — participation derives from a declared primary source, never the subtype.
        val src = primaryRdbSource(entity) ?: return

        val (pkg, shortName) = KotlinNaming.splitFqn(entity.name)
        val className = KotlinNaming.namesObjectName(shortName)
        val strategy = columnNaming()

        // A3: the SAME resolvers the Exposed table binding uses, with the SAME argument.
        // resolveColumnName(field, strategy) -- never the one-arg ColumnNaming.resolve
        // overload, whose default is `literal` while this port's generator default is
        // `snake_case`. Getting that wrong makes the constant disagree with the column.
        val physicalName = src.physicalName.orEmpty()
        val schema = src.schema

        // ADR-0039: fields() resolves, so an inherited @column is seen.
        val rows = entity.fields()
            .map { f -> Triple(screamingSnake(f.name), f.name,
                               KotlinGenUtil.resolveColumnName(f, strategy)) }
            .sortedBy { it.second }

        // Two fields whose SCREAMING_SNAKE forms collide would emit duplicate members.
        // Kotlin would refuse to compile it, but the error would name a generated file
        // and read as a codegen bug. Fail here, naming the model instead.
        rows.groupBy { it.first }.filterValues { it.size > 1 }.forEach { (member, dupes) ->
            throw GeneratorException(
                "${entity.name}: fields ${dupes.joinToString { it.second }} both yield the " +
                "constant member '$member'. Rename one, or give it an explicit @column.")
        }

        val out = buildString {
            if (pkg.isNotEmpty()) append("package $pkg\n\n")
            append("/**\n")
            append(" * GENERATED — physical database names for $shortName.\n")
            append(" */\n")
            append("object $className {\n")
            append("    const val KIND: String = \"${src.effectiveKind}\"\n")
            append("    const val NAME: String = \"$physicalName\"\n")
            // Omitted when absent: `const val SCHEMA: String? = null` does not compile,
            // and an empty string would read as "declared blank" rather than "undeclared".
            if (!schema.isNullOrEmpty()) append("    const val SCHEMA: String = \"$schema\"\n")
            append("    const val READ_ONLY: Boolean = ${src.isReadOnly}\n\n")
            for ((member, field, column) in rows) {
                append("    const val ${member}_FIELD: String = \"$field\"\n")
                append("    const val ${member}_COLUMN: String = \"$column\"\n")
            }
            append("\n    val COLUMNS_BY_FIELD: Map<String, String> = mapOf(\n")
            for ((member, field, _) in rows) append("        \"$field\" to ${member}_COLUMN,\n")
            append("    )\n")
            append("}\n")
        }

        GeneratedFileWriter.write(outRoot.resolve(pkg.replace('.', '/')).resolve("$className.kt"), out)
    }
}
```

The map's values reference the constants rather than repeating the literals — the artifact must not
spell a name twice inside itself.

- [ ] **Step 5: Register and wire the snapshot runner**

Add a `GENERATOR_REGISTRY` entry keyed `names` in `GeneratorRegistry.kt`, append `"kotlin"` to the
manifest entry's `ports`, and add a `"names" -> KotlinNamesGenerator()` case to
`KotlinCodegenSnapshotTest.kt`'s `when` block (`:48-63`) — it `fail()`s on an unknown name, so no
fixture can opt in until that case exists.

Do **not** add `"names"` to an existing fixture's `config.json` in this step. The snapshot runner does
a **bidirectional exact-set match**, so opting a fixture in and committing the new snapshot is a
deliberate, reviewable act — do it in Step 6.

- [ ] **Step 6: Opt one fixture in and commit its snapshot**

Add `"names"` to `codegen-kotlin/src/test/resources/fixtures/entity-with-controller/config.json`, run
the snapshot test once to generate, then **read the new file** before committing it:

```bash
cd <repo-root>/server/java && mvn -pl codegen-kotlin test -Dtest=KotlinCodegenSnapshotTest -q
cd <repo-root> && git status --short server/java/codegen-kotlin/src/test/resources/snapshots/
```
Expected: one new `AuthorNames.kt`, no existing snapshot modified. The first run fails by design with
*"snapshots created for … review + commit"*.

- [ ] **Step 7: Run the Kotlin lanes**

```bash
cd <repo-root>/server/java && mvn -pl codegen-kotlin test -q
```
Expected: PASS. **Note the fast CI lane does not cover this** — `gate_conf_kotlin`
(`scripts/ci-local.sh:473-474`) runs a named subset that excludes `KotlinCodegenSnapshotTest`, so a
snapshot regression is invisible there. Run the module's full `mvn test` by hand.

- [ ] **Step 8: Commit**

```bash
cd <repo-root>
git add server/java/codegen-kotlin/src/main/kotlin/com/metaobjects/generator/kotlin/ \
        server/java/codegen-kotlin/src/test/ \
        fixtures/generator-registry-conformance/registry.json
```
```bash
cd <repo-root> && printf '%s\n' \
  'feat(kotlin): per-object physical database name constants' '' \
  'const val, matching the PROC_NAME constant the stored-proc generator already emits' \
  'and consumes. Kotlin forbids const on a collection or a nullable, so an undeclared' \
  'schema omits its line entirely and the columns map is a plain val -- the same reason' \
  'the filter allowlist declares FIELDS as val rather than const val.' '' \
  'Columns resolve through the two-argument resolver with the generator arg, never the' \
  'one-argument overload: that default is literal while this port emits snake_case, and' \
  'the constant has to agree with the column the table binding actually names.' \
  > /tmp/msg.txt && git commit -F /tmp/msg.txt
```

---

### Task 6: Kotlin generated code reads the constants

Two sites, both in the Exposed table binding. Exposed's DSL takes ordinary `String` arguments, so a
`const val` substitutes with no compile-time or runtime difference — there is no position requiring a
source literal.

| site | file | emits |
|---|---|---|
| table name | `KotlinExposedTableGenerator.kt:601` | `object AuthorTable : Table("authors") {` |
| column names | `KotlinTypeMapper.kt:416+` via `KotlinExposedTableGenerator.kt:635,666,769,795,796,814,1539` | `varchar("purpose_code", 40)` |

**Not sites.** `:699,703` emit index names — an index name is not one of §A2's names. `:651,1225,1254`
`.references(AuthorTable.id)` is **already symbolic**, not a string.

**Files:**
- Modify: `server/java/codegen-kotlin/src/main/kotlin/.../KotlinExposedTableGenerator.kt`
- Modify: `server/java/codegen-kotlin/src/main/kotlin/.../KotlinTypeMapper.kt`
- Modify: `server/java/codegen-kotlin/src/test/resources/snapshots/**` (regenerate)
- Modify: `server/java/integration-tests-kotlin/src/test/kotlin/.../GeneratedAuthorControllerHarness.kt`
  (and its four siblings)

**Interfaces:**
- Consumes: `<Entity>Names.NAME` and `<Entity>Names.<FIELD>_COLUMN` from Task 5.

> **The table generator must emit the names import.** The artifact lands in the same package, so no
> import is needed — but only when the generator is actually in the run. Kotlin generators are
> selected by FQCN in `pom.xml`, so a project running `KotlinExposedTableGenerator` **without**
> `KotlinNamesGenerator` would reference a type that does not exist and fail to compile. Gate the
> substitution on an explicit generator arg, default OFF, and document it. This is the same
> opt-in-by-construction problem TypeScript solved with `includeNames`; Kotlin has no runner
> aggregating markers, so the arg is the honest mechanism.

- [ ] **Step 1: Write the failing test**

```kotlin
@Test
fun `the table binding references the name constants when names is enabled`() {
    val src = emitTableFor("Author", mapOf("useNames" to "true"))
    assertTrue(src.contains("object AuthorTable : Table(AuthorNames.NAME)"))
    assertTrue(src.contains("varchar(AuthorNames.CALL_PURPOSE_COLUMN, 40)"))
    assertFalse(src.contains("Table(\"authors\")"))
}

@Test
fun `the table binding keeps its literals by default`() {
    // Kotlin generators are pom-selected. A project that runs the table generator
    // without the names generator must still compile, so OFF is the default and the
    // output stays byte-identical.
    val src = emitTableFor("Author")
    assertTrue(src.contains("Table(\"authors\")"))
    assertFalse(src.contains("AuthorNames"))
}
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
cd <repo-root>/server/java && mvn -pl codegen-kotlin test -Dtest=KotlinExposedTableNamesTest -q
```
Expected: FAIL — the first test finds the literal, not the constant.

- [ ] **Step 3: Add the opt-in arg and substitute**

Add `ARG_USE_NAMES = "useNames"` beside `ARG_COLUMN_NAMING` and a `useNames(): Boolean` reader
defaulting to `false`. Then, at the table-name site and inside `exposedColumnSpec`'s call sites,
substitute only when enabled **and** the resolved string matches (D4):

```kotlin
// A6/D4 — reference the constant only where it is provably the same string this
// binding already emitted, and only when the names generator is in the run. Kotlin
// generators are pom-selected, so an unconditional reference would fail to compile
// for any project that lists the table generator and not the names one.
val tableExpr = if (useNames() && names?.name == tableName)
    "${KotlinNaming.namesObjectName(shortName)}.NAME" else "\"$tableName\""
```

`exposedColumnSpec` currently takes `colName: String`. Widen it to take the rendered *expression*
rather than the name, so the mapper stays ignorant of where the string came from — the mapper's job
is the column TYPE, not the naming policy.

- [ ] **Step 4: Regenerate snapshots and read every changed line**

```bash
cd <repo-root>/server/java && mvn -pl codegen-kotlin test -Dtest=KotlinCodegenSnapshotTest -q
cd <repo-root> && git diff server/java/codegen-kotlin/src/test/resources/snapshots/
```
Expected: **no diff at all** unless a fixture opts into `useNames`. That is the point of defaulting
OFF — Task 6 changes zero existing bytes. Add one fixture with `useNames` enabled to cover the ON arm.

- [ ] **Step 5: Take the free compile gate**

`integration-tests-kotlin`'s five `Generated*ControllerHarness.kt` each hold a hardcoded
`listOf(...)` of generators (e.g. `GeneratedAuthorControllerHarness.kt:124-131`) and then
walk-and-compile **every** `.kt` under the output dir. Add `KotlinNamesGenerator()` to that list and
set `useNames` on the table generator's args — the compile coverage is free from then on, and it is
the only executable proof that a `const val` reference actually resolves.

```bash
cd <repo-root> && ./scripts/integration-test.sh kotlin
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd <repo-root>
git add server/java/codegen-kotlin/src/main/kotlin/com/metaobjects/generator/kotlin/ \
        server/java/codegen-kotlin/src/test/ \
        server/java/integration-tests-kotlin/src/test/
```
```bash
cd <repo-root> && printf '%s\n' \
  'feat(kotlin): the Exposed table binding reads the name constants' '' \
  'Behind a useNames generator arg, default off. Kotlin generators are selected by' \
  'FQCN in the pom, so a project running the table generator without the names one' \
  'would otherwise reference a type it never generated. Output is byte-identical' \
  'until a project opts in.' \
  > /tmp/msg.txt && git commit -F /tmp/msg.txt
```

---

### Task 7: The Java names artifact — and the port that has nowhere to consume it

Java is the honest case. `codegen-spring` emits **no physical name anywhere**: no JPA annotations
(`grep -rn "@Table\|@Column\|jakarta.persistence" codegen-spring/src/main` is empty), a `<Entity>Dto`
record keyed by logical field names, and a `<Entity>Repository` **interface the consumer implements**.
So the artifact lands with no generated consumer, and §A6's "the behaviour corpora will catch a wrong
name for free" does **not** apply here. Step 6 buys the coverage §A6 cannot.

**Files:**
- Create: `server/java/codegen-spring/src/main/java/com/metaobjects/generator/spring/SpringNamesGenerator.java`
- Modify: `server/java/codegen-spring/src/main/java/com/metaobjects/generator/spring/SpringNaming.java`
- Modify: `server/java/codegen-spring/src/main/java/com/metaobjects/generator/GeneratorRegistry.java:99-129`
- Modify: `fixtures/generator-registry-conformance/registry.json` (append `"java"`)
- Create: `server/java/codegen-spring/src/test/java/.../SpringNamesGeneratorTest.java`
- Modify: `examples/showcase/jvm/pom.xml:61-67`

**Interfaces:**
- Produces: `public final class <Entity>Names` with `public static final String KIND/NAME/SCHEMA`,
  `public static final boolean READ_ONLY`, per-field `<FIELD>_FIELD` / `<FIELD>_COLUMN`,
  `public static final Map<String, String> COLUMNS_BY_FIELD`, and a private constructor.

> **§A3's Java citation in the spec is wrong.** Use **`MetaSource.getPhysicalName()`**
> (`MetaSource.java:278`), not `getTableName()` (`:182`) — the latter returns the raw `@table`
> attribute and is `null` whenever `@table` is unset, which is most objects. Do not use
> `MetaObject.getPrimaryRdbTableName()` either; it wraps the weak one.

> **D5 — Java gains a `columnNaming` generator arg.** `ColumnNaming.resolve(field, strategy)` exists
> (`metadata/.../database/ColumnNaming.java:71`) but its only production caller today is the *runtime*
> `SimpleMappingHandlerDB:516`. Kotlin already reads a `columnNaming` arg off the identical
> `Generator.setArgs` SPI and the identical Maven `<args>` block, so this is JVM parity, not an
> invention. **Default to `ColumnNaming.DEFAULT` (`literal`)**, matching `ObjectManagerDB` — *not*
> Kotlin's `snake_case`. A Java artifact defaulting differently from the Java runtime would be exactly
> the §A3 lie this program exists to remove. Codegen cannot see a runtime `setColumnNaming(...)` call;
> say so in the generator's javadoc and in `docs/features/field-types.md`.

- [ ] **Step 1: Write the failing test**

Model on `SpringFilterAllowlistGeneratorTest.java` — substring assertions on emitted source; there are
**no golden files in `codegen-spring`** (`find -iname "*golden*" -o -iname "*snapshot*"` is empty), so
do not plan for them.

```java
@Test
public void emitsStaticFinalConstantsForTableAndColumns() {
    String src = emitFor("Author");
    assertTrue(src.contains("public final class AuthorNames {"));
    assertTrue(src.contains("public static final String KIND = \"table\";"));
    assertTrue(src.contains("public static final String NAME = \"authors\";"));
    assertTrue(src.contains("public static final boolean READ_ONLY = false;"));
    assertTrue(src.contains("public static final String CREATED_AT_FIELD = \"createdAt\";"));
    // Java's default strategy is `literal`, matching ObjectManagerDB -- NOT snake_case.
    assertTrue(src.contains("public static final String CREATED_AT_COLUMN = \"createdAt\";"));
    assertTrue(src.contains("private AuthorNames() {}"));
}

@Test
public void anImplicitlyNamedSourceStillResolvesItsPhysicalName() {
    // The regression that matters: getTableName() returns null when @table is unset,
    // and the spec told us to call it. getPhysicalName() derives pluralize(snake_case)
    // of the owning entity. A null here would emit NAME = "null".
    assertTrue(emitFor("Author").contains("public static final String NAME = \"authors\";"));
}

@Test
public void theColumnNamingArgIsHonoured() {
    assertTrue(emitFor("Author", Map.of("columnNaming", "snake_case"))
        .contains("public static final String CREATED_AT_COLUMN = \"created_at\";"));
}
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
cd <repo-root>/server/java && mvn -pl metadata,codegen-spring -am install -DskipTests -q && mvn -pl codegen-spring test -Dtest=SpringNamesGeneratorTest -q
```
Expected: compilation failure — `SpringNamesGenerator` does not exist.

- [ ] **Step 3: Add the naming rule and the generator**

Add `public static String namesName(String shortName) { return shortName + "Names"; }` to
`SpringNaming.java`. Then write `SpringNamesGenerator.java` following
`SpringFilterAllowlistGenerator.java:145-225` exactly: `StringBuilder`, `public final class`, a private
constructor, and `GeneratedFileWriter.write(outRoot.resolve(pkg.replace('.', '/')).resolve(className + ".java"))`.

Read the strategy with `getArg("columnNaming", ColumnNaming.DEFAULT)` and resolve every column with
`ColumnNaming.resolve(field, strategy)`. Use `entity.getMetaFields()`'s **resolving** form so an
inherited `@column` is seen (ADR-0039). Emit `COLUMNS_BY_FIELD` as `Map.of(...)` — matching the filter
allowlist's `OPS_BY_FIELD` — with the values referencing the constants. Guard the
SCREAMING_SNAKE collision exactly as Tasks 3 and 5 do.

- [ ] **Step 4: Register**

Add `register(m, "names", SpringNamesGenerator.class.getName(), "...", Tier.NATIVE)` to
`GeneratorRegistry.java`, and append `"java"` to the manifest entry's `ports`. The registry is *"a
stable-name contract and a conformance anchor, not a live factory"* — selection stays FQCN-in-pom, so
there is no default suite to join.

- [ ] **Step 5: Wire the showcase**

Add a `<generator>` block for `com.metaobjects.generator.spring.SpringNamesGenerator` to
`examples/showcase/jvm/pom.xml:61-67`, then regenerate:

```bash
cd <repo-root> && bun scripts/regen-showcase.ts
cd <repo-root> && git status --short examples/showcase/generated/java/
```

- [ ] **Step 6: Buy the coverage §A6 cannot give this port**

Java's generated code has no physical name, so nothing downstream fails when a constant is wrong.
Close that with a test that compares the artifact against the **schema the TypeScript toolchain
actually emits** — the DDL is the authority (ADR-0015), and this is the only thing that can catch a
Java-side resolver drifting from it:

```java
@Test
public void everyEmittedColumnConstantExistsInTheCanonicalSchema() {
    // fixtures/persistence-conformance/canonical/schema.postgres.sql is TS-produced and
    // is what the corpus actually provisions. Java emits no physical name into its own
    // output, so a wrong constant here would otherwise be caught by nothing at all.
    Set<String> ddlColumns = parseColumns(CANONICAL_SCHEMA, "authors");
    for (String c : AuthorNamesEmitted.columnsByField().values()) {
        assertTrue("constant names a column the DDL does not create: " + c,
                   ddlColumns.contains(c));
    }
}
```

Run it with `columnNaming=snake_case`, since that is the strategy the canonical schema was produced
under — and record in the test's comment that Java's *default* is `literal`, so this test pins the
resolver, not the default.

- [ ] **Step 7: Run the Java lanes and commit**

```bash
cd <repo-root>/server/java && mvn -pl codegen-spring test -q && cd <repo-root>/server/java && mvn -q clean install -Djacoco.skip=true
```
Expected: PASS. Never pass `-T`.

```bash
cd <repo-root>
git add server/java/codegen-spring/src/ fixtures/generator-registry-conformance/registry.json \
        examples/showcase/jvm/pom.xml examples/showcase/generated/java/
```
```bash
cd <repo-root> && printf '%s\n' \
  'feat(java): per-object physical database name constants' '' \
  'The design named getTableName() as the JVM resolver. It returns the raw @table' \
  'attribute and is null whenever @table is unset, which is most objects -- the' \
  'constant would have read "null". getPhysicalName() is the resolved four-step name.' '' \
  'Java generated code carries no physical name anywhere, so nothing downstream fails' \
  'when a constant is wrong. Rather than inherit a coverage claim that is only true of' \
  'the ports whose generated code reads these names, the artifact is checked against' \
  'the canonical schema the migration toolchain actually emits.' \
  > /tmp/msg.txt && git commit -F /tmp/msg.txt
```

---

### Task 8: Python — one source resolver, before anything depends on four

Python resolves "which source is this object's primary" **four times, with two different predicates**.
`object_manager.py:632-649` filters `role() == SOURCE_ROLE_PRIMARY`. The three codegen copies —
`router_generator.py:79-87`, `filter_allowlist_generator.py:71-80`, `m2m_codegen.py:79-95` — take the
**first** `TYPE_SOURCE` child with no role filter at all. On any multi-source entity (a declared
`@role: replica`) those disagree.

A names generator copying either one would be a fifth implementation, and §A3 is precisely the rule
that forbids that. This task is the Python equivalent of the TypeScript vertical's Task 2, and it
lands **before** the generator so the generator has one resolver to call.

**Files:**
- Create: `server/python/src/metaobjects/codegen/source_resolution.py`
- Modify: `server/python/src/metaobjects/codegen/generators/router_generator.py:79-87`
- Modify: `server/python/src/metaobjects/codegen/generators/filter_allowlist_generator.py:71-80`
- Modify: `server/python/src/metaobjects/codegen/generators/m2m_codegen.py:79-95`
- Create: `server/python/tests/codegen/test_source_resolution.py`

**Interfaces:**
- Produces: `primary_rdb_source(entity: MetaObject) -> MetaSource | None` and
  `resolve_table_name(entity: MetaObject) -> str | None`. Tasks 9 and every existing generator call
  these.

> **This is a behaviour change, not a pure refactor, and the plan says so.** Three generators
> currently take the first source child regardless of role. Consolidating on the role-filtered
> predicate means an entity whose first declared source is a `replica` now resolves to its `primary`
> instead. That is the correct answer — it is what the runtime already does, and the runtime is what
> reads the rows back — but it can move output. Step 3 exists to find out whether it does.

- [ ] **Step 1: Write the failing test**

```python
def test_primary_wins_over_a_replica_declared_first() -> None:
    # The discriminating shape the three codegen copies get wrong: declaration order
    # puts the replica first, so a first-child scan picks the wrong source and names
    # the wrong table.
    entity = load_entity("ReplicaFirst")
    src = primary_rdb_source(entity)
    assert src is not None
    assert src.role() == SOURCE_ROLE_PRIMARY
    assert resolve_table_name(entity) == "replica_firsts"


def test_codegen_and_runtime_agree_on_every_conformance_entity() -> None:
    # The property that matters is AGREEMENT, not either answer alone. object_manager
    # already filtered by role; the generators did not. Pin them together so they
    # cannot drift apart again.
    root = load_canonical_model()
    for entity in root.objects():
        assert resolve_table_name(entity) == ObjectManager._table_name(om, entity)


def test_no_primary_source_resolves_to_none() -> None:
    # #248 — participation derives from a declared primary source, never the subtype.
    assert primary_rdb_source(load_entity("AddressValue")) is None
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
cd <repo-root>/server/python && uv run --extra integration pytest tests/codegen/test_source_resolution.py -q
```
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Write the module and measure the blast radius before switching callers**

Create `source_resolution.py` with the role-filtered predicate, mirroring `object_manager.py:632-649`:

```python
def primary_rdb_source(entity: MetaObject) -> MetaSource | None:
    """THE primary rdb source for an object, or None.

    One definition, because A3 requires every physical name in a run to come from the
    same resolver. This was hand-duplicated four times with two different predicates:
    the runtime filtered on ``@role: primary`` and the three codegen copies took the
    first source child, so they disagreed on any multi-source entity.

    ADR-0039: ``children()`` resolves, so an inherited source is seen.
    """
```

Then, **before** changing any caller, measure whether the predicate change moves committed output:

```bash
cd <repo-root> && bun scripts/regen-showcase.ts && git status --short examples/showcase/generated/python/
```
Record the answer in the task report either way. An empty diff means no shipped model has a
declaration-order-sensitive source; a non-empty diff means one does, and every changed line must be
reviewed as a **fix**, not accepted as churn.

- [ ] **Step 4: Switch all three codegen callers**

Replace each local `_primary_source_rdb` with an import of the shared one. Delete the three local
definitions — leaving them is how this recurs.

- [ ] **Step 5: Run the Python suite**

```bash
cd <repo-root>/server/python && uv run --extra integration pytest tests/ -q
```
Expected: PASS (~5 min). Then run the type checker by hand — **nothing in CI does**
(`grep -rn mypy .github/workflows scripts/ci-local.sh` is empty):

```bash
cd <repo-root>/server/python && uv run mypy src/metaobjects; echo "EXIT=$?"
```

- [ ] **Step 6: Commit**

```bash
cd <repo-root>
git add server/python/src/metaobjects/codegen/source_resolution.py \
        server/python/src/metaobjects/codegen/generators/ \
        server/python/tests/codegen/test_source_resolution.py
```
```bash
cd <repo-root> && printf '%s\n' \
  'refactor(python): one primary-source resolver, not four with two answers' '' \
  'The runtime filtered sources on role primary; the three codegen copies took the' \
  'first source child and ignored role. On any entity declaring a replica they name' \
  'different tables -- and the runtime is the one that reads the rows back.' '' \
  'A new test pins codegen and runtime to the same answer for every entity in the' \
  'canonical model, so they cannot drift apart again.' \
  > /tmp/msg.txt && git commit -F /tmp/msg.txt
```

---

### Task 9: The Python names artifact — and retiring the knob that refuses itself

§A5 rules Python **default ON**: the generated Python surface is a bare Pydantic class with no ORM
binding, so there is no other route to a physical name. This task also lifts the refusal
`GenConfig.column_naming` currently raises, because that refusal's stated reason —
*"Python codegen emits no physical column name"* — stops being true here.

**Files:**
- Create: `server/python/src/metaobjects/codegen/generators/names_generator.py`
- Modify: `server/python/src/metaobjects/codegen/config.py:33-35,71-78` (comment + delete the refusal)
- Modify: `server/python/tests/unit/test_no_dead_config_fields.py:55-64` (`INERT_BY_DESIGN`)
- Modify: `server/python/src/metaobjects/cli.py:111-121` (default suite) and the `gen` argparse block
- Modify: `server/python/src/metaobjects/codegen/generator_registry.py:92-153`
- Modify: `server/python/tests/codegen/test_cli_registry.py:39` (`10` → `11`)
- Modify: `fixtures/generator-registry-conformance/registry.json` (append `"python"`)
- Create: `server/python/tests/codegen/test_names_generator.py`
- Regenerate: `examples/showcase/generated/python/`

**Interfaces:**
- Produces: `subscriber_names.py` with module-level `Final` constants — `SUBSCRIBER_KIND`,
  `SUBSCRIBER_NAME`, `SUBSCRIBER_SCHEMA` (omitted when undeclared), `SUBSCRIBER_READ_ONLY`,
  `SUBSCRIBER_<FIELD>_FIELD` / `_COLUMN`, and `SUBSCRIBER_COLUMNS_BY_FIELD: Final[dict[str, str]]`.
- Consumes: `primary_rdb_source` / `resolve_table_name` from Task 8.

> **The dead-config gate has two arms and they fire in opposite directions.**
> `test_no_dead_config_fields.py` asserts (1) every `GenConfig` field not in `INERT_BY_DESIGN` is read
> somewhere, and (2) every field **in** `INERT_BY_DESIGN` is read **nowhere**. Its regex is
> `\.{field}\b`, so the instant this generator writes `ctx.config.column_naming`, arm (2) goes red
> demanding the exemption be deleted. **That is the gate working.** Delete the `column_naming` entry
> and the `__post_init__` refusal in the same commit as the generator — never before. **Leave
> `output_layout` and `emit_abstract_shapes` alone**; their reasons have not changed.

> **The handoff over-priced this.** It warned that a Python config key costs `TOP_LEVEL_KEYS`,
> `TARGET_KEYS`, the JSON schema and `test_schema_and_loader_accept_EXACTLY_the_same_keys`. That gate
> governs **`metaobjects.config.yaml`** keys; `column_naming` is a `GenConfig` field and is in neither
> tuple. It is irrelevant here unless we also expose the strategy in YAML — which this task does not.
> The `--column-naming` CLI flag (D5) is the lever, matching C#.

- [ ] **Step 1: Write the failing test**

```python
def test_emits_final_constants_for_table_and_columns() -> None:
    src = emit_names_for("Subscriber")
    assert 'SUBSCRIBER_KIND: Final[str] = "table"' in src
    assert 'SUBSCRIBER_NAME: Final[str] = "subscribers"' in src
    assert "SUBSCRIBER_READ_ONLY: Final[bool] = False" in src
    # A2: both names, always, always distinguished.
    assert 'SUBSCRIBER_CREATED_AT_FIELD: Final[str] = "createdAt"' in src
    # Python's default strategy is literal, matching ObjectManager.
    assert 'SUBSCRIBER_CREATED_AT_COLUMN: Final[str] = "createdAt"' in src


def test_an_explicit_column_beats_the_strategy() -> None:
    # @column: "purpose_code" -- a re-derivation would say "call_purpose".
    src = emit_names_for("Subscriber")
    assert 'SUBSCRIBER_CALL_PURPOSE_COLUMN: Final[str] = "purpose_code"' in src
    assert "call_purpose" not in src


def test_column_naming_now_reaches_the_generator() -> None:
    # The whole reason GenConfig.column_naming stops refusing.
    src = emit_names_for("Subscriber", column_naming="snake_case")
    assert 'SUBSCRIBER_CREATED_AT_COLUMN: Final[str] = "created_at"' in src


def test_gen_config_no_longer_refuses_a_non_default_strategy() -> None:
    GenConfig(out_dir="/tmp/x", column_naming="snake_case")  # must not raise


def test_the_artifact_agrees_with_the_runtime() -> None:
    # Python's generated code contains no physical name, so nothing downstream fails
    # when a constant is wrong. ObjectManager is the only thing that names a column at
    # runtime; pin the artifact to it.
    for field in load_entity("Subscriber").fields():
        assert emitted_column_for(field) == _column_of(field, "literal")
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
cd <repo-root>/server/python && uv run --extra integration pytest tests/codegen/test_names_generator.py -q
```
Expected: FAIL — the module does not exist, and `GenConfig` still raises.

- [ ] **Step 3: Write the generator**

Model on `filter_allowlist_generator.py:270-332`: a `render_*` method returning `str | None`, a
`generate` that wraps `per_entity`, `generated_header(...)`, a module docstring,
`from __future__ import annotations`, and `EmittedFile(path=f"{snake}_names.py", content=ruff_format(source))`.
The `{snake}_{suffix}.py` name is the port's convention for an auxiliary per-entity artifact (the
PascalCase form is reserved for the file carrying the primary class), and it is what the spec already
specifies.

Emit `Final` scalars rather than a dict of dicts: mypy narrows a `Final[str]` to a literal type, while
a dict lookup is merely `str`. Guard the SCREAMING_SNAKE collision as the other ports do. Emit
`{ENTITY}_COLUMNS_BY_FIELD: Final[dict[str, str]]` with the values **referencing the constants**.

- [ ] **Step 4: Lift the refusal and both halves of the gate, in one commit**

Delete `config.py:71-78`'s `column_naming` refusal, correct the field comment at `:33-35` (it says
Python codegen emits no physical column name — no longer true), and delete the `column_naming` entry
from `INERT_BY_DESIGN` at `test_no_dead_config_fields.py:55-64`.

- [ ] **Step 5: Add the CLI flag, register, and turn it on**

Add `--column-naming` to the `gen` argparse block (`cli.py:1570-1641`) with choices
`literal|snake_case|kebab-case`, default `literal`, and thread it into the `GenConfig(...)`
construction at `cli.py:396-400`. Add `names_generator()` to `_default_generators()` (`:111-121`), add
a `GENERATOR_REGISTRY` entry (`generator_registry.py:92-153`), bump
`test_cli_registry.py:39` from `10` to `11`, and append `"python"` to the manifest's `ports`.

- [ ] **Step 6: Run the suite, mypy, and regenerate the showcase**

```bash
cd <repo-root>/server/python && uv run --extra integration pytest tests/ -q
cd <repo-root>/server/python && uv run mypy src/metaobjects; echo "MYPY=$?"
cd <repo-root> && bun scripts/regen-showcase.ts && git status --short examples/showcase/generated/python/
```
Expected: tests PASS, `MYPY=0`, and exactly one new file `subscriber_names.py` with **no existing
file modified**. Default-ON makes the showcase mandatory: release preflight runs
`regen-showcase --check --all-ports` and refuses to skip a port.

- [ ] **Step 7: Commit**

```bash
cd <repo-root>
git add server/python/src/metaobjects/ server/python/tests/ \
        fixtures/generator-registry-conformance/registry.json \
        examples/showcase/generated/python/
```
```bash
cd <repo-root> && printf '%s\n' \
  'feat(python): per-object physical database name constants, default on' '' \
  'The generated Python surface is a bare Pydantic class with no ORM binding, so' \
  'until now there was no route at all from a model to the column a row actually' \
  'lands in. Module-level Final scalars rather than a mapping, because mypy narrows' \
  'a Final[str] to a literal type and a dict lookup is only str.' '' \
  'GenConfig.column_naming stops refusing a non-default value: it refused because' \
  'nothing read it, and something reads it now. The dead-config gate demanded the' \
  'exemption be deleted in the same change, which is the gate doing its job.' \
  > /tmp/msg.txt && git commit -F /tmp/msg.txt
```

---

### Task 10: Teach the artifact in the four port docs and correct the lever table

`docs/ports/typescript.md:298-343` documents `<Entity>Names` with the typed-handle caveat. The other
four port docs do not mention it — verified: `grep -n -i "names artifact\|<Entity>Names\|typed handle"
docs/ports/{java,kotlin,python,csharp}.md` returns nothing. That was correct while the feature was
TypeScript-only; this plan makes it wrong.

**Files:**
- Modify: `docs/ports/{csharp,java,kotlin,python}.md` (a `<Entity>Names` section each)
- Modify: `docs/features/field-types.md:50-66` (the column-naming lever table and the paragraph under it)
- Modify: `docs/ports/java.md:264-278`, `docs/ports/kotlin.md:12,72,74-89` (generator inventories)

- [ ] **Step 1: Write the four port sections**

Mirror `docs/ports/typescript.md:298-343` in each, in that port's idiom, and carry **the caveat
verbatim in every one** — the spec requires it and it is the one part of this doctrine that stops an
agent making code worse:

> **Prefer a typed handle where one exists.** If the ORM gives you a type-checked object for the same
> thing, use that. Replacing it with a string constant trades an error the compiler catches for one
> the database raises at runtime. These constants are for the places with no typed handle: raw SQL, a
> migration script, a log line, an external system's column mapping.

Say per port where that limit actually bites. C# and Kotlin **have** typed handles (EF properties,
Exposed `Column` objects), so the caveat is live advice. **Java and Python have none** — their
generated code carries no physical name at all — so in those two docs state plainly that the constants
are the *only* route, which is precisely why §A5 turns Python on by default.

- [ ] **Step 2: Correct the lever table**

`docs/features/field-types.md:50-56` currently reads, row by row: C# `--column-naming`; **Python
(`ObjectManager` — codegen names no column)**; Java `SimpleMappingHandlerDB.setColumnNaming(...)`;
Kotlin `<columnNaming>` in the pom. Three rows change:

- Python gains a codegen lever: `--column-naming` on `metaobjects gen`.
- Java gains one: `<args><columnNaming>…</columnNaming></args>`, **default `literal`**.
- Kotlin's row is already right, but note its generator default is `snake_case` while the shared JVM
  runtime default is `literal` — a deliberate divergence (`ColumnNaming.java:26-28`) that a reader
  comparing the two rows will otherwise think is a typo.

Then delete the paragraph at `:59-66` — *"Python has no codegen-side setting because Python codegen
names no column"* — and replace it with the honest successor: **codegen and runtime carry separate
column-naming settings in Java and Python, and nothing reconciles them.** Codegen cannot see a runtime
`setColumnNaming(...)` / `ObjectManager(column_naming=...)` call. A project that changes one must
change the other.

- [ ] **Step 3: Fix the two stale generator inventories**

`docs/ports/java.md:264-278` lists 4 of ~11 registered generators. `docs/ports/kotlin.md` hardcodes
"14 generators" at `:12` and `:72` with a table at `:74-89`. Neither has any automated enforcement.
Add the `names` row to both and correct Kotlin's count. Do not attempt to fix the other omissions
here — that is a separate cleanup and mixing it in makes this diff unreviewable.

- [ ] **Step 4: Run the doc gates**

Editing `agent-context/` churns all five conformance corpora; editing `docs/` does not, but the
fenced-block gate (#337) loads every JSON block under `docs/` against the strict registry:

```bash
cd <repo-root>/server/typescript && bun test packages/codegen-ts/test/golden/docs-file-conformance.test.ts packages/codegen-ts/test/golden/docs-cross-link-conformance.test.ts
```
Expected: PASS. Any fenced metadata example added must load against the strict registry.

- [ ] **Step 5: Commit**

```bash
cd <repo-root> && git add docs/ports/ docs/features/field-types.md
```
```bash
cd <repo-root> && printf '%s\n' \
  'docs: teach the names artifact in the four remaining ports' '' \
  'Each carries the typed-handle caveat, because a skill that told an agent to swap a' \
  'compile-checked column object for a string constant would make generated code' \
  'worse. In Java and Python there is no typed handle to prefer -- their generated' \
  'code names no column at all -- and both docs say so.' '' \
  'The lever table said Python had no codegen-side setting because Python codegen' \
  'named no column. It does now. Java gains the same arg Kotlin already had, and the' \
  'table now warns that codegen and runtime hold separate settings that nothing' \
  'reconciles.' \
  > /tmp/msg.txt && git commit -F /tmp/msg.txt
```

---

### Task 11: The codegen-ownership doctrine — four narrow fixes the evidence supports

This task began as "an adopter's agent resisted codegen; teach the doctrine hard." Two read-only
investigations were commissioned to establish which of three causes applied — guidance **absent**,
**present but weak**, or **present and ignored** — because the fix differs completely. Both reported.
**Neither supports the original framing, and the task is scoped to what they found instead.**

**What the transcript investigation found** (all 131 sessions, every assistant text block extracted
and searched — full coverage of the retained window, not a sample):

- The concrete hand-written artifacts all originate **before the earliest retained transcript**. The
  decision moment is not in the data.
- The one well-evidenced case of codegen *not* being used was **an upstream MetaObjects bug**: on a
  shared-enum unification the agent loaded the authoring skill unprompted, quoted its guidance, proved
  the mechanism by delete-and-regenerate, found that the data-class generator emitted a cross-package
  enum import while the table and repository generators did not, and correctly declined to ship. That
  is issue #246 — **which MetaObjects fixed in 0.20.11.**
- An audit of all 85 generated repository bases found **84 correctly extended**; the one exception was
  correctly justified, and the auditing agent retracted its own finding.
- The agent explicitly refused to hardcode a status list "because a hardcoded list is exactly the
  fourth copy that drifts next."

**What the product audit found:**

- Framings 1 and 2 (*use codegen*; *the generators are yours to change*) are **already taught as
  imperatives** in the adopter-facing skill — `SKILL.md:44-46`, `:59-83` (*"you do not need to ask
  first"*), `:169-192` (*"a first-class, expected activity — not an escape hatch"*), `:194-207`. More
  exhortation would be noise.
- Framing 4 (two kinds of generated output) is **already written and accurate** —
  `docs/features/codegen-concepts.md` §5 states as a documented **non-feature** that no shipped
  generator emits a base/extension pair and no write path is write-if-absent, and §6 notes `runGen`
  accepts `skip-existing` but no CLI flag selects it. **The skill points past it**: `SKILL.md:332`
  cross-references that document but only §3.
- **A confirmed, dated defect.** `SKILL.md:19-28` step 4 tells adopters codegen *"Refuses to overwrite
  any file that does NOT carry the `@generated` header; overwrites the ones that do."* That is **true
  for Java and Kotlin only** (`GeneratedFileWriter.looksGenerated`). TypeScript, C# and Python decide
  by **hash manifest**, and the write decision never reads the header. The line dates to 2026-06-02,
  when it was right for TypeScript; the mechanism changed 2026-08-17. It also contradicts the same
  file at `:35-36`.

That defect is the highest-value item in this task: it tells an adopter's agent that **deleting the
`@generated` header takes ownership of a TypeScript file.** It does not — *editing the content* does,
because that is what breaks the hash. An agent following it would delete the marker, believe the file
was safe, and get it overwritten.

**Files:**
- Modify: `agent-context/skills/metaobjects-codegen/SKILL.md:19-28` (the per-port correction) and
  `:332` (the cross-reference)
- Modify: `docs/features/codegen-concepts.md` §5 (the Java abstract/concrete note)
- Test: `server/typescript/packages/sdk/test/agent-context/drift.test.ts` (runs automatically)

> **Editing `agent-context/` churns all five conformance corpora.** Regenerate with the committed
> script, then rebundle — do not hand-edit the corpora.

> **The drift gate reads narrative prose, not just fenced blocks.** Plan 1's Task 6 tripped it with the
> phrase `to_snake_case(field.name)`, because `field.name` matches its `field.<subtype>` pattern and
> `name` is not a registered field subtype. Watch for that when writing about columns.

- [ ] **Step 1: Write the failing test**

Add to `sdk/test/agent-context/` a test that pins the corrected claim, so it cannot silently drift back:

```ts
test("the skill states the overwrite policy PER PORT, not as one universal rule", () => {
  const skill = readSkill("metaobjects-codegen");
  // The retired claim. It was true for TS until 2026-08-17 and is still true for the
  // JVM, which is exactly why stating it unqualified is worse than stating nothing.
  expect(skill).not.toMatch(/Refuses to overwrite any file that does NOT carry the `@generated` header/);
  // The hash manifest is what actually decides in three of five ports; an adopter who
  // does not know that will delete the header and believe the file is theirs.
  expect(skill).toMatch(/hash manifest/i);
});

test("the skill points at the section that answers the write-once question", () => {
  // codegen-concepts.md 5 and 6 are where "no shipped generator emits a
  // base/extension pair, and no write path is write-if-absent" is stated. The skill
  // cross-referenced that file but only at 3, so an agent following the pointer
  // never arrived at the answer.
  expect(readSkill("metaobjects-codegen")).toMatch(/codegen-concepts\.md#5-preserving-hand-edits/);
});
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
cd <repo-root>/server/typescript && bun test packages/sdk/test/agent-context/
```
Expected: FAIL on both.

- [ ] **Step 3: Correct the overwrite-policy claim, per port**

Replace `SKILL.md:19-28` step 4 with the actual mechanism. Both halves are load-bearing:

```markdown
4. Decides whether it may overwrite a file — and **the rule differs by port**:
   - **TypeScript, C#, Python** — by a committed **hash manifest**
     (`.metaobjects/.gen-state/.hashes.json`). If a file still hashes to what the
     generator recorded writing, it is safe to overwrite; if it was edited, or there is
     no record of it, the write is **refused by name**. TypeScript additionally
     three-way-merges against a snapshot when one is present locally.
   - **Java, Kotlin** — by the `@generated` **marker line** in the file. Delete the
     marker and regeneration will never touch that file again.

   **Do not delete the `@generated` header to take ownership of a TypeScript, C# or
   Python file.** It is informational there and the write decision never reads it — what
   makes a file yours is *editing its content*, which breaks the hash. Deleting the
   header changes nothing except your ability to tell what generated it.
```

- [ ] **Step 4: Repoint the cross-reference**

At `SKILL.md:332`, extend the `codegen-concepts.md` link beyond §3 to name §5 and §6 by title, with
one line saying what a reader will find there: that MetaObjects ships exactly one hand-edit strategy,
that no generator emits a generated-base + hand-owned-concrete pair, and that write-if-absent exists
in the engine but no CLI flag reaches it.

- [ ] **Step 5: Add the one genuinely missing fact**

In `docs/features/codegen-concepts.md` §5, note that the JVM does have a generator emitting the
abstract/concrete shape — `JavaObjectCodeGenerator`, registered as `entity` — but that (a) it is off
the documented mainline (the showcase and `docs/ports/java.md` teach the `<Entity>Dto` record instead),
(b) **both halves regenerate every run**, with no write-once semantics, and (c) **Kotlin does not
produce this shape at all** — `KotlinEntityGenerator` emits one flat data class, and
`emitAbstractShapes` defaults off. A reader who assumes the Java pattern is the JVM pattern is wrong
about half the JVM.

- [ ] **Step 6: Carry the rule into the skills that can act on it — and only those**

The spec's doctrine section says *"All six `metaobjects-*` skills must teach it."* A grep across the
skills confirms only `metaobjects-codegen` does. Take the requirement, but not literally: a names
constant is not actionable inside `metaobjects-prompts`, and padding a skill with a rule its reader
cannot use is how a skill stops being read. Add a one-paragraph cross-reference — never a copy, which
would be a second surface that drifts — to the three where it IS actionable:

- **`metaobjects-authoring`** — this is where `@column` gets declared, so it is where a reader learns
  that the physical name they are choosing becomes a constant rather than something to retype.
- **`metaobjects-runtime-ui`** — where hand-written queries are written, which is the raw-string
  boundary the constants exist for. Carry the typed-handle caveat here in full; this is the one skill
  whose reader is most likely to swap a typed column object for a string and make the code worse.
- **`metaobjects-verify`** — a wrong physical name is drift, and this is the drift skill.

Record in the task report that `metaobjects-prompts` and `metaobjects-audit` were deliberately left
out, with that reason, so the next person does not read the omission as an oversight.

- [ ] **Step 7: Regenerate the corpora and rebundle**

```bash
cd <repo-root>/server/typescript/packages/sdk && bun scripts/regen-agent-context-conformance.ts
cd <repo-root> && node scripts/bundle-agent-context.mjs
cd <repo-root>/server/typescript && bun test packages/sdk
```
Expected: PASS, including the drift gate.

- [ ] **Step 8: Prove the other four ports' corpora moved with it**

```bash
cd <repo-root> && ./scripts/ci-local.sh --only python --only csharp
```
Expected: PASS. The agent-context corpus is byte-gated in all five ports; a regenerated corpus that
was not rebundled reds four of them.

- [ ] **Step 9: Commit**

```bash
cd <repo-root> && git add agent-context/ docs/features/codegen-concepts.md \
        server/typescript/packages/sdk/ fixtures/agent-context-conformance/
```
```bash
cd <repo-root> && printf '%s\n' \
  'docs(agent-context): the skill taught one port overwrite rule as if it were all five' '' \
  'It told adopters codegen refuses any file without a @generated header and overwrites' \
  'the ones that have it. True for Java and Kotlin. TypeScript, C# and Python decide by' \
  'hash manifest and never read the header -- so the advice an agent draws from it, that' \
  'deleting the header takes ownership of a file, is backwards. Editing the content is' \
  'what takes ownership, because that is what breaks the hash.' '' \
  'The line was correct when written and the mechanism changed under it two weeks later.' \
  'It also contradicted the same file twenty lines down.' '' \
  'The skill also pointed at the codegen-concepts document but only at the authoring' \
  'tradeoff table, never at the two sections stating that no shipped generator emits a' \
  'generated-base plus hand-owned-concrete pair and that no write path is write-if-absent' \
  '-- which is the question a reader following that pointer is usually asking.' \
  > /tmp/msg.txt && git commit -F /tmp/msg.txt
```

---

## Not in this plan

- **Programs B and C.** Separate programs with separate justifications (spec §B, §C).
- **The `object.base` divergence ruling.** An `object.base` carrying `view @role:primary` +
  `table @role:replica` loads clean while `resolveTableName` and `dbTable` disagree. Every consumption
  task in this plan falls back to the literal rather than arbitrating. Deciding whether that shape
  should be refused, or the two resolvers reconciled, renames tables for anyone using it and is its
  own unit.
- **`resourcePath` as a constant.** A URL path is not a database name and §A2's shape carries nothing
  for it. Needs a spec decision.
- **`drizzle-schema.ts:190`'s unique-index identifier.** Built from the string-taking
  `columnNameFromField`, so it cannot see `@column` — but it is a codegen-local identifier that
  nothing reconciles with migrate's own convention, and an index name is not one of §A2's names.
- **`namesFile({ target })`.** The TypeScript generator takes no options, so it can only ever emit to
  the default target; a project routing `entityFile({target:"db"})` gets no constants. Recorded by
  Plan 1's Task 5 review; still open.
- **Making the TypeScript integration lane exercise the names ON arm.** Flagged by Plan 1's Task 5
  implementer: no config in that lane enables `namesFile()`, so it proves only that the OFF arm did
  not regress.
- **The other stale rows in `docs/ports/java.md`'s generator table** (it lists 4 of ~11).

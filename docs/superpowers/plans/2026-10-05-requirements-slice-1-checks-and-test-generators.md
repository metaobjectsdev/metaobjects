# Requirements slice 1 — requirement checks and requirement-test generators in every port

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the requirement gate in every port's `verify` and ship a `requirement-tests` generator in every port (pytest, JUnit for Java and Kotlin, xUnit for C#), all held to the TypeScript reference by two new shared corpora.

**Architecture:** The TypeScript implementation stays the reference and gains three seams. Each other port gets the same walk, claim resolver and checks in its core library, wired into its existing `verify` beside the field lint, plus a generator that emits a fully machine-owned test file whose tests call project-owned witness functions. Nothing is merged by hand in the four ports that have no three-way merge. Two corpora pin what must not differ between ports: the diagnostics for a model, and the identities and skip states of the tests generated from it.

**Tech Stack:** TypeScript (Bun, `bun:test`), Python (pytest; generator runs on 3.11+, its output parses on 3.9), Java (Maven, JUnit Jupiter in generated output, JUnit 4 in this repository's own tests), Kotlin (KotlinPoet or string emit, JUnit Jupiter), C# (.NET, xUnit).

**Spec:** A private design report held outside this repository (its sections 4, 10 and 11; section 11 is the owner's rulings and overrides the rest). Everything an implementer needs from it is restated here. Existing public documents this plan changes or relies on: `docs/features/requirements.md`, `docs/CONFORMANCE.md` ("Split coverage"), `fixtures/requirement-harness/README.md`, `fixtures/field-lint-conformance/README.md` (the precedent for a `verify` check shipped in every port).

**This is slice 1.** Not in this slice: publishing requirements across repositories, inherited requirements, the Python publisher and `deps` commands, transitive dependencies with the five-level test, and the response-model items.

## Amendments after the owner's answers (2026-10-05)

The plan as merged asked nine questions. The owner answered them, and added one requirement while the work was starting. What changed in this document:

| Change | Where |
|---|---|
| **Answer 8, "make it uniform".** The filter that selects which requirements get a test offers the same two options in all five ports: a predicate over one shared requirement view, and the uncovered-warning switch. | Table F, Table I (two new rows), Table J (the `filter` option, seven named predicates, seven `filter-*` cases), Tasks 3, 4, 6, 8, 10, 11 |
| **Added requirement: the generator is application-owned.** "Whatever we do for this around requirements and testing needs to also eject and be owned by the application. It may change or significantly. This is just a recommended approach." In every port the `requirement-tests` generator, with its default renderer, is ejectable through that port's existing eject mechanism, and a test proves an unedited ejected copy produces byte-identical output. The checks in `verify` stay stock: they are the shared contract. | Table L (new), Table K, Tasks 3, 6, 8, 10, 11, 12 |
| A separate identity case `worked-example` holds the model of Tables F, G and H; `concern-fanout` keeps its fan-out meaning. One case could not pin both. The identity corpus is 24 cases. | Table J, Tasks 4, 6, 8, 11 |
| Answers 1 to 7 and 9 take the plan's stated defaults, with answers 3 and 4 confirmed as written. | [Answered questions](#answered-questions) |

Every port was confirmed to have an eject mechanism before Table L was written (`meta eject`, `metaobjects eject`, `mvn metaobjects:eject` for Java and Kotlin, `dotnet meta eject`); none had to be invented.

## How this plan was verified

Every path, function and test file cited below was read or located in the tree at `5153aa9dc`, unless it is marked **UNVERIFIED**. Read in full: `codegen-ts/src/requirement-walk.ts`, `codegen-ts/src/generators/requirement-tests.ts`, `codegen-ts/src/templates/requirement-test.ts`, `cli/src/lib/requirement-check.ts`, `cli/src/lib/requirement-lint.ts`, `metadata/src/core/requirement/resolve-claim.ts`, the `MetaRequirement` class, `requirement-constants.ts`, `cli/src/commands/verify.ts:670-800`, `fixtures/requirement-harness/README.md`, `scripts/generate-requirement-harness.ts`, `spec/metamodel/requirement.json` (all TypeScript paths are under `server/typescript/packages/`). The Python, Java and C# requirement classes, `verify` entry points and generator registries were read by outline and targeted search.

**Executed:** one throwaway script that computed the witness keys of Table F and the two digests of Tables G and H; the first digest was confirmed a second way, by piping the text of Table G into `sha256sum`. **Not executed:** any test suite, any generator, any port's `verify`. No corpus case below has been loaded by a loader yet; Task 2 and Task 4 are the first things that do.

Things marked UNVERIFIED are collected in [Unverified items](#unverified-items). The first step of the task that touches one is to read the code and confirm or correct it.

What the code does that the documents do not say. Each row changes a task below:

| The documents say | What the code does |
|---|---|
| The requirement checks are "TypeScript only, by decision" (`docs/CONFORMANCE.md`, `docs/features/requirements.md:6-7`, pillar 5 in `CLAUDE.md` and `AGENTS.md`) | True, and no ADR records the decision. Reversing it needs a new ADR, not an amendment (Task 1). |
| All five ports "load and validate" requirements | True, but only TypeScript's `MetaRequirement` has `supersededBy()` and `isRetired()`. Python (`meta/core/requirement/meta_requirement.py`), Java (`requirement/MetaRequirement.java`) and C# (`Meta/MetaRequirement.cs`) lack both. |
| The gate and the generator address a requirement the same way | Two walks exist. `collectAddressedRequirements` (`requirement-check.ts:199`) descends through every node; `walkRequirements` (`requirement-walk.ts:66`) starts at root children and descends through requirements only. A TypeScript test pins that their path sets agree. Each new port implements one walk, the gate's. |
| A generated test's name is the link to its requirement | The TypeScript name is `<path> [<concern>]` and the file is `requirements/<path>.<concern>.test.ts`. Neither carries the package, so two packages with the same path collide. The new ports include the package; TypeScript keeps its bytes (Table F). |
| `ERR_REQUIREMENT_LINK_ABOVE_FLOOR` is one check among several | It ends the checks for that requirement (`continue` at `requirement-check.ts:466`): no reference, `supersededBy`, universality, disposition, existence or deferral check runs for that node. |
| Coverage activates "on adopter-authored requirements" | The test is the requirement's effective package against `libraryPackages()` (`metadata/src/library/library-sources.ts:136`). Every port embeds the library manifests, and none but TypeScript exposes that set. |
| The harness stub renderers are per-language templates | They are (`scripts/generate-requirement-harness.ts:128-181`), and every slot is skipped. They emit JUnit Jupiter, while this repository's own Java tests are JUnit 4.13.2. |
| Python generators take options | `metaobjects.config.yaml` accepts `metadata`, `providers`, `libraries` and `targets.<name>.{outDir,generators,entities}` only (`codegen/project_config.py`). There is no per-generator option surface. |

## Global Constraints

- **No new vocabulary.** Nothing is registered. `metamodelVersion` stays `1.1`; `fixtures/registry-conformance/expected-registry.json` is not touched. No loader pass is added in any port.
- **TypeScript is the reference.** Both corpora's `expected.json` files are produced from the TypeScript implementation, reviewed against Tables C to G, and committed. A port that disagrees with a committed expectation is wrong unless the TypeScript reference is shown to be wrong first.
- **The gate-code table is copied, not re-derived.** Table C's codes, conditions, order and message text come from `requirement-check.ts`. A port reads that file before writing its checks (design judgment: study the reference implementation).
- **A model with no `requirement.*` node sees no change in any port:** no line printed, no exit-code change, no file generated.
- **Generated tests import nothing from MetaObjects.** Python output imports `importlib` and `pytest` only and parses under the Python 3.9 grammar. JVM output imports JUnit only. C# output imports xUnit only.
- **The generated test file is fully machine-owned** in Python, Java, Kotlin and C#. No three-way merge is ported. Project code lives in witness functions.
- **Witness addresses include the package** (Table F).
- **The Python interpreter floor stays 3.11.** The plan documents how to select the interpreter; it does not lower `requires-python`.
- **`verify` never reads test results.** The generator emits one test per requirement, the drift gate proves the set matches the ledger, an unfilled live test fails, and the project's own test run supplies "passing".
- **Bind at build time, never by runtime reflection** in JVM and .NET generated code (ADR-0001). Python's witness lookup is a by-name import in test code and is the one exception, stated in Table H.
- ADR-0039: read effective properties with resolving accessors. Any `own*()` call carries a comment naming its sanctioned case. Python `attr()` is OWN; use `get_meta_attr()`.
- TS: named constants for metamodel strings, no `any`, never `instanceof` a node from another package.
- The requirement-test generator is a **reference helper** (ADR-0034 Amendment 3), and a **recommended approach, not a contract**: it is ejectable in every port (Table L) and an application may change its copy freely. The requirement gate is **core** (`meta verify` is a drift gate) and stays stock.
- Public repo: no private project names, no absolute home paths, in code, fixtures, docs or commit messages.
- **Release hold continues:** `main` carries `metamodelVersion 1.1`, so no 1.0.x PATCH is cut from it. This slice adds no vocabulary and can ship with 1.1.
- Do not push implementation work until every port in the task's track is green.

## Review Focus

1. **Author prose that breaks a string or a comment.** A statement or counterexample containing `"`, `\`, a newline, `*/`, `"""` or (Kotlin) `$`. A reasonable person expects the generated file to parse and the test to carry the sentence. Each port's generator test has an escaping case (Tasks 6, 8, 10, 11), modelled on `codegen-ts/test/requirement-test-escaping.test.ts`.
2. **A witness module that exists but does not import.** A person expects the real import error, not "unimplemented requirement" on every test. Python's lookup treats only "the witness module itself is absent" as no witness (Table H; Task 6 test `a broken witness module raises its own error`).
3. **Two requirements whose witness keys collide** (`Orders.Recorded` beside `Orders_Recorded`, or two non-ASCII names). A person expects a refusal naming both, never a silently dropped test. (Table F; identity corpus case `witness-key-collision`; each generator test.)
4. **A project whose only requirements come from a library.** A person who opted into `iam` and wrote no requirement expects no coverage gate. A port that reads this wrong reports every entity. (Table D; check corpus cases `coverage-library-only-not-measured` and `coverage-library-overlay-does-not-activate`.)
5. **A package that loses its last requirement.** Its generated test file is now stale. A person expects `verify --codegen` to say so, and `gen` to remove or refuse it rather than leave a green file for claims that no longer exist. (Tasks 6, 8, 10, 11, step "stale file"; the per-port behaviour is UNVERIFIED.)

---

## Contract tables (what the ports copy)

### Table A — the walk and the address

| Term | Definition |
|---|---|
| Walk | Depth-first over the loaded root's children, in declaration order, descending through **every** node. A node of type `requirement` is collected. |
| Path | The dotted chain of requirement names from the root to the node. Only a requirement contributes a segment; a non-requirement node between two requirements is walked through and adds nothing. No package. Example: `Shop.Orders.Recorded`. |
| Effective package | `node.package`, else the file's default package (`fileDefaultPackage`), else `""`. Read on the requirement node itself. |
| Qualified address | `<effective package>::<path>`, or the bare path when the package is `""`. Example: `acme::shop::Shop.Orders.Recorded`. |

Diagnostics use the **path**. Test identities use the **qualified address**.

### Table B — claim resolution

One resolver per port, shared by the gate and the generator.

| Step | Rule |
|---|---|
| Split | `splitMemberRef(ref)`: the owner ends at the first `.` after the last `::`. `acme::sales::Order.total.display` gives owner `acme::sales::Order`, member path `[total, display]`. |
| Owner, objects first | The port's existing ADR-0042 object resolver, with the requirement's effective package as referrer: TypeScript `resolveObjectRef`, Python `naming_refs.resolve_object_ref`, C# `NamingRefs.ResolveObjectRef`, Java `validation.SymbolTable.resolveObject` (built with `SymbolTable.build(root)`). Never a second name scan. |
| Owner, other root nodes | When no object matches: root-level nodes whose type is neither `object` nor `requirement` (a `template.prompt`, for example). A fully-qualified reference matches the resolution key exactly. A bare reference matches `<referrer package>::<ref>` when exactly one node has that key; otherwise an unpackaged root node whose name and resolution key both equal the reference, when exactly one exists. Ambiguous binds nothing. |
| Member | Each further segment is a child **name** of the node reached so far, to full depth. |
| `supersededBy` | Resolves against the **ledger**, not the model. Build a map from `<effective package>::<path>` to requirement for every packaged requirement, and from the bare `<path>` (first one wins). Look up the reference exactly; if absent and the referrer package is non-empty, look up `<referrer package>::<ref>`. |

### Table C — the gate codes

Source: `server/typescript/packages/cli/src/lib/requirement-check.ts`. Eleven codes; `ERR_REQUIREMENT_DANGLING_REF` has two conditions. Rows 1 to 11 are evaluated per requirement in walk order, **in this row order**. Row 12 runs once, after every requirement.

`<level>` is the decimal integer. "Levelled" means `level` is present. "Live" means status `live` or `partial`. `mayReferenceModel()` is true for an unlevelled architectural requirement, false for an unlevelled functional one, and `level >= 4` otherwise.

| # | Code | Severity | Condition | Message |
|---|---|---|---|---|
| 1 | `ERR_REQUIREMENT_BAD_LEVEL` | error | (functional or levelled) and the level is absent, not an integer, below 1 or above 5 | `level must be an integer 1-5 (got <level>). L1 solution, L2 segment (app/library), L3 service, L4 object, L5 member.` On an architectural requirement, append ` On an architectural requirement the level is optional — omit it for a flat policy.` |
| 2 | `ERR_REQUIREMENT_LEVEL_NESTING` | error | (functional or levelled), the parent node is a requirement with a level, and `level <= parent level` | `nested under "<parent name>" (level <parent level>) but declares level <level>. Nesting is the hierarchy — a child sits strictly below its parent.` |
| 3 | `ERR_REQUIREMENT_LINK_ABOVE_FLOOR` | error | `implementedBy` is non-empty and `mayReferenceModel()` is false | `'implementedBy' is legal at L4 (object) and L5 (member) only. L1-L3 are organisational and never reference the model — move the links to a nested L4 child.` **Rows 4 to 11 are then skipped for this requirement.** |
| 4 | `ERR_REQUIREMENT_L4_NOT_OBJECT` | error | per reference: functional, level 4, and the reference has a member path | `L4 references an object; '<ref>' names a member. Move it to a nested L5 child, or reference the object itself.` Row 6 is skipped for this reference. |
| 5 | `ERR_REQUIREMENT_L5_NOT_MEMBER` | error | per reference: functional, level 5, and the reference has no member path | `L5 references a member (field, view or identity); '<ref>' names an object. Move it to its L4 parent.` Row 6 is skipped for this reference. |
| 6 | `ERR_REQUIREMENT_DANGLING_REF` | error | per reference: it does not resolve (Table B) and the requirement is live | `'<ref>' does not resolve in the loaded model (status '<status>' — the model moved and the requirement is stale).` then a hint. Owner unresolved: the port's did-you-mean hint for the owner (may be empty). Owner resolved, member gone: ` '<owner resolution key and the member segments that did resolve, dot-joined>' has no member '<first segment that did not>'.` |
| 7 | `ERR_REQUIREMENT_DANGLING_REF` | error | `supersededBy` is present, not blank, and does not resolve (Table B) | ``@supersededBy '<ref>' does not name a requirement in the loaded ledger. It must name the requirement that REPLACED this one — if nothing did, drop the attribute and let `notes` carry why the capability went.`` |
| 8 | `ERR_REQUIREMENT_ARCH_NO_IMPLEMENTERS` | error | architectural, live, `implementedBy` empty, and `mayReferenceModel()` true | `architectural requirement is '<status>' but nothing implements it. Its check is universality — a claim set of zero means the policy is declared and unapplied.` |
| 9 | `WARN_REQUIREMENT_DISPOSITION_NOT_APPLICABLE` | warn | `disposition` is present and the status is neither `planned` nor `partial` | `carries @disposition '<disposition>' but its status is '<status>', which has no outstanding work to decide about. A disposition is meaningful on 'planned' and 'partial' only — on any other status the decision IS the status.` |
| 10 | `WARN_REQUIREMENT_NOTHING_IMPLEMENTS` | warn, or **error under the strict switch** (Table I) | functional, live, and neither it nor any requirement nested under it at any depth has a non-empty `implementedBy` | `is '<status>' but neither it nor anything nested under it names an implementing node. A functional requirement's check is existence — a subtree that claims nothing is a capability nobody built.` |
| 11 | `WARN_REQUIREMENT_DEFERRED_UNTRACKED` | warn | `disposition` is `deferred` and `trackedBy` is empty | `is deferred but names no @trackedBy issue. Deferring without a ticket is how a known gap becomes an unknown one — nothing will raise it again.` |
| 12 | `WARN_REQUIREMENT_OBJECT_UNCLAIMED` | warn (the `OBJECT_COVERAGE_SEVERITY` constant; each port keeps a named constant) | coverage is measured (Table D) and a coverable entity's resolution key is not in the claim set. **No path.** | `no requirement claims '<entity resolution key>'. Add it to an L4 requirement's 'implementedBy'.` |

Reachability, from `spec/metamodel/requirement.json`: `level` is required on functional and is an integer with no range rule, so row 1 is reached with an out-of-range integer and never with an absent level on a functional node. `status` is required on both subtypes. The loader refuses `implementedBy` on `retired`.

A printed line is `  <code> [<path>]: <message>`, or `  <code>: <message>` when there is no path (`formatDiagnostic`, `cli/src/commands/verify.ts:1899`).

### Table D — claim sets, `extends` propagation and coverage activation

| Rule | Definition |
|---|---|
| Who contributes | Every requirement whose status is not `planned`. A planned requirement never counts toward coverage. |
| What a claim adds | For each reference whose owner resolves, and whose member path resolves when it has one: the **owner's** resolution key. An unresolvable reference adds nothing. |
| Propagation along `extends` | An **architectural** claim also adds every root-level object whose resolved super chain reaches the owner, at any depth. Walk the resolved super pointer (TypeScript `superData`, Java `getSuperData()`, C# `SuperData`), with a visited set, never the raw `extends` string. A **functional** claim does not propagate. |
| Coverable entities | Root-level `object.entity` nodes that are not abstract. `object.value` and `object.projection` are exempt. Where the port consumes dependencies (TypeScript and Python), also filtered by the project's scope predicate (`collection.inScope`, Python `in_scope`). |
| When coverage is measured | When at least one collected requirement's effective package is **not** in the library package set: the union of `packages` across the embedded library manifests (`metaobjects::iam`, `metaobjects::ai` today). A project that authored no requirement is not measured, even with a library loaded. An overlay on a library requirement stays in the library's package and does not activate coverage. A caller may force the answer (TypeScript's standalone-library gate does). |
| No requirements | The check returns no diagnostics and the summary is absent. |

### Table E — summary counts and what `verify` prints

Counts (`summariseRequirements`): `total`, `functional`, `architectural`, `byStatus`, `undecided`, `deferredUntracked`, and `entitiesClaimed` with `entitiesTotal` **only when coverage is measured**.

- `undecided` counts a requirement with outstanding work (status `planned` or `partial`), no `disposition`, whose path is **not** a proper prefix of the path of another requirement with outstanding work. Every ancestor of such a node is excluded, whether or not the descendant has a disposition.
- `deferredUntracked` counts `disposition: deferred` with empty `trackedBy`.

The gate runs on **every** `verify`, with no subverb. Lines, with the port's own command prefix in place of `meta verify`:

| When | Line |
|---|---|
| At least one requirement | `meta verify — requirements: <total> entries (<functional> functional, <architectural> architectural) — <n> <status>, …; ` followed by `coverage: not measured (no project-authored requirements).` or `<claimed>/<total> entities claimed, counted over <files> metadata file(s).` Statuses appear in the order `planned, live, partial, retired`, zero counts omitted. TypeScript and Python end the second form with `, <n> from dependencies.` when the project declares dependencies. |
| `undecided > 0` | `meta verify — requirements: <undecided> recorded gap(s) with no @disposition. These are known problems nobody has ruled on — set 'accepted' or 'deferred' to close the question.` |
| Each error | The diagnostic line, never capped. |
| Each warning | The diagnostic line. TypeScript caps at `--limit` (default 20, `cli/src/lib/advisory.ts`). The other ports have no `--limit` and print every gate warning, as their field lint does. |
| Any error | `meta verify — requirements: <n> error(s).` and a non-zero exit. |

Prefixes: Python `metaobjects verify —`, Java and Kotlin `metaobjects:verify —` (both as the field lint prints them). C#: **UNVERIFIED**, copy the prefix `FieldLint.RunAdvisory` uses. The structured `--format` payload stays TypeScript-only.

### Table F — the test identity

One record per generated test. This is what the identity corpus pins, and it is the same in five ports.

| Field | Definition |
|---|---|
| `package` | The requirement's effective package (Table A). |
| `path` | The requirement's path (Table A). |
| `unit` | Under `grain: concern` (default): one test per **distinct** `<type>.<subType>` among the requirement's resolved targets, first-seen order. Under `grain: member`: one test per **distinct** `implementedBy` entry that resolves, the reference exactly as authored. In both grains a requirement with no resolved target yields exactly one test with unit `*`. |
| `id` | `<qualified address> [<unit>]`. |
| `witnessKey` | `req_` + mangle(qualified address), then `__` + mangle(unit) unless the unit is `*`. mangle replaces each maximal run of characters outside `[A-Za-z0-9]` with one `_`. |
| `status` | The requirement's status. |
| `skip` | `null` when the status is `live` or `partial`; otherwise the status (`planned` or `retired`). Derived from the status lists, never a literal set. |
| `digest` | Table G. |

Which requirements get a test: the default filter is **functional and `level >= 4`**. Every port lets a project replace it with its own predicate over the requirement view (Table I). Requirements the filter excludes produce one warning, capped at five names, with the text of `requirement-tests.ts:179-183`; every port can switch that warning off.

Two records with the same `witnessKey` are a **collision**. Every generator outside TypeScript refuses to generate, with code `ERR_REQUIREMENT_WITNESS_KEY_COLLISION` and a message naming both `id` values. TypeScript's generator does not use the key in its output and does not refuse.

Worked example (executed). Requirement `Orders.Recorded` in package `acme::shop`, claiming entity `Order`:

| unit | `id` | `witnessKey` |
|---|---|---|
| `object.entity` | `acme::shop::Orders.Recorded [object.entity]` | `req_acme_shop_Orders_Recorded__object_entity` |
| `Order.total` (member grain) | `acme::shop::Orders.Recorded [Order.total]` | `req_acme_shop_Orders_Recorded__Order_total` |
| `*` | `acme::shop::Orders.Recorded [*]` | `req_acme_shop_Orders_Recorded` |

**TypeScript keeps its emitted bytes.** Its test name stays `<path> [<concern>]` and its file stays `requirements/<path>.<concern>.test.ts`. It gains a function that returns these records, for the corpus and for its renderer hook.

### Table G — the requirement digest

`requirement-digest/v1`. Lowercase hex SHA-256 of the UTF-8 bytes of this text:

```text
requirement-digest/v1\n
subType <n>\n<value>\n
level <n>\n<value>\n
status <n>\n<value>\n
statement <n>\n<value>\n
counterexample <n>\n<value>\n
implementedBy <count>\n
ref <n>\n<value>\n          (one per implementedBy entry, authored order)
```

- `<n>` is the byte length of the value's UTF-8 encoding. `<count>` is the number of entries.
- `level` is the decimal integer, or the empty string when absent.
- Every value is the **effective** value (resolving accessor), so a requirement that inherits its statement through `extends` hashes what it effectively says.
- In `statement` and `counterexample`, `\r\n` and a lone `\r` become `\n` before measuring.
- Not in the digest: `title`, `description`, `notes`, `disposition`, `trackedBy`, `supersededBy`, the name, the package and nested requirements. The digest answers "did the claim change", not "did the entry move".

Worked example (executed): functional, level `4`, status `live`, statement `An order is recorded when it is placed.`, counterexample `A placed order has no row.`, one reference `Order`. The hashed text is

```text
requirement-digest/v1\nsubType 10\nfunctional\nlevel 1\n4\nstatus 4\nlive\nstatement 39\nAn order is recorded when it is placed.\ncounterexample 26\nA placed order has no row.\nimplementedBy 1\nref 5\nOrder\n
```

and the digest is `2714aa3925a47959aa5e48ae39d80ed203fd4e2caa046a90aab9e04691d9881a`.

### Table H — what each port generates, and the witness model

TypeScript is unchanged: one stub file per test, hand-filled, kept by the three-way merge. The four other ports emit **one file per metamodel package**, rewritten whole on every run. `<pkgKey>` is mangle(package), or `root` when the package is `""`.

| Port | Files (relative to the generator's output directory) | A live or partial test | A skipped test | Project-owned witness |
|---|---|---|---|---|
| Python | `requirements/test_<pkgKey>_requirements.py` | Looks up `<witnessKey>` in the configured witness module and calls it with no arguments. No such function, or no such module: `pytest.fail` with the message below. | `@pytest.mark.skip(reason=…)` and never looks a witness up | A function named `<witnessKey>` in the witness module (default `tests.requirement_witnesses`) |
| Java | `Requirements_<pkgKey>_Witnesses.java` (an interface) and `Requirements_<pkgKey>_Test.java`, in the configured test package | Calls `witnesses.<witnessKey>()`. The interface's default method throws `AssertionError` with the message below. | `@Test @Disabled("…")` with an empty body; no interface member | A class named in config that implements every generated `…_Witnesses` interface and overrides the members it has witnesses for |
| Kotlin | `Requirements_<pkgKey>_Witnesses.kt` and `Requirements_<pkgKey>_Test.kt` | As Java | As Java | As Java |
| C# | `Requirements_<pkgKey>_Witnesses.g.cs` (an interface with default members) and `Requirements_<pkgKey>_Tests.g.cs` | Calls the member through the interface type. The default member throws `Xunit.Sdk.XunitException` with the message below (**UNVERIFIED** that this constructor is public in xUnit 2.9.2). | `[Fact(Skip = "…")]` | As Java |

Failure message when there is no witness (one line, values escaped for the language):

```text
unimplemented requirement: <id> - write <where>.<witnessKey>() so that it fails when: <counterexample>
```

Skip reasons: `planned - not built yet` and `retired - the capability was deliberately removed; assert it stays removed`.

Rules the four generators share:

- Every author-supplied value is escaped wherever it lands. In a string literal: `\`, `"`, newline and carriage return; `$` as well in Kotlin. In a comment: one comment marker per line, and `*/` broken as `* /`. Prose is never placed in a Python docstring.
- Above each test, as comments: the `id`, the statement, `Counterexample:`, `Status:`, `Claims:` (each target as `<ref>  (<type>.<subType>)`, or `(none)`), and `Digest:`. The digest in the file is what makes `verify --codegen` go red when a claim changes.
- Tests are emitted sorted by `id`. Output is deterministic.
- The file header says it is generated and rewritten whole, and names the witness module or class.
- A JVM or .NET witness interface lists **only** non-skipped tests. A requirement that becomes live adds a failing default member (a red test, no compile break). A requirement that is retired or deleted removes the member, so a stale override stops compiling. That is the drift signal for orphan witnesses.
- The generated JVM and .NET test constructs the configured witness class with `new`. If that class does not exist the test module does not compile: a one-time setup, documented in Task 12, and the only by-name binding is a static one (ADR-0001).

The reference Python output for the worked example (the shape Task 6 emits; the other three follow the same structure in their syntax, and `scripts/generate-requirement-harness.ts:128-181` holds each language's skip annotation and class frame):

```python
# @generated by metaobjects (requirement-tests). DO NOT EDIT: this file is rewritten whole.
# Witnesses are project-owned functions in the module named below.
import importlib

import pytest

_WITNESS_MODULE = "tests.requirement_witnesses"


def _witness(key):
    try:
        module = importlib.import_module(_WITNESS_MODULE)
    except ModuleNotFoundError as exc:
        missing = exc.name or ""
        if _WITNESS_MODULE != missing and not _WITNESS_MODULE.startswith(missing + "."):
            raise
        return None
    return getattr(module, key, None)


def _run(key, test_id, counterexample):
    witness = _witness(key)
    if witness is None:
        pytest.fail(
            "unimplemented requirement: " + test_id + " - write " + _WITNESS_MODULE + "." + key
            + "() so that it fails when: " + counterexample
        )
    witness()


# acme::shop::Orders.Recorded [object.entity]
# An order is recorded when it is placed.
# Counterexample: A placed order has no row.
# Status: live
# Claims: Order  (object.entity)
# Digest: 2714aa3925a47959aa5e48ae39d80ed203fd4e2caa046a90aab9e04691d9881a
def test_req_acme_shop_Orders_Recorded__object_entity():
    _run(
        "req_acme_shop_Orders_Recorded__object_entity",
        "acme::shop::Orders.Recorded [object.entity]",
        "A placed order has no row.",
    )


# acme::shop::Orders.Refunded [*]
# A refund is recorded against its order.
# Counterexample: A refund with no order.
# Status: planned
# Claims: (none)
# Digest: 4ddcd781ccc2fe462bc316711d5cedb88b803af1727a0df19fe3a69487aa6f86
@pytest.mark.skip(reason="planned - not built yet")
def test_req_acme_shop_Orders_Refunded():
    pass
```

### Table I — the three seams, per port

| Seam | TypeScript | Python | Java and Kotlin | C# |
|---|---|---|---|---|
| Grain (`concern` default, or `member`) | `requirementTests({ grain })` | `requirement_tests(grain=…)`; config `requirementTests.grain` | generator arg `grain` | **UNVERIFIED** option surface; a property on the generator |
| Renderer hook. Receives the Table F record plus `statement`, `counterexample`, `targets` (`ref`, `concern`), `disposition`, `trackedBy`. Its result replaces the default text of that one test. | existing `renderers` and `resolveRenderer`; `RequirementTestArgs` gains `package`, `unit`, `id`, `witnessKey`, `skip`, `digest` | `requirement_tests(renderer=…)`; config `requirementTests.renderer` as `module:symbol`. Returns `RenderedTest(imports, source)` or `None` for the default | generator arg `renderer`: the class name of a `RequirementTestRenderer` | as Java, an `IRequirementTestRenderer` |
| Strict switch: row 10 of Table C becomes severity `error`, code unchanged | `meta verify --require-implementers`, or `META_REQUIRE_IMPLEMENTERS=1` | `metaobjects verify --require-implementers`, same variable | `-Dmeta.verify.requireImplementers=true`, same variable | `dotnet meta verify --require-implementers`, same variable |
| Witness location | not applicable | `requirement_tests(witness_module=…)`; config `requirementTests.witnessModule` | generator args `testPackage` and `witnessClass` | the same two, C# names |
| Filter: a predicate over the requirement view. Absent, the default of Table F applies. | `requirementTests({ filter })` | `requirement_tests(filter=…)`; config `requirementTests.filter` as `module:symbol` | generator arg `filter`: the class name of a `RequirementTestFilter` (`boolean include(RequirementView view)`), loaded the way the renderer is | as Java, an `IRequirementTestFilter` (`bool Include(RequirementView view)`) |
| Uncovered warning: name the requirements the filter excluded (Table F). Default on. | `requirementTests({ warnUncovered })` | `requirement_tests(warn_uncovered=…)`; config `requirementTests.warnUncovered` | generator arg `warnUncovered` (`true` or `false`) | as Java |

**The filter is uniform (owner's answer 8).** Every port offers the same two options, and every port's predicate receives the same projection, the **requirement view**: `subType`, `level` (absent on an unlevelled architectural requirement), `status`, `path`, `package` (the effective package) and `implementedByTypes` (the distinct `<type>.<subType>` of the resolved targets, first-seen order). The view never hands out the node. A port that cannot express one of the two options is wrong; the identity corpus's `filter-*` cases (Table J) run each port's predicate seam.

The flag is not called `--strict`: `cli/src/lib/args.ts:357` records why a `--strict` beside `--lax` misreads.

### Table J — the two corpora

Both follow the field-lint corpus shape: each case is a directory with `input/` (one or more `.json` or `.yaml` metadata documents), an optional `options.json`, and `expected.json`. A runner (1) loads `input/` with the port's loader, **strict**, with the libraries `options.json` names, and asserts no load error; (2) computes; (3) compares.

**`fixtures/requirement-check-conformance/`**. `options.json` keys: `libraries` (string array), `requireImplementers` (boolean). `expected.json`:

```json
{
  "diagnostics": [
    { "severity": "error", "code": "ERR_REQUIREMENT_DANGLING_REF", "path": "Shop.Orders.Recorded",
      "message": "'Ordr' does not resolve in the loaded model (status 'live' — the model moved and the requirement is stale)." }
  ],
  "summary": { "total": 3, "functional": 3, "architectural": 0, "byStatus": { "live": 3 },
               "undecided": 0, "deferredUntracked": 0, "entitiesClaimed": 0, "entitiesTotal": 1 }
}
```

`diagnostics` is compared as an unordered multiset of `(severity, code, path, message)`; `path` is absent on row 12. `summary` is `null` for a model with no requirement, and has no `entities*` keys when coverage is not measured.

| Case | Pins |
|---|---|
| `no-requirements` | Entities only: no diagnostics, `summary: null` |
| `clean-fully-claimed` | An L1 to L5 tree claiming every entity: no diagnostics, full summary |
| `dangling-object-live`, `dangling-object-partial` | Row 6 for each live status |
| `dangling-object-planned-clean` | A planned requirement may name nodes that do not exist |
| `dangling-object-did-you-mean` | Row 6's hint when the short name exists in another package |
| `dangling-bare-name-in-two-packages` | A bare name present in two other packages binds nothing |
| `dangling-member-of-resolved-object`, `dangling-member-first-missing-segment` | Row 6's member hint, at one and two levels |
| `claim-on-root-template` | A reference to a root-level `template.prompt` resolves |
| `claim-package-local` | A bare reference binds in the requirement's own package across two files |
| `link-above-floor` | Row 3, and that a `disposition` on the same live node produces no row 9 |
| `l4-names-member`, `l5-names-object`, `l5-member-resolves-clean` | Rows 4 and 5 |
| `bad-level-out-of-range`, `level-nesting` | Rows 1 and 2 on functional nodes |
| `arch-live-no-implementers`, `arch-planned-clean`, `arch-retired-clean` | Row 8 and its two exemptions |
| `arch-levelled-tree` | A levelled architectural L1 with links gets row 3; one without gets no row 8; a child that re-ascends gets row 2; a level of 7 gets row 1 with the architectural suffix |
| `arch-unlevelled-exempt`, `arch-mixed-grain-clean` | A flat policy is exempt from rows 1 and 2; an architectural L4 may name a member |
| `disposition-not-applicable`, `deferred-untracked` | Rows 9 and 11, with a tracked deferral beside the untracked one |
| `nothing-implements-subtree`, `nothing-implements-delegating-parent-clean` | Row 10 on every live node of an empty subtree, and not on a parent whose child claims |
| `require-implementers` | Same input as `nothing-implements-subtree` with the strict option: severity `error`, same code |
| `superseded-by-resolves-clean`, `superseded-by-dangling`, `superseded-by-package-local` | Row 7 and Table B's ledger lookup |
| `retired-clean` | A retired entry reports nothing and claims nothing |
| `same-name-in-two-branches` | Two requirements with one name are told apart by path |
| `coverage-unclaimed-entity` | Row 12, no path |
| `coverage-planned-claim-does-not-count` | Table D, first row |
| `coverage-arch-claim-propagates` | An architectural claim on an abstract base covers a subtype and a subtype of that subtype |
| `coverage-functional-claim-does-not-propagate` | The same shape with a functional claim leaves the subtypes unclaimed |
| `coverage-exemptions` | An abstract entity, a value and a projection are not counted |
| `coverage-library-only-not-measured` | `libraries: ["iam"]`, no project requirement: no row 12, no `entities*` keys |
| `coverage-library-plus-project` | One project requirement switches coverage on |
| `coverage-library-overlay-does-not-activate` | An overlay on a library requirement does not |
| `summary-undecided-rollup` | A partial parent over a partial child counts once, at the child; a grandchild excludes both ancestors |

**`fixtures/requirement-test-identity-conformance/`**. `options.json` keys: `grain`, and `filter`, the **name** of one predicate from the closed list below. A predicate cannot be written in a language-neutral file, so the corpus names it and each port's runner implements the list in its own language and passes the predicate through the port's public filter seam. That is what makes the seam, and every field of the view it receives, a five-port contract. With no `filter` key the port's default applies.

| `filter` | The predicate over the requirement view |
|---|---|
| `all` | always true |
| `architectural` | `subType` is `architectural` |
| `live` | `status` is `live` |
| `level-5` | `level` is `5` |
| `package-acme-shop` | `package` is `acme::shop` |
| `path-under-Shop` | `path` is `Shop` or starts with `Shop.` |
| `claims-entity` | `implementedByTypes` contains `object.entity` |

`expected.json`:

```json
{ "tests": [ { "id": "acme::shop::Orders.Recorded [object.entity]", "package": "acme::shop",
               "path": "Orders.Recorded", "unit": "object.entity",
               "witnessKey": "req_acme_shop_Orders_Recorded__object_entity",
               "status": "live", "skip": null,
               "digest": "2714aa3925a47959aa5e48ae39d80ed203fd4e2caa046a90aab9e04691d9881a" } ],
  "collisions": [] }
```

`tests` is compared after sorting both sides by `id`. `collisions` is a list of `[id, id]` pairs, each pair and the list sorted.

| Case | Pins |
|---|---|
| `default-filter` | L1 to L3 and architectural nodes get no test; functional L4 and L5 do |
| `worked-example` | The model of Tables F, G and H exactly: `Orders.Recorded` (functional, level 4, live, claiming `Order`) and `Orders.Refunded` (functional, level 4, planned, no links) in `acme::shop`. Both digests are the pinned ones. Every port's generator test renders this case |
| `concern-fanout` | One requirement claiming two entities and a template yields two tests |
| `no-targets` | A live L4 with no `implementedBy` yields one test, unit `*` |
| `planned-skip`, `retired-skip`, `partial-not-skipped` | `skip` per status; a planned requirement naming absent nodes has unit `*` |
| `member-grain`, `member-grain-unresolved-dropped`, `member-grain-duplicate-ref` | One test per distinct resolving reference, bare and qualified forms kept as authored |
| `package-in-address` | The same path in two packages gives two ids and two keys |
| `unpackaged` | An empty package gives a bare address |
| `nested-path` | A five-deep path |
| `digest-claim-fields` | Two requirements differing in statement differ in digest; two differing only in `title`, `notes`, `disposition` and `trackedBy` do not |
| `digest-inherited` | A requirement inheriting its statement through `extends` hashes the effective text |
| `digest-multibyte-and-crlf` | A non-ASCII statement and a `\r\n` in the counterexample |
| `witness-key-collision` | `Orders.Recorded` beside `Orders_Recorded`: one entry in `collisions` |
| `filter-all` | `filter: all` over an L1 to L5 tree with one architectural policy: every requirement gets a test, the L1 to L3 nodes with unit `*` |
| `filter-by-subtype` | `filter: architectural`: an unlevelled policy and a levelled one get tests, the functional nodes none. Pins `subType`, and that an absent `level` reaches the predicate as absent |
| `filter-by-status` | `filter: live`: a partial and a planned requirement are dropped. Pins `status` |
| `filter-by-level` | `filter: level-5`: only the L5 nodes. Pins `level` |
| `filter-by-package` | `filter: package-acme-shop` over two packages, one requirement taking its package from the file default. Pins `package` as the effective package |
| `filter-by-path` | `filter: path-under-Shop`: `Shop` and its descendants, not a sibling `Shopfront`. Pins `path` |
| `filter-by-claimed-concern` | `filter: claims-entity`: a requirement claiming an entity is kept, one claiming only a template or only an unresolvable name is dropped. Pins `implementedByTypes` as the resolved concerns |

### Table K — where the code lives in each port

The checks live in each port's **core library**, not its CLI, because the generator needs the same walk and resolver.

| Port | Checks and resolver | `verify` wiring | Generator | Registry entry |
|---|---|---|---|---|
| TypeScript | existing: `cli/src/lib/requirement-check.ts`, `metadata/src/core/requirement/resolve-claim.ts` | existing: `cli/src/commands/verify.ts` | existing: `codegen-ts/src/generators/requirement-tests.ts`, `requirement-walk.ts` | existing |
| Python (`server/python/src/metaobjects/`) | `meta/core/requirement/resolve_claim.py`, `requirement_check.py` | `cli.py` (`_cmd_verify`) | `codegen/requirement_walk.py`, `codegen/generators/requirement_tests_generator.py` | `codegen/generator_registry.py` |
| Java (`server/java/`) | `metadata/src/main/java/com/metaobjects/requirement/RequirementClaims.java`, `RequirementCheck.java`, `RequirementTestIdentities.java` | `maven-plugin/src/main/java/com/metaobjects/mojo/MetaDataVerifyMojo.java` | `codegen-spring/src/main/java/com/metaobjects/generator/` (the package the other ejectable Java generators live in) `JUnitRequirementTestsGenerator.java`; the hook types in `codegen-base/src/main/java/com/metaobjects/generator/requirement/` | `codegen-spring/src/main/java/com/metaobjects/generator/GeneratorRegistry.java` |
| Kotlin | Java's | Java's Maven goal | `codegen-kotlin/src/main/kotlin/com/metaobjects/generator/kotlin/KotlinRequirementTestsGenerator.kt` | `codegen-kotlin/.../GeneratorRegistry.kt` |
| C# (`server/csharp/`) | `MetaObjects/Core/Requirement/RequirementClaims.cs`, `RequirementCheck.cs`, `RequirementTestIdentities.cs` | `MetaObjects.Cli/Program.cs`, `VerifyCommand.cs` | `MetaObjects.Codegen/Generators/RequirementTestsGenerator.cs` | `MetaObjects.Codegen/GeneratorRegistry.cs` |

Each port also adds a library-package accessor beside its embedded manifests: Python `library_packages()` in `library/library_sources.py`, Java `LibrarySources.libraryPackages()`, C# `LibrarySources.LibraryPackages()`.

### Table L — eject: the application-owned copy

Every port already has an eject mechanism; this slice wires the new generator into each and adds nothing to the mechanisms themselves. One rule makes that enough: **in every port the default rendering lives in the generator's own source file**, because every port's eject copies exactly one file per generator. One eject therefore takes the generator and its renderer together.

| Port | What `eject` copies, and to where | What makes the generator ejectable | How the owned copy runs | The byte-identity test |
|---|---|---|---|---|
| TypeScript | `codegen-ts/src/reference/requirement-tests.ts` to `codegen/generators/requirement-tests.ts`. A new reference template holding the generator **and** the default stub renderer, importing only public exports of `@metaobjectsdev/codegen-ts` and `@metaobjectsdev/metadata` | `"requirement-tests"` in `REFERENCE_GENERATOR_NAMES` (`codegen-ts/src/reference-templates.ts`); the registry's `ejectable` flag is derived from it | the import swap in `metaobjects.config.ts` that `meta eject` prints | a `PAIRS["requirement-tests"]` entry in `codegen-ts/test/reference-byte-identical.test.ts`, over a model that has requirements, in both grains |
| Python | the module `codegen/generators/requirement_tests_generator.py`, whole, to `codegen/generators/requirement_tests_generator.py` | `source=` on the registry entry | `codegen.generators.requirement_tests_generator:<factory>` in `generators`. The factory named by `source=` takes the build context, so an owned copy still reads the `requirementTests` config block | in `tests/codegen/test_eject.py`: packaged and owned `gen` output compared byte for byte over the `worked-example` model with a `requirementTests` block set |
| Java | `JUnitRequirementTestsGenerator.java`, with its package line rewritten, to the project's `codegen/` module | `ejectPath(JUnitRequirementTestsGenerator.class)` on the `register(...)` line, an `<include>` in `codegen-spring/pom.xml`, the name in `EjectedGeneratorsCompileTest` | the `<classname>` swap `metaobjects:eject` prints | a round trip on the pattern of `maven-plugin`'s `EjectRoundTripTest` proof B: the unchanged ejected copy, compiled, emits the same bytes as the packaged class |
| Kotlin | `KotlinRequirementTestsGenerator.kt`, package line rewritten | `ejectResourcePath = ejectPath("KotlinRequirementTestsGenerator")`, an `<include>` in `codegen-kotlin/pom.xml`, the name in `ejectableSimpleNames` | the same `<classname>` swap | new in `codegen-kotlin`: the package-renamed copy is compiled with kotlin-compile-testing, run, and its output compared with the packaged generator's |
| C# | `Generators/RequirementTestsGenerator.cs`, namespace line rewritten, to `codegen/generators/` | `SourceFileName` on the registry entry and an `<EmbeddedResource>` item in `MetaObjects.Codegen.csproj` | the owned `codegen/Program.cs` lists `new RequirementTestsGenerator { … }` | on the pattern of `EjectedGeneratorCompileTests`: the rewritten copy compiled with Roslyn against the public API and compared file by file over the `worked-example` model (`meta.fitness.json` has no requirement, so the existing list alone would compare nothing) |

What stays in the package, and why: the walk, the claim resolver, the identity function, the digest and the hook types. They are what the corpora pin and what the gate shares; an owned generator imports them from the package like any other code. An application that wants different identities writes them in its own copy. That is its right, and its `verify --codegen` then compares its own output with itself.

The requirement checks are **not** ejectable in any port. They are the shared contract.

## File structure

**Shared, new:** `fixtures/requirement-check-conformance/` (a `README.md` and the 42 cases of Table J), `fixtures/requirement-test-identity-conformance/` (a `README.md` and 24 cases), `spec/decisions/ADR-0057-requirement-checks-and-tests-in-every-port.md`, `scripts/write-requirement-corpus-expected.ts`.

**Shared, modified:** `fixtures/generator-registry-conformance/registry.json` (the `requirement-tests` entry's `ports`, one port per generator task).

**TypeScript, modified** (under `server/typescript/packages/`): `cli/src/lib/requirement-check.ts`, `cli/src/lib/args.ts`, `cli/src/commands/verify.ts`, `codegen-ts/src/requirement-walk.ts`, `codegen-ts/src/generators/requirement-tests.ts`, `codegen-ts/src/templates/requirement-test.ts`, `codegen-ts/src/reference-templates.ts`. **New:** `codegen-ts/src/reference/requirement-tests.ts` (Table L). **New tests:** `cli/test/requirement-check-conformance.test.ts`, `codegen-ts/test/requirement-test-identity-conformance.test.ts`.

**Other ports:** Table K, and the test files named in Tasks 5 to 11.

**Docs and skills:** listed in Task 12.

## Task order and parallelism

| Task | Depends on | Can run in parallel with |
|---|---|---|
| 1 ADR-0057 and the TypeScript strict switch | none | 3 |
| 2 check corpus and its TypeScript runner | 1 | 3 |
| 3 TypeScript identity, digest, grain | none | 1, 2 |
| 4 identity corpus and its TypeScript runner | 3 | 2 |
| 5 Python checks in `verify` | 2 | 7, 3, 4 |
| 6 Python `requirement-tests` | 4, 5 | 7, 8 |
| 7 Java checks in `metaobjects:verify` | 2 | 5, 6 |
| 8 Java `requirement-tests` | 4, 7 | 5, 6 |
| 9 C# checks in `dotnet meta verify` | 2 | 11 |
| 10 C# `requirement-tests` | 4, 9 | 11 |
| 11 Kotlin `requirement-tests` | 8 | 9, 10 |
| 12 docs, skills, changelog, counts | 6, 8 | 9, 10, 11 (then a final pass after them) |
| 13 full CI, review, push | all | none |

Tasks 1 to 4 are the shared prerequisite. Python (5, 6) and Java (7, 8) come first, because both have adopters waiting; they are independent tracks. C# (9, 10) and Kotlin (11) follow. Kotlin has no checks task: its `verify` is the Java Maven goal.

Each port's two tasks can ship as one pull request per port. Tasks 1 to 4 ship together.

---

### Task 1: ADR-0057 and the TypeScript strict switch

**Files:**
- Create: `spec/decisions/ADR-0057-requirement-checks-and-tests-in-every-port.md`
- Modify: `spec/decisions/README.md` (the index), `server/typescript/packages/cli/src/lib/requirement-check.ts`, `cli/src/lib/args.ts`, `cli/src/commands/verify.ts`
- Test: `cli/test/unit/requirement-check.test.ts`, `cli/test/unit/args-verify.test.ts`, `cli/test/verify-requirements-e2e.test.ts`

**Interfaces:**
- Produces, in `requirement-check.ts`:

```ts
export function scanRequirements(
  root: MetaData,
  opts?: {
    coverable?: (fqn: string) => boolean;
    measureCoverage?: boolean;
    /** Raise WARN_REQUIREMENT_NOTHING_IMPLEMENTS to severity "error". Default false. */
    requireImplementers?: boolean;
  },
): RequirementScan;

export interface RequirementScan {
  // existing members unchanged
  readonly requireImplementers: boolean;
}
```

- [ ] **Step 1: Write the ADR** in Nygard format. Context: the decision recorded only in `docs/CONFORMANCE.md` "Split coverage" ("Checks — TypeScript only, by decision … one implementation of a build-time gate rather than five") and why it was made. Decision: the owner's ruling that every language runs the requirement checks and scaffolds tests from requirements; the gate is implemented per port and held to the TypeScript reference by `requirement-check-conformance`; the generator is implemented per port and held by `requirement-test-identity-conformance`; the witness model replaces the three-way merge outside TypeScript; the filter that selects which requirements get a test offers the same two options in every port (a predicate over one shared requirement view, and the uncovered-warning switch); the generator, its renderer and the witness model are a **recommended approach, not a contract**: the generator is ejectable in every port through that port's existing eject mechanism, and an application may change or replace its copy freely, while the checks in `verify` stay stock because they are the shared contract; `verify` still never reads test results. Consequences: a change to a gate code, a message, the identity or the digest is now a five-port change with a corpus edit; the analogy with ADR-0015 no longer applies to requirements and ADR-0015 itself is unchanged; the seven authoring-lint advisories stay TypeScript-only in this slice, by the owner's ruling, and porting them is a follow-up slice.
- [ ] **Step 2: Failing tests.** In `requirement-check.test.ts`: `requireImplementers raises nothing-implements to an error and keeps the code` (a live functional L4 with no links: default scan gives severity `warn`; `scanRequirements(root, { requireImplementers: true })` gives severity `error`, code `WARN_REQUIREMENT_NOTHING_IMPLEMENTS`, same path and message) and `requireImplementers changes no other diagnostic`. In `args-verify.test.ts`: `--require-implementers` parses to `requireImplementers: true`, default `false`. In `verify-requirements-e2e.test.ts`: the flag, and `META_REQUIRE_IMPLEMENTERS=1`, each turn a run with only that warning from exit 0 to exit 1.

Run: `cd server/typescript/packages/cli && bun test test/unit/requirement-check.test.ts test/unit/args-verify.test.ts test/verify-requirements-e2e.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.** `scanRequirements` sets `requireImplementers: opts?.requireImplementers ?? false`. In `checkRequirements`, the row 10 push uses `severity: scan.requireImplementers ? "error" : "warn"`. Add the boolean flag to the `verify` options in `args.ts` beside `no-requirement-lint`, with a doc comment that names why it is not `--strict`. In `verify.ts:683`, pass `requireImplementers: flags.requireImplementers || process.env.META_REQUIRE_IMPLEMENTERS === "1"`.
- [ ] **Step 4: Run** the same command, then `bun run --filter '*' typecheck` from the repository root. Expected: PASS. If `cli/test/__snapshots__/cli.test.ts.snap` holds the `verify` help text, update it and read the diff.
- [ ] **Step 5: Commit.** `git commit -m "feat(verify): --require-implementers, and ADR-0057 reversing TypeScript-only requirement checks"`

---

### Task 2: The requirement-check corpus and its TypeScript runner

**Files:**
- Create: `fixtures/requirement-check-conformance/README.md` and the 42 case directories of Table J
- Create: `scripts/write-requirement-corpus-expected.ts`
- Create: `server/typescript/packages/cli/test/requirement-check-conformance.test.ts`

**Interfaces:**
- Consumes: `scanRequirements`, `checkRequirements`, `summariseRequirements` (Task 1).
- Produces: the corpus format of Table J, which Tasks 5, 7 and 9 run.

- [ ] **Step 1: Read first.** `fixtures/field-lint-conformance/README.md`, `cli/test/field-lint-conformance.test.ts` (the runner to model this one on: how it finds the corpus, loads a case and compares), and the fixtures built inline in `cli/test/unit/requirement-check.test.ts` and `requirement-coverage-activation.test.ts`. Most cases of Table J are one of those inline fixtures moved to a file; reuse their shapes.
- [ ] **Step 2: Write the runner.** For every case directory: load `input/` strict with `options.json`'s `libraries`, assert zero load errors, call `scanRequirements(root, { requireImplementers })`, compare `checkRequirements(root, scan)` with `expected.diagnostics` as a sorted multiset of `(severity, code, path ?? "", message)`, and compare `summariseRequirements(root, scan) ?? null` with `expected.summary`. One more test asserts the case list on disk equals the list in the README, so a case cannot be added without being documented.
- [ ] **Step 3: Write the inputs.** One directory per row of Table J. Use YAML in the authoring form of `library/iam/requirements.yaml`. Keep each model minimal: the entities the case needs and the requirements under test. `coverage-library-*` cases set `options.json` `libraries`.
- [ ] **Step 4: Run the runner with no `expected.json`.** Run: `cd server/typescript/packages/cli && bun test test/requirement-check-conformance.test.ts`. Expected: FAIL, every case missing its expectation.
- [ ] **Step 5: Write the expectations script.** `scripts/write-requirement-corpus-expected.ts` takes a corpus name, loads each case the way the runner does and writes `expected.json`. It imports the reference by relative path, as `scripts/generate-requirement-harness.ts` does. Run `bun scripts/write-requirement-corpus-expected.ts check`.
- [ ] **Step 6: Review every written file by hand against Table C, D and E.** This is the step that makes the corpus a contract instead of a snapshot. For each case confirm the codes are the ones the row "Pins" names and no others; fix the **input** when a case produces more than it should. A disagreement between Table C and the reference is a finding to report, not something to paper over in the expectation.
- [ ] **Step 7: Write the README:** the two-line purpose, the format, the three runner steps, the case table, and a "Who asserts it" table (TypeScript now; the other rows are added by Tasks 5, 7 and 9).
- [ ] **Step 8: Run** the runner. Expected: PASS, 43 tests.
- [ ] **Step 9: Commit.** `git commit -m "test(conformance): requirement-check corpus, run by the TypeScript reference"`

---

### Task 3: TypeScript test identity, digest and grain

**Files:**
- Modify: `server/typescript/packages/codegen-ts/src/requirement-walk.ts`, `src/generators/requirement-tests.ts`, `src/templates/requirement-test.ts`
- Modify: the package's public exports (**UNVERIFIED** file; find where `walkRequirements` is exported and add the new names beside it)
- Create: `server/typescript/packages/codegen-ts/src/reference/requirement-tests.ts`; modify `src/reference-templates.ts` (Table L)
- Modify: `spec/decisions/ADR-0034-codegen-scaffold-and-own.md` (the 2026-09-26 correction lists `requirement-tests` among the generators that ship no reference template; record that it now ships one) and `docs/features/own-your-codegen.md` (the same list)
- Test: `codegen-ts/test/requirement-walk.test.ts`, `requirement-tests-generator.test.ts`, `requirement-test-render.test.ts`, `reference-byte-identical.test.ts`, `reference-templates.test.ts`, `cli/test/eject-multi.test.ts`

**Interfaces:**
- Produces, in `requirement-walk.ts`:

```ts
export type RequirementTestGrain = "concern" | "member";

export interface RequirementTestIdentity {
  readonly package: string;
  readonly path: string;
  readonly unit: string;
  readonly id: string;
  readonly witnessKey: string;
  readonly status: string | undefined;
  readonly skip: "planned" | "retired" | null;
  readonly digest: string;
}

/** Table F's default: functional and at or below the link floor. */
export function defaultRequirementTestFilter(r: RequirementView): boolean;
/** Table G. */
export function requirementDigest(node: MetaRequirement): string;
/** Table F. */
export function witnessKeyOf(qualifiedAddress: string, unit: string): string;
/** Every test the generator would emit, sorted by id. */
export function requirementTestIdentities(
  root: MetaData,
  opts?: { grain?: RequirementTestGrain; filter?: (r: RequirementView) => boolean },
): RequirementTestIdentity[];
/** Pairs of ids that share a witnessKey, each pair and the list sorted. */
export function witnessKeyCollisions(tests: readonly RequirementTestIdentity[]): [string, string][];
```

`RequirementView` gains `readonly package: string`. `RequirementTestArgs` gains `readonly package`, `unit`, `id`, `witnessKey`, `skip`, `digest`. `RequirementTestsOpts` gains `grain?: RequirementTestGrain`.

- [ ] **Step 1: Failing tests.** In `requirement-walk.test.ts`:

```ts
test("the digest of the worked example is pinned", () => {
  // functional, level 4, live, one ref "Order" — Table G
  expect(requirementDigest(recorded)).toBe(
    "2714aa3925a47959aa5e48ae39d80ed203fd4e2caa046a90aab9e04691d9881a",
  );
});

test("witness keys follow Table F", () => {
  expect(witnessKeyOf("acme::shop::Orders.Recorded", "object.entity"))
    .toBe("req_acme_shop_Orders_Recorded__object_entity");
  expect(witnessKeyOf("acme::shop::Orders.Recorded", "Order.total"))
    .toBe("req_acme_shop_Orders_Recorded__Order_total");
  expect(witnessKeyOf("acme::shop::Orders.Recorded", "*"))
    .toBe("req_acme_shop_Orders_Recorded");
});
```

Also: `the view carries the effective package`; `member grain yields one identity per distinct resolving reference`; `a requirement with no resolved target yields unit *` in both grains; `skip is derived from the status lists` (planned and retired skip, live and partial do not); `identities come back sorted by id`; `a filter replaces the default and its view carries the effective package` (a predicate keeping only `package === "acme::shop"` over two packages); `two addresses that mangle alike are reported as a collision`; `the digest ignores title, notes, disposition and trackedBy`; `the digest normalises CRLF`. In `requirement-tests-generator.test.ts`: `grain: "member"` emits one file per reference and the renderer receives `digest` and `witnessKey`. In `requirement-test-render.test.ts`: `the default output is byte-identical with the new args present` (compare with the existing expected text, unchanged).

Run: `cd server/typescript/packages/codegen-ts && bun test test/requirement-walk.test.ts test/requirement-tests-generator.test.ts test/requirement-test-render.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 2: Implement the digest and key.**

```ts
import { createHash } from "node:crypto";

const DIGEST_VERSION = "requirement-digest/v1";

function digestField(name: string, value: string): string {
  return `${name} ${Buffer.byteLength(value, "utf8")}\n${value}\n`;
}

export function requirementDigest(node: MetaRequirement): string {
  // attr() RESOLVES in TypeScript (ADR-0039): the digest is over the effective claim.
  const prose = (name: string): string => {
    const v = node.attr(name);
    return typeof v === "string" ? v.replace(/\r\n?/g, "\n") : "";
  };
  const level = node.level();
  const refs = node.implementedBy();
  const text =
    `${DIGEST_VERSION}\n` +
    digestField("subType", node.subType) +
    digestField("level", level === undefined ? "" : String(level)) +
    digestField("status", node.status() ?? "") +
    digestField("statement", prose(REQUIREMENT_ATTR_STATEMENT)) +
    digestField("counterexample", prose(REQUIREMENT_ATTR_COUNTEREXAMPLE)) +
    `implementedBy ${refs.length}\n` +
    refs.map((r) => digestField("ref", r)).join("");
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const mangle = (s: string): string => s.replace(/[^A-Za-z0-9]+/g, "_");

export function witnessKeyOf(qualifiedAddress: string, unit: string): string {
  const base = `req_${mangle(qualifiedAddress)}`;
  return unit === NO_CONCERN ? base : `${base}__${mangle(unit)}`;
}
```

- [ ] **Step 3: Implement the identities.** In `walkRequirements`, add `package: referrerPkg` to the view (the value is already computed there). `requirementTestIdentities` walks, applies `opts.filter ?? defaultRequirementTestFilter`, and for each requirement takes its units: under `concern`, the keys of `groupByConcern(walked)`; under `member`, the distinct `walked.targets.map((t) => t.ref)` in first-seen order, or `[NO_CONCERN]` when there are none. For each unit it builds the record with the qualified address of Table A and `skip` computed as `status !== undefined && !REQUIREMENT_STATUSES_REQUIRING_LIVE_NODES.includes(status) ? status : null`. Sort by `id` with a plain code-unit comparison (`a < b ? -1 : a > b ? 1 : 0`), never `localeCompare`.
- [ ] **Step 4: Thread the generator.** Move `defaultFilter` out of `requirement-tests.ts` to the exported `defaultRequirementTestFilter`. Under `grain: "member"`, the generator iterates references instead of concerns; the default path's last segment is the mangled unit, so a qualified reference never puts `::` in a filename. Fill the six new `RequirementTestArgs` fields for every call. `renderRequirementTest` ignores them.
- [ ] **Step 5: Run** the Step 1 command, `bun test test/requirement-orphans-e2e.test.ts test/requirement-stub-executes.test.ts`, and the workspace typecheck. Expected: PASS, with the existing render expectations untouched.
- [ ] **Step 6: Commit.** `git commit -m "feat(codegen-ts): requirement test identities, the requirement digest and a per-member grain"`
- [ ] **Step 7: Read the eject machinery.** `cli/src/commands/eject.ts` (one file per name, read from `<pkg>/src/reference/<name>.ts`, written verbatim), `codegen-ts/src/reference-templates.ts`, one existing reference template with its header (`src/reference/output-parser.ts`), `test/reference-byte-identical.test.ts` (`PAIRS`), `test/reference-templates.test.ts` (the hard-coded name list and the header rules), `scripts/check-reference-templates-lint.ts`, and `cli/src/lib/catalog-listing.ts` (the `use-when:` and `emits:` header lines it reads).
- [ ] **Step 8: Failing tests.** Add `"requirement-tests"` to the name list in `reference-templates.test.ts`; add `PAIRS["requirement-tests"]` in `reference-byte-identical.test.ts`, run over a model that holds requirements (functional L4 and L5, one planned, one with no targets, one architectural) under the default grain and under `grain: "member"`, with a non-default `filter` in one run; in `cli/test/eject-multi.test.ts` (or the eject test beside it) `meta eject requirement-tests` writes `codegen/generators/requirement-tests.ts` and no longer answers `package-only`. Run them. Expected: FAIL.
- [ ] **Step 9: Write the reference template.** `src/reference/requirement-tests.ts` holds the generator and the default stub renderer in one file (Table L's one-file rule: the eject copies one file, and the renderer is what an application is most likely to change). It imports only public exports of `@metaobjectsdev/codegen-ts` and `@metaobjectsdev/metadata`; export from `codegen-ts/src/index.ts` any primitive it needs that is not public yet (the identity and digest functions of Step 2 and 3). The built-in in `src/generators/` stays the oracle. Add the name to `REFERENCE_GENERATOR_NAMES`. Update the two documents named under Files, and nothing else in them.
- [ ] **Step 10: Run** the Step 8 tests, `bun scripts/check-reference-templates-lint.ts` from the repository root, `test-generators`' `owned-copies-current.test.ts`, `codegen-ts/test/generator-registry.test.ts`, the CLI's `gen --list` snapshot if one holds the `package-only` marker, and the workspace typecheck. Expected: PASS.
- [ ] **Step 11: Commit.** `git commit -m "feat(codegen-ts): a reference template for requirement-tests, so meta eject can hand it to the application"`

---

### Task 4: The requirement-test identity corpus and its TypeScript runner

**Files:**
- Create: `fixtures/requirement-test-identity-conformance/README.md` and the 24 case directories of Table J
- Create: `server/typescript/packages/codegen-ts/test/requirement-test-identity-conformance.test.ts`
- Modify: `scripts/write-requirement-corpus-expected.ts` (the `identity` corpus)

**Interfaces:**
- Consumes: `requirementTestIdentities`, `witnessKeyCollisions` (Task 3).
- Produces: the corpus Tasks 6, 8, 10 and 11 run.

- [ ] **Step 1: Write the runner** on the pattern of Task 2's: load strict, assert no load error, compute `requirementTestIdentities(root, { grain, filter })` (the `filter` option is a name, mapped to a predicate by a table in the runner that holds exactly the seven rows of Table J; an unknown name fails the test) and `witnessKeyCollisions(...)`, compare with `expected.tests` (both sorted by `id`) and `expected.collisions`. Include the README-equals-disk test.
- [ ] **Step 2: Write the inputs** for each row of Table J. `worked-example` holds the model of Tables F, G and H exactly, so its two expected digests are the pinned ones (`2714aa39…` and `4ddcd781…`). If the second does not come out as pinned, the input differs from the model the plan's author hashed: find the difference (level, statement or counterexample text) before touching Table H. Each `filter-*` case keeps a requirement the default filter would drop, or drops one it would keep, so a runner that ignores the option fails the case.
- [ ] **Step 3: Write and review the expectations.** `bun scripts/write-requirement-corpus-expected.ts identity`, then check each file by hand: the unit set against Table F, each `witnessKey` by applying the mangle rule on paper, each `skip` against the status, and for `digest-claim-fields` that the digests differ and agree where the case says. Recompute one digest independently (`printf` the text of Table G into `sha256sum`) for `digest-multibyte-and-crlf`.
- [ ] **Step 4: Write the README** (purpose, format, runner steps, case table, "Who asserts it").
- [ ] **Step 5: Run.** `cd server/typescript/packages/codegen-ts && bun test test/requirement-test-identity-conformance.test.ts`. Expected: PASS, 25 tests.
- [ ] **Step 6: Commit.** `git commit -m "test(conformance): requirement-test identity corpus, run by the TypeScript reference"`

---

### Task 5: Python requirement checks in `metaobjects verify`

**Files:**
- Modify: `server/python/src/metaobjects/meta/core/requirement/meta_requirement.py` (add `superseded_by()`, `is_retired()`), `library/library_sources.py` (add `library_packages()`), `cli.py`
- Create: `server/python/src/metaobjects/meta/core/requirement/resolve_claim.py`, `server/python/src/metaobjects/requirement_check.py`
- Test: `server/python/tests/conformance/test_requirement_check_conformance.py`, `server/python/tests/codegen/test_cli_verify_requirements.py`

**Interfaces:**
- Produces:

```python
# meta/core/requirement/resolve_claim.py
def split_member_ref(ref: str) -> tuple[str, list[str]]: ...
def resolve_claim_target(root: MetaData, owner: str, referrer_pkg: str) -> MetaData | None: ...
def resolve_member(obj: MetaData, path: list[str]) -> MetaData | None: ...
def resolve_claim(root: MetaData, ref: str, referrer_pkg: str) -> MetaData | None: ...

# requirement_check.py
@dataclass(frozen=True)
class Diagnostic:
    severity: str            # "error" | "warn"
    code: str
    message: str
    path: str | None = None

@dataclass(frozen=True)
class AddressedRequirement:
    node: MetaRequirement
    path: str

def collect_addressed_requirements(root: MetaData) -> list[AddressedRequirement]: ...
def scan_requirements(root, *, coverable=None, measure_coverage=None,
                      require_implementers=False) -> RequirementScan: ...
def check_requirements(root: MetaData, scan: RequirementScan | None = None) -> list[Diagnostic]: ...
def summarise_requirements(root: MetaData, scan: RequirementScan | None = None) -> RequirementSummary | None: ...
```

The code constants carry the TypeScript names (`ERR_REQUIREMENT_DANGLING_REF`, and so on) and `OBJECT_COVERAGE_SEVERITY = "warn"`.

- [ ] **Step 1: Read first.** `requirement-check.ts` whole, `resolve-claim.ts` whole, then `field_lint.py` and `_run_field_lint_advisory` / `_field_lint_findings` in `cli.py` (the wiring this copies). **UNVERIFIED:** that `node.package or node.file_default_package or ""` is the effective package of a nested requirement in a multi-file collection; that Python's `did_you_mean_hint` returns text byte-identical to TypeScript's; that `in_scope` (`config/dependencies.py:660`) answers what TypeScript's `collection.inScope` answers; the name of the resolved-super accessor and the abstract flag on Python `MetaData`.
- [ ] **Step 2: Failing conformance runner.** Model it on `tests/conformance/test_field_lint_conformance.py`: parametrize over the case directories of `fixtures/requirement-check-conformance/`, load strict with the case's libraries, assert no load error, compare diagnostics as a sorted list of `(severity, code, path or "", message)` and the summary as a dict (`None` for no requirements; no `entities*` keys when not measured).

Run: `cd server/python && uv run pytest tests/conformance/test_requirement_check_conformance.py -q` (use the repository's usual Python test invocation if it differs). Expected: FAIL, `requirement_check` not importable.
- [ ] **Step 3: Implement the accessors and the resolver.** `superseded_by()` returns the stripped-non-blank string or `None`; `is_retired()` compares with `REQUIREMENT_STATUS_RETIRED`. Both read through `get_meta_attr()`. `library_packages()` parses `EMBEDDED_LIBRARY_MANIFESTS` and returns the frozen union of every manifest's `packages`. `resolve_claim_target` calls `naming_refs.resolve_object_ref` first, then applies Table B's second row.
- [ ] **Step 4: Implement the checks,** row by row from Table C, in the order of Table C, with the message text copied from the TypeScript file. Row 3 ends the loop body for that requirement. `scan_requirements` computes the claim set once (Table D) and `measure_coverage` from `library_packages()` unless forced.
- [ ] **Step 5: Run the conformance runner.** Expected: PASS for all 42 cases. A failing case is a porting error; do not edit an `expected.json`.
- [ ] **Step 6: Failing CLI tests** in `test_cli_verify_requirements.py`: `a model with no requirements prints nothing and exits as before` (compare stderr and the exit code of `verify` on an existing no-requirement fixture before and after); `a dangling live reference exits 1 and prints the code, the path and the summary line`; `warnings alone exit 0`; `--require-implementers exits 1 on a nothing-implements warning` and so does `META_REQUIRE_IMPLEMENTERS=1`; `the gate runs with --templates alone` (no subverb selects it); `a metadata load failure prints no requirement line`.
- [ ] **Step 7: Wire `verify`.** Add `--require-implementers` to the `verify` parser. Factor the load inside `_field_lint_findings` into one helper that returns the root, the project's own files and the collection, and use it for both the field lint and the new `_verify_requirements(args) -> int`, so `verify` loads once for the two. `_verify_requirements` returns 0 when the root did not load, prints the lines of Table E to stderr with the `metaobjects verify —` prefix, and returns 1 when any diagnostic has severity `error`. In `_cmd_verify`: `exit_code = max(exit_code, _verify_requirements(args))`, on every run. Pass `coverable=collection.in_scope` when a collection was resolved.
- [ ] **Step 8: Run** `uv run pytest tests/conformance/test_requirement_check_conformance.py tests/codegen/test_cli_verify_requirements.py tests/codegen/test_cli_verify_field_lint.py -q`, then the port's lint and type check as `scripts/ci-local.sh` runs them (read the Python lane for the commands). Expected: PASS.
- [ ] **Step 9: Add the Python row** to the "Who asserts it" table of `fixtures/requirement-check-conformance/README.md`.
- [ ] **Step 10: Commit.** `git commit -m "feat(python): the requirement gate in metaobjects verify"`

---

### Task 6: Python `requirement-tests` generator

**Files:**
- Create: `server/python/src/metaobjects/codegen/requirement_walk.py`, `codegen/generators/requirement_tests_generator.py`
- Modify: `codegen/generator_registry.py`, `codegen/project_config.py`, `codegen/metaobjects-config.schema.json`, `cli.py` (pass the config block to the factory), `fixtures/generator-registry-conformance/registry.json` (add `"python"` to `requirement-tests`' `ports`)
- Test: `server/python/tests/conformance/test_requirement_test_identity_conformance.py`, `tests/codegen/test_requirement_tests_generator.py`, `tests/codegen/test_eject.py`

**Interfaces:**
- Consumes: `collect_addressed_requirements`, `resolve_claim` (Task 5).
- Produces:

```python
# codegen/requirement_walk.py
@dataclass(frozen=True)
class RequirementTestIdentity:
    package: str
    path: str
    unit: str
    id: str
    witness_key: str
    status: str | None
    skip: str | None          # None | "planned" | "retired"
    digest: str

@dataclass(frozen=True)
class RequirementView:          # what a filter receives; never the node
    sub_type: str
    level: int | None
    status: str | None
    path: str
    package: str
    implemented_by_types: tuple[str, ...]

def default_requirement_test_filter(view: RequirementView) -> bool: ...
def requirement_digest(node: MetaRequirement) -> str: ...
def witness_key_of(qualified_address: str, unit: str) -> str: ...
def requirement_test_identities(root, *, grain="concern", filter=None) -> list[RequirementTestIdentity]: ...
def witness_key_collisions(tests) -> list[tuple[str, str]]: ...

# codegen/generators/requirement_tests_generator.py
@dataclass(frozen=True)
class RequirementTestArgs:      # the Table F record plus the prose and the targets
    identity: RequirementTestIdentity
    statement: str
    counterexample: str
    targets: tuple[tuple[str, str], ...]   # (ref, "<type>.<subType>")
    disposition: str | None
    tracked_by: tuple[str, ...]

@dataclass(frozen=True)
class RenderedTest:
    imports: tuple[str, ...]
    source: str

def requirement_tests(*, witness_module: str = "tests.requirement_witnesses",
                      grain: str = "concern", renderer=None, filter=None,
                      warn_uncovered: bool = True) -> Generator: ...

def requirement_tests_generator(ctx: GeneratorBuildContext) -> Generator: ...
    # The registry's `source=`, and so the symbol an ejected copy is wired by. It takes
    # the build context (one required positional parameter, which is what `build_owned`
    # passes the context to) and builds requirement_tests(...) from the config block.
```

The module holds the generator **and** the default renderer and nothing unrelated: `metaobjects eject` copies the module file whole (Table L).

Config block, in `metaobjects.config.yaml`:

```yaml
requirementTests:
  witnessModule: tests.requirement_witnesses
  grain: member
  renderer: codegen.requirement_renderer:render
  filter: codegen.requirement_filter:include
  warnUncovered: false
```

- [ ] **Step 1: Read first.** `requirement-walk.ts`, `generators/requirement-tests.ts` and `templates/requirement-test.ts` (the escaping comments are the specification of Review Focus 1), then an existing Python generator factory and its registry entry, `eject.build_owned` (how a `module:symbol` is imported relative to the config), and `test_schema_and_loader_accept_EXACTLY_the_same_keys`. **UNVERIFIED:** how `metaobjects gen` reports or removes a generated file that is no longer emitted (`_diff_report`, `_is_ours_for` in `cli.py`). Confirmed since the plan was written: a registry entry is ejectable when it carries `source=`, `tests/codegen/test_eject.py::test_every_ejectable_entry_names_its_source` fails on an entry without it, and `eject.build_owned` passes the build context to a factory with exactly one required positional parameter. Read `codegen/eject.py` and that test before writing the factory.
- [ ] **Step 2: Failing identity runner,** parametrized over `fixtures/requirement-test-identity-conformance/`, comparing records as dicts with the corpus's field names (`witnessKey`, not `witness_key`). The runner maps the `filter` name of `options.json` to a predicate over `RequirementView` with a table of exactly the seven rows of Table J, and passes it as `filter=`. Run it. Expected: FAIL.
- [ ] **Step 3: Implement `requirement_walk.py`** from Tables F and G. Digest lengths use `len(value.encode("utf-8"))`. Sort by `id` with plain string comparison. Run the identity runner. Expected: PASS for all 24 cases.
- [ ] **Step 4: Failing generator tests** in `test_requirement_tests_generator.py`:
  - `the worked example renders the reference file`: generate from the identity corpus's `worked-example` input and compare with the Python block of Table H, byte for byte.
  - `one file per metamodel package`, `an unpackaged ledger writes test_root_requirements.py`.
  - `the output imports only importlib and pytest`: parse with `ast` and collect every `Import` and `ImportFrom`.
  - `the output parses under the Python 3.9 grammar`: `ast.parse(source, feature_version=(3, 9))`.
  - `prose with quotes, a backslash, a newline and a triple quote still parses, and the failure message carries it`.
  - `the generated tests run`: write the file and a witness module into `tmp_path`, run `sys.executable -m pytest` in a subprocess, and assert one passed (witness present and returning), one failed with `unimplemented requirement:` and the counterexample (no witness), one failed with the witness's own assertion, one skipped (planned).
  - `a broken witness module raises its own error`: a witness module whose body does `import does_not_exist` makes the test error with `ModuleNotFoundError: No module named 'does_not_exist'`, not "unimplemented requirement".
  - `a witness-key collision refuses generation` with `ERR_REQUIREMENT_WITNESS_KEY_COLLISION` and both ids in the message.
  - `grain="member" emits one test per reference`.
  - `a renderer hook replaces one test and receives the digest`; `a hook returning None keeps the default`; `the hook's imports are merged, deduplicated and sorted`.
  - `a model with no requirement emits nothing and warns nothing`.
  - `requirements the filter excludes produce one capped warning`; `warn_uncovered=False` silences it; `a filter keeps an L3 requirement the default drops, and it renders with unit *`; `requirementTests.filter in the config is imported as module:symbol and applied`.
  - In `tests/codegen/test_eject.py`: `an unchanged ejected requirement-tests copy generates identical output` (eject, wire the owned `module:symbol`, run `gen` over the identity corpus's `worked-example` model with a `requirementTests` block that sets `witnessModule` and `grain`, and compare with the packaged generator's output byte for byte; the non-default block is what proves the owned copy still reads its options), and `an edited copy drives gen` (change the failure message in the copy and see it in the output).
  - `stale file`: generate for two packages, remove one package's requirements, generate again, and assert what `gen` and `verify --codegen` report for the file that is no longer emitted. Write the assertion to match the port's existing behaviour for any generator and name that behaviour in the test title.
- [ ] **Step 5: Implement the generator.** The factory returns a generator that reads `ctx.loaded_root`, returns `[]` when it is `None` or holds no requirement, refuses on a collision, groups identities by package and renders each file per Table H. The default renderer is a function with the hook's signature. Register it: name `requirement-tests`, tier `native`, layer `capability`, description equal to the manifest's `concept`, `factory=requirement_tests_generator` and `source=requirement_tests_generator`.
- [ ] **Step 6: Config.** Add `requirementTests` to `TOP_LEVEL_KEYS` and to the JSON Schema with its five keys (`witnessModule`, `renderer` and `filter` strings, `grain` an enum of `concern` and `member`, `warnUncovered` a boolean), reject unknown keys, resolve `renderer` and `filter` the way `providers` are resolved, and carry the block on `GeneratorBuildContext` so the registry factory builds `requirement_tests(...)` from it. With no block, the defaults apply.
- [ ] **Step 7: Run** `uv run pytest tests/conformance/test_requirement_test_identity_conformance.py tests/conformance/test_generator_registry_conformance.py tests/codegen/test_requirement_tests_generator.py tests/codegen/test_codegen_compile_conformance.py -q` and the config-key parity test. Expected: PASS. The compile gate's model has no requirement, so its output set is unchanged.
- [ ] **Step 8: Add the Python row** to the identity corpus README.
- [ ] **Step 9: Commit.** `git commit -m "feat(python): requirement-tests generator emitting pytest with project-owned witnesses"`

---

### Task 7: Java requirement checks in `metaobjects:verify`

**Files:**
- Modify: `server/java/metadata/src/main/java/com/metaobjects/requirement/MetaRequirement.java` (add `getSupersededBy()`, `isRetired()`), `library/LibrarySources.java` (add `libraryPackages()`), `server/java/maven-plugin/src/main/java/com/metaobjects/mojo/MetaDataVerifyMojo.java`
- Create: `metadata/src/main/java/com/metaobjects/requirement/RequirementClaims.java`, `RequirementCheck.java`
- Test: `metadata/src/test/java/com/metaobjects/conformance/RequirementCheckConformanceTest.java`, `maven-plugin/src/test/java/com/metaobjects/mojo/MetaDataVerifyRequirementsTest.java`

**Interfaces:**
- Produces:

```java
public final class RequirementClaims {
    public record MemberRef(String owner, List<String> path) {}
    public static MemberRef splitMemberRef(String ref);
    public static MetaData resolveClaimTarget(MetaRoot root, String owner, String referrerPkg);
    public static MetaData resolveMember(MetaData obj, List<String> path);
    public static MetaData resolveClaim(MetaRoot root, String ref, String referrerPkg);
}

public final class RequirementCheck {
    public enum Severity { ERROR, WARN }
    public record Diagnostic(Severity severity, String code, String path, String message) {}  // path may be null
    public record Addressed(MetaRequirement node, String path) {}
    public record Options(Boolean measureCoverage, boolean requireImplementers) {}
    public static List<Addressed> collectAddressed(MetaRoot root);
    public static Scan scan(MetaRoot root, Options options);
    public static List<Diagnostic> check(MetaRoot root, Scan scan);
    public static Summary summarise(MetaRoot root, Scan scan);   // null when no requirement
}
```

- [ ] **Step 1: Read first.** `requirement-check.ts` and `resolve-claim.ts` whole; `validation/SymbolTable.java` (`build(MetaRoot)`, `resolveObject(ref, referrerPkg)`); `mojo/FieldLint.java` and `runFieldLintAdvisory` in `MetaDataVerifyMojo.java`; `metadata/src/test/java/com/metaobjects/requirement/RequirementTest.java` for how a requirement fixture is loaded in a test. In Java a root node's `getName()` is its package-qualified name and `getShortName()` the bare one. **UNVERIFIED:** the accessor for a node's file-default package and the one for abstractness on `MetaData`; whether `getPackage()` is non-null on a nested requirement; whether the private `didYouMeanHint` in `ValidationPhase.java:4218` can be made package-visible and reused, and whether its text matches TypeScript's; which Java version the `metadata` module compiles at (use final classes with accessors if `record` is not available).
- [ ] **Step 2: Failing conformance runner.** A JUnit 4 parameterized test over the case directories, found through `conformance/CorpusRoot.java`, loading with the providers `ConformanceTestProviders` composes plus the case's libraries. Compare as Task 5 does, with severity lower-cased.

Run: `mvn -q -f server/java/pom.xml -pl metadata test -Dtest=RequirementCheckConformanceTest`. Expected: FAIL to compile. Use `MAVEN_ARGS` for a repository override, never `MAVEN_OPTS`.
- [ ] **Step 3: Implement** the accessors, `libraryPackages()` (parse each `EmbeddedLibrary.MANIFESTS` value's `packages`, the way `parseLayers` reads `layers`), `RequirementClaims` (objects through one `SymbolTable` built per scan) and `RequirementCheck`, row by row from Table C with the message text copied from the TypeScript file. Expose one did-you-mean helper instead of writing a third copy.
- [ ] **Step 4: Run** the runner. Expected: PASS for all 42 cases.
- [ ] **Step 5: Failing mojo tests** in `MetaDataVerifyRequirementsTest.java`, on the pattern of `MetaDataVerifyFieldLintTest.java`: no requirements logs nothing and does not fail; a dangling live reference throws `MojoFailureException` after logging the code, path and summary; warnings alone do not fail; `requireImplementers` (the parameter and the environment variable) fails on a nothing-implements warning; the gate runs once per `execute()` whichever of the template and codegen gates ran.
- [ ] **Step 6: Wire the mojo.** A `@Parameter(property = "meta.verify.requireImplementers", defaultValue = "false")`, and `runRequirementGate(loader)` called once from `execute()`. It logs the summary with `getLog().info`, warnings with `getLog().warn`, errors with `getLog().error`, each prefixed `metaobjects:verify —`, and throws `MojoFailureException` when any error was found. Kotlin projects get the gate through this goal.
- [ ] **Step 7: Run** `mvn -q -f server/java/pom.xml -pl metadata,maven-plugin -am test -Dtest='RequirementCheckConformanceTest,MetaDataVerifyRequirementsTest,MetaDataVerifyFieldLintTest,RequirementTest'`. Expected: PASS.
- [ ] **Step 8: Add the Java and Kotlin rows** to the check corpus README (Kotlin "inherits via Java").
- [ ] **Step 9: Commit.** `git commit -m "feat(java): the requirement gate in metaobjects:verify"`

---

### Task 8: Java `requirement-tests` generator

**Files:**
- Create: `server/java/metadata/src/main/java/com/metaobjects/requirement/RequirementTestIdentities.java`, `RequirementTestFilter.java`
- Create: `server/java/codegen-base/src/main/java/com/metaobjects/generator/requirement/RequirementTestRenderer.java`, `RequirementTestArgs.java`, `RenderedTest.java` (the hook types: package API, not ejected, and visible to `codegen-kotlin`)
- Create: `JUnitRequirementTestsGenerator.java` in `codegen-spring`, in the package the other ejectable Java generators live in. One file, holding the default rendering (Table L). It lives in `codegen-spring` because that module's `pom.xml` is what ships generator sources as eject resources.
- Modify: `codegen-spring/src/main/java/com/metaobjects/generator/GeneratorRegistry.java`, `codegen-spring/pom.xml` (the eject `<include>`; JUnit Jupiter API, test scope, for compiling generated output in the test), `docs/ports/java.md` (the registry conformance test requires every registered generator to be named there by stable name and class), `fixtures/generator-registry-conformance/registry.json` (add `"java"`)
- Test: `metadata/src/test/java/com/metaobjects/conformance/RequirementTestIdentityConformanceTest.java`, `JUnitRequirementTestsGeneratorTest.java` beside the generator in `codegen-spring`, `codegen-spring`'s `EjectedGeneratorsCompileTest.java` (the name list), and a round-trip test in `maven-plugin` on the pattern of `EjectRoundTripTest.java`

**Interfaces:**
- Consumes: `RequirementCheck.collectAddressed`, `RequirementClaims.resolveClaim` (Task 7).
- Produces:

```java
public final class RequirementTestIdentities {
    public enum Grain { CONCERN, MEMBER }
    public record Identity(String pkg, String path, String unit, String id, String witnessKey,
                           String status, String skip, String digest) {}
    public static String digest(MetaRequirement node);
    public static String witnessKeyOf(String qualifiedAddress, String unit);
    /** What a filter receives; never the node. level and status may be null. */
    public record View(String subType, Integer level, String status, String path, String pkg,
                       List<String> implementedByTypes) {}
    public static boolean defaultFilter(View view);
    /** A null filter means the default. */
    public static List<Identity> identities(MetaRoot root, Grain grain, RequirementTestFilter filter);
    public static List<String[]> witnessKeyCollisions(List<Identity> tests);
}

/** In `metadata`, beside the identities, because the identity function applies it. */
public interface RequirementTestFilter {
    boolean include(RequirementTestIdentities.View view);
}

public interface RequirementTestRenderer {
    /** Return null to keep the default rendering of this test. */
    RenderedTest render(RequirementTestArgs args);
}
```

Generator args: `testPackage` (required), `witnessClass` (required, a fully-qualified class name), `grain` (`concern` or `member`), `renderer` (optional class name), `filter` (optional class name of a `RequirementTestFilter`), `warnUncovered` (`true` by default).

- [ ] **Step 1: Read first.** `GeneratorBase.java` (`getArg`, the output-directory args), one existing `codegen-base` generator that writes Java source and its test, `CodegenCompileConformanceTest.java` in `codegen-spring` (how generated Java is compiled in a test), and how `MetaDataGeneratorMojo` instantiates a generator class by name. Also read `maven-plugin`'s `MetaDataEjectMojo.java`, `EjectSupport.java` and `EjectRoundTripTest.java`, and `codegen-spring/pom.xml`'s eject `<include>` list. Settled since the plan was written: the generator lives in `codegen-spring` (Table L). **UNVERIFIED:** how a renderer or filter class named in an arg can be loaded so that a class on the **project's** classpath is found. The mojo loads the generator with a project class loader whose parent is the plugin's, so a packaged generator's own loader does not see project classes; read `AbstractMetaDataMojo.buildGenerators` and `createProjectClassLoader`, and pass or set the loader rather than guess. No generator arg names a loadable class today, so this is new ground: stop and report if it cannot be done without changing how every generator is constructed; how the JUnit Jupiter version is managed in `server/java/pom.xml` (it is used today only by the Kotlin and integration modules).
- [ ] **Step 2: Failing identity runner,** then implement `RequirementTestIdentities` from Tables F and G (`value.getBytes(StandardCharsets.UTF_8).length`, `MessageDigest` SHA-256, sort with `String.compareTo`). The runner maps the `filter` name of `options.json` to a `RequirementTestFilter` with a table of exactly the seven rows of Table J. Run: `mvn -q -f server/java/pom.xml -pl metadata test -Dtest=RequirementTestIdentityConformanceTest`. Expected: FAIL, then PASS for all 24 cases.
- [ ] **Step 3: Failing generator tests:** the worked example (the identity corpus's `worked-example` input) emits `Requirements_acme_shop_Witnesses.java` and `Requirements_acme_shop_Test.java` in `testPackage`; the interface has one default member per non-skipped test and none for a skipped one; a skipped test carries `@Disabled` with the reason of Table H; the output imports only `org.junit.jupiter.api.*`; **the output compiles** with `javax.tools` together with a hand-written witness class, and invoking the test method on the compiled class throws `AssertionError` whose message holds `unimplemented requirement:` and the counterexample when the witness class does not override it, and returns normally when it does; prose with `"`, `\`, a newline and `*/` still compiles; a collision throws `GeneratorException` naming `ERR_REQUIREMENT_WITNESS_KEY_COLLISION` and both ids; `grain=member`; a renderer class replaces one test and receives the digest; a `filter` class keeps an L3 requirement the default drops and it renders with unit `*`; the excluded requirements produce one capped warning and `warnUncovered=false` silences it; a `filter` class that cannot be loaded is a clear `GeneratorException`; a missing `witnessClass` arg is a clear `GeneratorException`; a model with no requirement writes nothing; `stale file` as in Task 6. **Eject:** `requirement-tests` is in `EjectedGeneratorsCompileTest`'s list and compiles package-renamed against the published API; the round-trip test ejects it, compiles the unchanged copy and gets byte-identical output over the `worked-example` model with non-default `grain` and `testPackage` args; `EjectSupportTest` still passes with its hard-coded non-ejectable set unchanged.
- [ ] **Step 4: Implement** per Table H. The test class holds `private final Requirements_<pkgKey>_Witnesses witnesses = new <witnessClass>();`. Register `requirement-tests` with `Tier.NATIVE`, `Layer.CAPABILITY` (the enum's capability constant; read its name) and `ejectPath(JUnitRequirementTestsGenerator.class)`, add the `<include>` to `codegen-spring/pom.xml`, and name the generator in `docs/ports/java.md`. Nothing in the generated header may carry the generator's own class or package name: the ejected copy has a different one, and its output must be byte-identical.
- [ ] **Step 5: Run** `mvn -q -f server/java/pom.xml -pl metadata,codegen-base,codegen-spring,maven-plugin -am test -Dtest='RequirementTestIdentityConformanceTest,JUnitRequirementTestsGeneratorTest,GeneratorRegistryConformanceTest,CodegenCompileConformanceTest,EjectedGeneratorsCompileTest,EjectSupportTest,EjectRoundTripTest,MetaDataEjectMojoTest'` plus the new round-trip test by name (add `-Dsurefire.failIfNoSpecifiedTests=false` if a module holds none of them). Expected: PASS.
- [ ] **Step 6: Add the Java row** to the identity corpus README.
- [ ] **Step 7: Commit.** `git commit -m "feat(java): requirement-tests generator emitting JUnit with a typed witness interface"`

---

### Task 9: C# requirement checks in `dotnet meta verify`

**Files:**
- Modify: `server/csharp/MetaObjects/Meta/MetaRequirement.cs` (add `SupersededBy`, `IsRetired()`), `MetaObjects/Library/LibrarySources.cs` (add `LibraryPackages()`), `MetaObjects.Cli/Program.cs`, `MetaObjects.Cli/VerifyCommand.cs`
- Create: `MetaObjects/Core/Requirement/RequirementClaims.cs`, `RequirementCheck.cs`
- Test: `MetaObjects.Conformance.Tests/RequirementCheckConformanceTests.cs`, `MetaObjects.Cli.Tests/VerifyRequirementsTests.cs`

**Interfaces:**
- Produces, in namespace `MetaObjects.Core.Requirement`: `RequirementClaims.SplitMemberRef`, `ResolveClaimTarget`, `ResolveMember`, `ResolveClaim`; `RequirementCheck.CollectAddressed`, `Scan(root, measureCoverage: null, requireImplementers: false)`, `Check(root, scan)`, `Summarise(root, scan)`; `record RequirementDiagnostic(string Severity, string Code, string? Path, string Message)`.

- [ ] **Step 1: Read first.** The two TypeScript files; `NamingRefs.cs` (`ResolveObjectRef`, `EffectivePackage`, `DidYouMeanHint`); `MetaObjects.Cli/FieldLint.cs` and `Program.cs:460-650` (flag parsing, `--no-field-lint`, the `FieldLint.RunAdvisory` call and its output prefix); `MetaObjects.Cli.Tests/FieldLintConformanceTests.cs`. `MetaData` has `SuperData`, `Parent`, `ResolutionKey()` and `IsAbstract`. **UNVERIFIED:** whether `DidYouMeanHint`'s text matches TypeScript's; where `verify` computes its exit code so the gate can contribute to it.
- [ ] **Step 2: Failing conformance runner** on the pattern of `FieldLintConformanceTests.cs`, in `MetaObjects.Conformance.Tests` (the checks are core, not CLI). Run: `dotnet test server/csharp --filter RequirementCheckConformance`. Expected: FAIL to compile.
- [ ] **Step 3: Implement** the accessors, `LibraryPackages()` and the two classes, row by row from Table C.
- [ ] **Step 4: Run** the runner. Expected: PASS for all 42 cases.
- [ ] **Step 5: Failing CLI tests** in `VerifyRequirementsTests.cs`, mirroring Task 5 Step 6: silence and an unchanged exit code with no requirements; exit 1 and the printed lines on a dangling live reference; exit 0 on warnings; `--require-implementers` and `META_REQUIRE_IMPLEMENTERS=1`.
- [ ] **Step 6: Wire the CLI.** Parse `--require-implementers`, add it to the usage line, and run the gate on every `verify` beside the field lint, writing to `Console.Error` and folding a non-zero result into the command's exit code.
- [ ] **Step 7: Run** `dotnet test server/csharp --filter "RequirementCheckConformance|VerifyRequirements|VerifyFieldLint|FieldLintConformance"`. Expected: PASS.
- [ ] **Step 8: Add the C# row** to the check corpus README.
- [ ] **Step 9: Commit.** `git commit -m "feat(csharp): the requirement gate in dotnet meta verify"`

---

### Task 10: C# `requirement-tests` generator

**Files:**
- Create: `server/csharp/MetaObjects/Core/Requirement/RequirementTestIdentities.cs`, `MetaObjects.Codegen/Generators/RequirementTestsGenerator.cs`
- Modify: `MetaObjects.Codegen/GeneratorRegistry.cs` (the entry, with `SourceFileName`), `MetaObjects.Codegen/MetaObjects.Codegen.csproj` (the `<EmbeddedResource>` item), `fixtures/generator-registry-conformance/registry.json` (add `"csharp"`)
- Test: `MetaObjects.Conformance.Tests/RequirementTestIdentityConformanceTests.cs`, `MetaObjects.Codegen.Tests/RequirementTestsGeneratorTests.cs`, `MetaObjects.Codegen.Tests/EjectedGeneratorCompileTests.cs`, `EjectableGeneratorsTests.cs`

**Interfaces:**
- Consumes: Task 9's walk and resolver.
- Produces: `RequirementTestIdentities.Digest`, `WitnessKeyOf`, `DefaultFilter`, `Identities(root, grain, filter: null)`, `WitnessKeyCollisions`; `record RequirementView(string SubType, int? Level, string? Status, string Path, string Package, IReadOnlyList<string> ImplementedByTypes)`; `interface IRequirementTestFilter { bool Include(RequirementView view); }`; `record RequirementTestIdentity(string Package, string Path, string Unit, string Id, string WitnessKey, string? Status, string? Skip, string Digest)`; `interface IRequirementTestRenderer { RenderedTest? Render(RequirementTestArgs args); }`.

- [ ] **Step 1: Read first.** `Generator.cs` (`IGenerator`, `GenContext`), an existing generator and its registry entry, `CodegenCompileConformanceTests.cs` (the Roslyn compile helper), `MetaObjects.Cli/GenCommand.cs` and `OwnedCopy.cs`. **UNVERIFIED:** how a per-generator option (`testNamespace`, `witnessClass`, `grain`, a renderer, a filter, `warnUncovered`) reaches a C# generator from the CLI or a config file; decide from the code, keep the six names of Table I, and state the surface in the commit. Known since the plan was written: no per-generator option channel exists (`GenConfig` is global to the run, `.metaobjects/config.json` carries `sources` and `libraries` only), an owned `codegen/Program.cs` constructs generators itself (`new X { … }`), and the packaged tool cannot load a project's classes. The surface that follows from that: **public init properties on `RequirementTestsGenerator`**, with defaults that make the packaged `dotnet meta gen --generators requirement-tests` run work with no option at all (derive the test namespace and the witness class name from `GenConfig.Namespace`), and the project sets any of the six in its `codegen/Program.cs`. Do not add keys to `.metaobjects/config.json`: it is the neutral config every port reads. Also read `EjectableGenerators.cs` (`RewriteForEject` needs the exact line `namespace MetaObjects.Codegen.Generators;`, and the file may use nothing `internal`), `EjectCommand.cs`, `EjectedGeneratorCompileTests.cs` and `EjectableGeneratorsTests.cs`. **UNVERIFIED:** that `Xunit.Sdk.XunitException(string)` is usable from generated code under xUnit 2.9.2; if not, throw `System.InvalidOperationException` and say so in Table H when updating the docs.
- [ ] **Step 2: Failing identity runner,** the runner mapping the `filter` name of `options.json` to an `IRequirementTestFilter` with a table of exactly the seven rows of Table J; then implement `RequirementTestIdentities` (`Encoding.UTF8.GetByteCount`, `SHA256.HashData`, lower-case hex, `StringComparer.Ordinal`). Expected: PASS for all 24 cases.
- [ ] **Step 3: Failing generator tests,** the C# equivalents of Task 8 Step 3: the two files per package; interface members only for non-skipped tests; `[Fact(Skip = "…")]`; only `Xunit` imported; **the output compiles** with Roslyn beside a hand-written witness class, and invoking the test method throws with the unimplemented message when the member is not implemented and returns when it is; the escaping case (`"`, `\`, a newline, `*/`); the collision refusal; member grain; the renderer hook; a filter keeps an L3 requirement the default drops; the capped uncovered warning and its switch; no requirements writes nothing; `stale file`. **Eject:** the embedded copy is byte-identical to `Generators/RequirementTestsGenerator.cs` and the embedded set still equals the registry's ejectable set (`EjectableGeneratorsTests`); the rewritten copy compiles with Roslyn against the public API only and, with non-default `Grain` and `TestNamespace`, emits the same bytes as the packaged generator over the `worked-example` model.
- [ ] **Step 4: Implement** per Table H, in one file that holds the default rendering (Table L), and register `requirement-tests` (`Tier` native, `Layer` capability, `SourceFileName = "RequirementTestsGenerator.cs"`) with its `<EmbeddedResource>` item.
- [ ] **Step 5: Run** `dotnet test server/csharp --filter "RequirementTestIdentityConformance|RequirementTestsGenerator|GeneratorRegistryConformance|CodegenCompileConformance|EjectableGenerators|EjectedGeneratorCompile|EjectEndToEnd"`. Expected: PASS.
- [ ] **Step 6: Add the C# row** to the identity corpus README.
- [ ] **Step 7: Commit.** `git commit -m "feat(csharp): requirement-tests generator emitting xUnit with a typed witness interface"`

---

### Task 11: Kotlin `requirement-tests` generator

**Files:**
- Create: `server/java/codegen-kotlin/src/main/kotlin/com/metaobjects/generator/kotlin/KotlinRequirementTestsGenerator.kt`
- Modify: `codegen-kotlin/.../GeneratorRegistry.kt` (the entry, with `ejectResourcePath`), `codegen-kotlin/pom.xml` (the eject `<include>`), `fixtures/generator-registry-conformance/registry.json` (add `"kotlin"`), `docs/ports/kotlin.md` if its registry conformance test requires the generator to be named there
- Test: `codegen-kotlin/src/test/kotlin/com/metaobjects/generator/kotlin/KotlinRequirementTestsGeneratorTest.kt`, `EjectedGeneratorsCompileTest.kt` (`ejectableSimpleNames`)

**Interfaces:**
- Consumes: `RequirementTestIdentities`, `RequirementTestRenderer`, `RequirementTestArgs`, `RenderedTest` (Task 8). Same six generator args as Java, the `filter` arg naming a `RequirementTestFilter` class.

- [ ] **Step 1: Read first.** `KotlinNamesGenerator.kt` (a small generator and how it writes), `KotlinGenUtil.kt` (string escaping helpers, including `$`), `CodegenCompileConformanceTest.kt` and `KotlinSpringControllerGeneratorTest.kt` (kotlin-compile-testing). **UNVERIFIED:** that `codegen-kotlin` can see `codegen-base`'s `generator.requirement` types.
- [ ] **Step 2: Failing tests:** the worked example emits `Requirements_acme_shop_Witnesses.kt` (an interface whose members have default bodies) and `Requirements_acme_shop_Test.kt`; the emitted test function names equal the `witnessKey` values of the identity corpus's `worked-example` and `concern-fanout` cases (this is how Kotlin asserts the identity contract; the identity function itself is the JVM one Task 8 gates); skipped tests carry `@Disabled`; **the output compiles** with a hand-written witness class and behaves as in Task 8 when invoked; a counterexample containing `$name`, `"`, `\` and a newline compiles and survives into the message; the collision refusal; member grain; the renderer hook; a `filter` class keeps an L3 requirement the default drops; the capped uncovered warning and its switch; no requirements writes nothing. **Eject:** `KotlinRequirementTestsGenerator` is in `ejectableSimpleNames` and compiles package-renamed; and, new for this port, the package-renamed copy is instantiated from the compiled result, run over the `worked-example` model with non-default `grain` and `testPackage`, and its output is byte-identical to the packaged generator's.
- [ ] **Step 3: Implement** per Table H, in one file that holds the default rendering (Table L), and register `requirement-tests` with `ejectResourcePath = ejectPath("KotlinRequirementTestsGenerator")` and the `<include>` in `codegen-kotlin/pom.xml`.
- [ ] **Step 4: Run** the `codegen-kotlin` unit suite for the new test, `GeneratorRegistryConformanceTest`, `CodegenCompileConformanceTest`, and the Exposed 1.x check module (`codegen-kotlin-exposed1x-check`) since it re-runs the Kotlin generators. Expected: PASS.
- [ ] **Step 5: Add the Kotlin row** to the identity corpus README ("identity function inherits via Java; emitted names asserted by `KotlinRequirementTestsGeneratorTest`").
- [ ] **Step 6: Commit.** `git commit -m "feat(kotlin): requirement-tests generator emitting JUnit with a typed witness interface"`

---

### Task 12: Docs, skills, changelog, counts

**Files:**
- Modify: `docs/features/requirements.md` (the status lines at 6-7; new sections "The gate in every port", "Generated requirement tests and witnesses", "Requiring implementers"), `docs/features/cli.md` (the flag in each port's `verify`), `docs/CONFORMANCE.md` (two matrix rows; the corpus count in the prose where it says how many shared corpora there are; "Core corpora and template quality checks": the check corpus is core, the identity corpus is a template quality check; "Split coverage": rewrite the "Checks — TypeScript only, by decision" bullet and the "deliberate split" paragraph that uses requirements as its example; the fixture-to-feature table at the end)
- Modify: `docs/ports/python.md` (a "Selecting the interpreter" section), `docs/ports/java.md`, `kotlin.md`, `csharp.md`, `typescript.md`
- Modify: `agent-context/skills/metaobjects-verify/references/requirements.md`, `metaobjects-authoring/references/requirements.md`, `metaobjects-audit/references/requirements.md`, and the per-port `metaobjects-codegen` references (a `requirement-tests` paragraph each)
- Regenerate: `fixtures/agent-context-conformance/*/expected/`
- Modify: `CLAUDE.md` and `AGENTS.md`, **only** the sentences this change makes false: the "Six pillars" lead-in ("its `meta verify` checks in the Node `meta` CLI, and its test scaffolding in TypeScript only") and pillar 5's "The port split, stated exactly" sentence. Add nothing else to either file.
- Modify: `README.md` wherever it states the TypeScript-only split (**UNVERIFIED** whether it does), `CHANGELOG.md` `[Unreleased]`, `fixtures/requirement-harness/README.md` (one sentence: the shipped generators now exist in every port; this harness stays a skipped scaffold and is still generated by its script)
- Modify: `metaobjects/meta.requirements.yaml`, then regenerate `fixtures/requirement-harness/*`

- [ ] **Step 1: `docs/features/requirements.md`.** State the gate as Tables C to E in prose, per port, with each port's command. State the witness model as Table H with one short example per ecosystem and the one-time setup (create the witness module or class). State the strict switch. Keep "What a green run does not prove" and add: a generated test that passes proves the witness ran, not that the witness tests the claim.
- [ ] **Step 1b: Present it as a recommendation.** In `docs/features/requirements.md`, the section on generated tests opens by saying what it is: the stock generator and the witness model are a **recommended approach**, shipped as a reference helper, and an application may change or replace them. Give each port's eject command (`meta eject requirement-tests`, `metaobjects eject requirement-tests`, `mvn metaobjects:eject -Dgenerator=requirement-tests` in the form that goal really takes, `dotnet meta eject requirement-tests`; **run each before documenting it**), say what the copy holds (the generator and its default renderer) and what stays in the package (the identity function, the digest and the checks), and say plainly that the checks in `verify` are not ejectable because they are the contract. Add the generator to `docs/features/own-your-codegen.md` where that page lists what each port can eject. The same framing goes into the per-port `metaobjects-codegen` skill paragraphs and the `docs/ports/*.md` rows.
- [ ] **Step 1c: `CLAUDE.md` and `AGENTS.md`, one more sentence this change makes false:** the "Core vs helpers" paragraph lists `requirement-tests` among the TypeScript generators that ship no reference copy. Remove that one name from the list. Nothing else.
- [ ] **Step 2: `docs/ports/python.md`, "Selecting the interpreter".** `metaobjects` needs Python 3.11 or later to **run**. The tests it generates need only pytest and run on the project's own interpreter, 3.9 or later. A project on an older interpreter runs the tool with a different one, without changing its own: `uv tool run --python 3.12 metaobjects gen` and `uv tool run --python 3.12 metaobjects verify` (**UNVERIFIED:** run both before documenting them, and add the `pipx run --python` form only if it is confirmed). Say plainly that the floor is not being lowered.
- [ ] **Step 3: Skills, then regenerate.**

```bash
cd server/typescript/packages/sdk
bun scripts/regen-agent-context-conformance.ts
bun test test/agent-context-conformance.test.ts test/agent-context-capability-grounding.test.ts
cd ../../../.. && bun scripts/check-doc-examples.ts
```

Expected: PASS.
- [ ] **Step 4: Counts.** Two new corpora take the shared-corpus count from 26 to 28 wherever it is stated (`docs/CONFORMANCE.md`, `CLAUDE.md`, `AGENTS.md`). Run `bun test scripts/site/counts.test.ts`. **UNVERIFIED:** what that test counts; read it first.
- [ ] **Step 5: The project's own ledger.** Read the entries in `metaobjects/meta.requirements.yaml` about the requirement gate and requirement tests. Move to a non-`planned` status only what this slice makes true, with an `implementedBy` that resolves, then run `bun scripts/generate-requirement-harness.ts` and `scripts/check-requirements-ledger.ts`. **UNVERIFIED:** which entries those are; if none, change nothing and say so in the commit.
- [ ] **Step 6: CHANGELOG `[Unreleased]`.** Added: the requirement gate in `metaobjects verify`, `metaobjects:verify` and `dotnet meta verify`; a `requirement-tests` generator in Python, Java, Kotlin and C#, ejectable in each; a TypeScript reference template for `requirement-tests`, so `meta eject requirement-tests` works instead of answering `package-only`; `--require-implementers` in every port; `grain` and the digest on the TypeScript generator; the same filter and uncovered-warning options on the generator in every port. State that a project with no `requirement.*` node sees no change, and that a project **with** requirements on a non-TypeScript port will now see diagnostics it did not see before, and may see a failing `verify`.
- [ ] **Step 7: Commit.** `git commit -m "docs(requirements): the gate and the requirement-test generator in every port (ADR-0057)"`

---

### Task 13: Full CI, review, push

- [ ] **Step 1:** `scripts/ci-local.sh` (full, no flags). Expected: every lane green, including `gates` (metamodel version unchanged at 1.1, counts, leak scan, doc examples, the four requirement gates) and each port's codegen-compile gate.
- [ ] **Step 2:** `node scripts/check-metamodel-version.mjs` (no `--set`). Expected: passes with no vocabulary change reported.
- [ ] **Step 3:** Run each port's two corpus runners once more by name, and confirm both corpus READMEs list all five ports.
- [ ] **Step 4:** Independent review of the whole change by a fresh reviewer over `git diff origin/main..HEAD`; fix findings.
- [ ] **Step 5:** Push and open the pull request.

---

## No-churn and back-compat proof

| Claim | What proves it |
|---|---|
| A model with no `requirement.*` node sees no change in any port's `verify` | `checkRequirements` returns `[]` and `summariseRequirements` returns `undefined` when nothing was collected (`requirement-check.ts:417`, `:665`), and each port copies both early returns. Corpus case `no-requirements` in five ports; the CLI test "a model with no requirements prints nothing and exits as before" in Tasks 5, 7 and 9 |
| A model with no `requirement.*` node generates nothing new | The generator is opt-in: it is in no default selection (ADR-0034 Amendment 2 removed default suites) and returns no file for a root with no requirement. Each generator test's "no requirements writes nothing"; each port's codegen-compile gate model holds no requirement and its output set is unchanged |
| No vocabulary change | `expected-registry.json` untouched; `check-metamodel-version.mjs` passes without `--set`; no loader pass is added, so `fixtures/conformance/` is untouched |
| TypeScript's emitted stubs keep their bytes | Task 3 test "the default output is byte-identical with the new args present"; `requirement-test-render.test.ts` and `requirement-stub-executes.test.ts` keep their expectations; test names and paths are unchanged under the default grain |
| TypeScript's gate output is unchanged without the new flag | `requireImplementers` defaults to false; the existing 1,125-line `requirement-check.test.ts` passes unedited apart from its two new tests |
| The generator registry stays in step | `registry.json`'s `ports` gains one port in the same commit as that port's registry entry; each port's registry conformance test asserts set equality |
| `fixtures/codegen-noop/` is untouched | No generator's behaviour changes for a model without requirements; the five inert tests are not edited |
| The canonical format is unchanged | Nothing is serialised; the digest is computed from accessors and is not stored in metadata |
| **Behaviour change 1** (intended, by ruling) | A project that already declares requirements and runs `metaobjects verify`, `metaobjects:verify` or `dotnet meta verify` now gets the gate. A ledger with a stale reference turns that command red on upgrade. The CHANGELOG names it |
| **Behaviour change 2** (intended) | `verify` in Python, Java and C# prints a requirements summary line on every run for such a project |

## Unverified items

Each is the first step of the task that touches it.

| Item | Task |
|---|---|
| No corpus case has been loaded yet; a case of Table J may need a different model shape to load strict, or may be unreachable | 2, 4 |
| Where `codegen-ts` exports `walkRequirements` from, and whether `node:crypto` is already used in that package | 3 |
| ~~What `ejectable("requirement-tests")` means~~ Resolved: the flag is derived from `REFERENCE_GENERATOR_NAMES`, so it is `false` until Task 3 Step 9 ships the reference template | 3 |
| Python: the effective package of a nested requirement in a multi-file collection; the resolved-super accessor and the abstract flag on `MetaData`; that `in_scope` matches TypeScript's `inScope` | 5 |
| That each port's did-you-mean hint is byte-identical to TypeScript's (the corpus pins it) | 5, 7, 9 |
| How each port's `gen` and `verify --codegen` treat a generated file that is no longer emitted | 6, 8, 10, 11 |
| ~~Whether a Python registry entry needs `source=`~~ Resolved: it does, and `requirement-tests` is ejectable in every port by the owner's requirement (Table L) | 6 |
| Java: the file-default-package and abstract accessors on `MetaData`; whether `getPackage()` is set on a nested requirement; the Java language level of `metadata` | 7 |
| Java: loading a renderer or filter class named in a generator arg from the project's classpath; JUnit Jupiter version management. (Which module owns the generator is resolved: `codegen-spring`, Table L) | 8 |
| C#: the output prefix of `FieldLint.RunAdvisory`; where `verify` computes its exit code | 9 |
| C#: `Xunit.Sdk.XunitException` from generated code. (The option surface is resolved: init properties on the generator, Task 10 Step 1) | 10 |
| ~~Kotlin: that `codegen-kotlin` sees `codegen-base`'s new types~~ Resolved: it depends on `metaobjects-codegen-base` | 11 |
| The `uv tool run --python` commands (not run) | 12 |
| What `scripts/site/counts.test.ts` counts; whether `README.md` states the TypeScript-only split; which ledger entries this slice makes true | 12 |
| That a requirement can nest only under a requirement or the root (read from `requirement.json`'s child rules only, not from a loader) | 2 |

## Answered questions

The plan as merged asked the owner nine questions. The answers, for the record:

1. **The seven authoring-lint advisories** stay TypeScript-only in this slice. Porting them is a follow-up slice.
2. **The strict switch** keeps the `WARN_REQUIREMENT_NOTHING_IMPLEMENTS` code and raises it to severity `error` behind `--require-implementers`.
3. **How a JVM or .NET test finds its witness:** a generated interface with a failing default per test; the project names one implementing class. No run-time lookup by name.
4. **Java's test framework:** generated Java and Kotlin tests are JUnit Jupiter only. A JUnit 4 project uses the renderer hook, or ejects the generator.
5. **The digest** covers subtype, level, status, statement, counterexample and the `implementedBy` list.
6. **Message text is pinned by the corpus.**
7. **TypeScript keeps its own model:** hand-filled, merged stubs.
8. **Filters: "make it uniform."** The same two options in all five ports (Table I). This is the one answer that changed the plan.
9. **Tracking:** commits cite this plan and ADR-0057.

Added after the questions were answered: the generator must eject and be owned by the application in every port; it is a recommended approach, not a contract (Table L).

# Command-line tools (per-port CLI matrix)

MetaObjects deliberately does **not** ship one universal binary. Per the CLI
architecture locked in
[`docs/superpowers/specs/2026-05-30-ts-schema-authority-consolidation-design.md`](../superpowers/specs/2026-05-30-ts-schema-authority-consolidation-design.md)
and [ADR-0015](../../spec/decisions/ADR-0015-single-shared-migrate-engine.md), the
command surface splits in two:

- **Schema is language-agnostic** — it operates on the shared canonical metadata +
  a DB connection. It lives in **one canonical Node `meta` CLI** (`migrate`,
  `verify --db`), used by any project regardless of backend language. This is the
  "Flyway/Atlas-style standalone tool" model — not re-implemented per language.

  **A non-TS adopter needs Node (or Bun) to create or evolve a database.** No
  pre-built binary is published today — releases carry no binaries, and a
  self-built single-file executable still needs the `pg` peer resolvable for the
  Postgres dialect (see the `@metaobjectsdev/cli` README). Plan for `npx meta …`
  in your build, or vendor the CLI. Shipping a real release binary is tracked as
  future work; until it exists, this doc will not claim one.
- **Codegen is inherently language-specific** (`codegen-spring` is Java,
  `codegen-ts` is TS, …) — so it runs in **each language's own build tool**. There
  is no unified codegen binary, no proxying, and no `meta-ts`/`meta-java` names.

## The matrix

| Capability | Tool | Invocation | Notes |
|---|---|---|---|
| Project scaffold (`init`) | Node `meta` | `meta init` | TS projects |
| **Agent-context scaffold** (`agent-docs`) | **Node `meta`** | `npx meta agent-docs --server <lang>` | **any backend** — single assembler (ADR-0033); non-Node CLIs redirect here |
| **Schema migrate** | **Node `meta`** | `meta migrate` | **any backend** — schema is Node-only (ADR-0015) |
| **Schema drift** (`verify --db`) | **Node `meta`** | `meta verify --db` | **any backend** — live-DB drift, Node-only |
| **Codegen drift** (`verify --codegen`) | **Node `meta`** | `meta verify --codegen` | TS reference (ADR-0021 D2) — regen-to-temp + diff committed output |
| **Template/prompt drift** (`verify --templates`) | **Node `meta`** | `meta verify --templates` | TS reference (ADR-0021 D2) — `{{field}}`↔payload; part of the bare-`verify` default |
| **Vocabulary upgrade** (`upgrade`) | **Node `meta`** | `meta upgrade [--to <version>] [--apply]` | **any backend** — rewrites RETIRED metadata vocabulary (`@violation` → `@counterexample`, `@readOnly` → `@mutability`, dropping `@verifiedBy`) and resolves ATTRIBUTE CONTRADICTIONS (`@fields` beside `@expr` on an index key). Node-only because it edits the metadata documents themselves, which every port shares; a non-TS project runs `npx meta upgrade` against its own `metaobjects/`. **Canonical JSON and YAML alike.** Previews by default. Retirements needing a human decision are refused and the run exits non-zero, so CI cannot record a partial migration as finished |
| **Vocabulary search** (`types`) | **Node `meta`** | `meta types [query]` | **any backend** — apropos/`kubectl explain` over the live metamodel registry (names + descriptions + when-to-use); the vocabulary is cross-port identical (registry-conformance) |
| **Dependency sync** (`deps`) | **Node `meta`** | `meta deps sync \| check \| list` | **any backend** — resolves a declared metadata dependency (`path`, or an installed `npm` / `python` package) into a committed snapshot + lock (FR-023), so `sync`/`check`/`list` themselves stay Node-only regardless of your server language. TypeScript, Python and Java then LOAD that snapshot at every rung of their own source ladder (Kotlin loads through Java's loader and Maven plugin); C# loads the snapshot through `dotnet meta` (Phase 2 S6). On a project whose own metadata Node `meta` cannot read (a Maven `src/main/resources/metadata` directory, a C# metadata directory, or another port's vocabulary), `sync` and `check` prove the locked dependencies load together and say that the port's own `verify` is the full check. See [`metadata-dependencies.md`](metadata-dependencies.md) |
| **Canonical format** (`fmt`) | every port | `meta fmt` / `dotnet meta fmt` / `mvn metaobjects:fmt` / `metaobjects fmt` | (#304) ships in **every** port — the canonical serializer already exists in all five, so formatting is local, not Node-only. `--check` lists non-canonical files and exits non-zero without changing anything. Formats each file STANDALONE — own-mode, declared-here layer only (ADR-0039); an `extends` onto another file's base is preserved as-is, never resolved or erred on; a file declaring `overlay: true` anywhere — whether or not a same-file base exists — is reported as skipped rather than merged (merging would drop the overlay marker, a structural change fmt never makes). A YAML file is always skipped — no canonical YAML emitter exists (ADR-0006). Before writing, every port reloads the whole project with the candidate swapped in and refuses the write unless the reloaded model's canonical form is byte-identical to the untouched baseline — fmt never changes meaning. See [Fixture corpus](#meta-fmt--canonical-formatting-304) below and `fixtures/fmt-conformance/README.md` |
| TS codegen | Node `meta` | `meta gen` | TS projects. **No `--template-spec` flag, deliberately** — `metaobjects.config.ts` already takes generator VALUES, so a declarative template generator is declared there (`templateGenerator()`, or `templateSpecToGenerators(parseTemplateSpec(spec))` to reuse a C#/Python spec file). Keeping it in the config is what lets `meta verify --codegen` regenerate WITH it, since that gate re-runs the config's generator list; see [declarative template scopes](codegen-concepts.md#declarative-template-scopes) |
| C# codegen | `dotnet meta` | `dotnet meta init` / `gen` / `verify --templates` / `verify --codegen` | a .NET tool (`ToolCommandName=dotnet-meta`); invoked `dotnet meta` so it never shadows the Node `meta`; ships the ADR-0021 D2 subverbs (`--db` rejected, exit 2; bare `verify` = `--templates` plus `--codegen` when an output directory (`csharp.outDir` in `.metaobjects/config.json`, or `--out`) and `codegen/Generators.cs` are present). **The generator list is `codegen/Generators.cs`** (ADR-0034 Amendment 9): `dotnet meta init` writes it with `codegen/Program.cs` (two lines that run it) and `codegen/Codegen.csproj`, and `gen` / `verify --codegen` always run it through `dotnet run --project codegen`. With no `codegen/Generators.cs` they exit 2 and write nothing; `--generators` only narrows the list to declared entries. Every entry may set its own output directory (`ApiDocsGenerator { OutDir = ... }`), and `verify --codegen` compares each one. A declarative Mustache template-spec (the cross-port JSON contract shared with Python) is one more entry, `TemplateSpecGenerator { Spec = "<json>", TemplateRoot = "<dir>" }`; `gen` no longer reads `--template-spec` or a project-root `template-spec.json`, and a run that finds either with no such entry fails before writing anything; see [declarative template scopes](codegen-concepts.md#declarative-template-scopes). `dotnet meta docs` was removed in 1.1.0: it prints the line that points at [the migration section](migrations/docs-are-generators.md#c) and exits 2 |
| Java/Kotlin codegen | Maven plugin | `mvn metaobjects:generate` (`metaobjects:generate`) | Kotlin generators run through the same goal — see below. **No `--template-spec` flag, deliberately** — `<generator>` already loads a consumer class from the project classpath, so the declarative surface is `com.metaobjects.generator.template.TemplateScopeGenerator` wired as an ordinary `<generator>` with `<template>` / `<scope>` / `<outputPattern>` / `<templatesDir>` / `<format>` args (covers BOTH Java and Kotlin); see [declarative template scopes](codegen-concepts.md#declarative-template-scopes). The `generate` and `verify` goals are declared `threadSafe` and support parallel multi-module reactor builds (`mvn -T`) (#233) |
| Java/Kotlin verify | Maven plugin | `mvn metaobjects:verify -Dmeta.verify.mode=codegen\|templates` (`metaobjects:verify`) | parameter-driven ADR-0021 D2 modes (one goal covers BOTH Java + Kotlin): unset (default — `codegen` and `templates`; the template gate is skipped with a note when `templateRoot` is unset) / `codegen` (regen + fail on drift vs committed output, generator-neutral) / `templates` (`{{field}}`↔payload drift via the render `Verify` engine). `db` rejected ("schema verify is the migrate engine, ADR-0015") |
| Python codegen | console-script | `metaobjects gen` / `verify --codegen` / `verify --templates` | `[project.scripts] metaobjects` — **not** `meta` (that's the Node schema CLI); ships the ADR-0021 D2 subverbs (`--db` rejected, exit 2). **The generator list is `metaobjects.config.yaml`** (ADR-0034 Amendment 9, [below](#declarative-config-metaobjectsconfigyaml--python-codegen)): `gen` and `verify --codegen` run each target's `generators` (and its `templateSpec`, the declarative Mustache template-codegen surface shared with C#) into its `outDir`, and with no config they exit 2 and write nothing. `--generators` only narrows the list to declared entries. `metaobjects docs` was removed in 1.1.0: it prints the line that points at [the migration section](migrations/docs-are-generators.md#python) and exits 2 |

## `verify` is one verb with explicit subverbs (ADR-0021 D2)

Historically `verify` meant *different things per port* (TS/C# = template drift,
Java/Python = codegen drift, `--db` = schema drift) and the modes were not
parallel. [ADR-0021 D2](../../spec/decisions/ADR-0021-codegen-surface-coherence.md)
fixes that: **`verify` is one verb with explicit subverbs**, one
vocabulary everywhere, each port implementing the modes it supports.

| Subverb | What it checks | Touches a DB? |
|---|---|---|
| `verify --db` | **Schema drift** — does the live database (or snapshot) match the metadata? (migrate engine, ADR-0015) | yes |
| `verify --codegen` | **Codegen drift** — regenerate from metadata into a temp dir and fail if it differs from the committed generated output. Catches "metadata changed but `meta gen` wasn't re-run". A hand-edited generated file is NOT drift — `meta gen` three-way-merges hand edits by design, so the gate compares the *generated contribution* against the committed `.gen-state/.hashes.json` rather than the file byte-for-byte. It still LISTS every generated file carrying a hand edit (count + paths, and how to see the edit) as a notice that does not change the exit code; `--forbid-hand-edits` makes any hand edit fail the build, for teams that want generated code untouchable (Node `meta` only). | no |
| `verify --templates` | **Template/prompt drift** — `Renderer.verify` checks each `template.*` node's `{{field}}` references against its payload VO (FR-004). A Jinja body (Python and TypeScript, ADR-0061) is checked the same way. | no |
| `verify --docs` | **Removed in 1.1.0** (ADR-0034 Amendment 9). It prints where the check went and exits 2: documentation is written by entries in `generators`, so `verify --codegen` checks it with the rest of the declared output. | — |
| `verify --deps` | **Dependency drift** (FR-023) — re-resolves each declared dependency (its `path`, or its installed `npm` / `python` package) and compares its installed artifact's hash against `.metaobjects/deps.lock.json`, same comparison as `meta deps check`. Needs the publisher reachable, so it is never part of the bare-`verify` default. A `drifted` or `unresolved` dependency fails with `ERR_DEPENDENCY_UPSTREAM_DRIFT`. **Node `meta` only.** See [`metadata-dependencies.md`](metadata-dependencies.md). | no |

Rules of the contract:

- **Combinations aggregate.** Pass any mix (`verify --db --codegen --templates`);
  each selected mode runs and the **exit code is non-zero if *any* mode reports
  drift**.
- **Bare `verify` runs the same default gate set in every port: codegen drift,
  prompt templates and the requirement ledger.** `--db`, `--deps` and `--replay`
  stay opt-in. A gate the run has no configuration for is skipped with a one-line
  note, never failed: Node `meta` needs a `metaobjects.config.ts` for codegen (a config that
  exists but fails to load is not a missing config: it exits 2 with the load error);
  `metaobjects verify` needs a `metaobjects.config.yaml` or `--prompts <dir>` for
  templates; `dotnet meta verify` needs an output directory (`csharp.outDir` in
  `.metaobjects/config.json`, or `--out <dir>`) and `codegen/Generators.cs`
  for codegen; `mvn metaobjects:verify` needs `-Dmeta.verify.templateRoot` for
  templates. Naming a subverb still runs only the gates named. Bare `verify` also
  prints a one-line note advertising the explicit subverbs. *Before this, a bare
  run covered one gate (TS/C#: templates; Java/Python: codegen), so a CI step that
  said only "run `verify`" did not catch stale generated code in TS or C#, or
  prompt drift in Python and Java.*
- **`--codegen` needs to know where the committed output lives.** It diffs
  against the configured `outDir` (and any per-target `outDir`) from
  `metaobjects.config.ts`. With no config it errors clearly (exit 2) rather than
  silently passing — there is nothing to diff against.
- **Documentation is checked as generated output, with one carve-out.** A page that a
  documentation generator (`docsFile()`, `apiDocsFile()`, `requirementsFile()`,
  `agentDocsFile()`, `metamodelDocsFile()`, `docsSiteFile()`, or an owned copy of one)
  writes is compared like any other generated file. **A page the project GIT-IGNORES is
  not checked** (carried from 1.0's `verify --docs`): a project that generates 589 pages
  and commits 2 on purpose is checked on the 2 it chose. The question is asked of the
  fresh set by name, present on disk or not, so a CI runner that has only the committed
  pages answers as the machine that generated them all; a tracked page is never reported
  ignored by git, so a committed page is always compared; a per-user ignore file does not
  count. The run says how many pages it did not check, on the pass and the fail line. A
  docs directory whose every page is ignored is not compared at all, and the run names it
  on a line of its own: a project that generates its documentation without committing it
  passes, as it did in 1.0, when `verify --codegen` never looked at documentation. When git cannot answer (not a repository, not on PATH) every page is checked, and
  the run says so.
- **Unknown/invalid flag → exit 2**, refused by name with that command's valid flags listed
  — one wording in every port's CLI (`unknown flag --x for \`meta gen\`. Valid flags: …`).
  A numeric flag given a non-number (`--limit abc`) is the same usage error.
- **Exit codes agree across the CLIs** (`meta`, `dotnet meta`, `metaobjects`): `0` success,
  including a no-op re-run; `1` a runtime failure, including metadata that does not load,
  in every command; `2` a usage error. `--version`, `-v` and `-V` print the bare version
  in each.
- **The overlay authoring lint runs on every `meta verify`, not gated on any
  subverb** (FR-023) — a top-level `(type, resolutionKey)` declared in two or more
  collection files (dependency artifacts included) where more than one declaration
  lacks `overlay: true`. Advisory only, like the anti-pattern pass below — it never
  changes the exit code — and is muted the same way: `--no-overlay-lint` or
  `META_NO_OVERLAY_LINT=1`. See [`metadata-dependencies.md`](metadata-dependencies.md).
- **The node-name authoring lint also runs on every `meta verify`.** It reports any
  named node except a requirement whose `name` contains whitespace (the ECMAScript `\s`
  class). The loader accepts these names on every port. `WARN_NAME_SURROUNDING_WHITESPACE`
  flags leading or trailing whitespace, which is almost certainly unintended: rename the
  node, and on a field pin `@column` if the physical column must keep its name.
  `WARN_NAME_INTERNAL_WHITESPACE` flags whitespace inside a name. Requirement names
  belong to the requirement lint. This lint is advisory only, appears as `names` in
  `--format json|toon`, and is muted with `--no-name-lint` or `META_NO_NAME_LINT=1`.
- **The deprecated-reference authoring lint also runs on every `meta verify`** (#305).
  `deprecated`/`replacedBy` are registered documentation common-attrs in every port, and
  this is the first thing that reads them: `WARN_DEPRECATED_REFERENCE` fires when a node
  depends on a `deprecated` node through `extends`, `@objectRef`, `@references`, or an
  origin's `@from`/`@of`/`@via`. Where the deprecated node also carries `replacedBy`, the
  finding names the replacement. A node referencing itself — a recursive FK like
  `Category.parentId -> Category`, or a same-entity passthrough — is not a finding, and
  `deprecated` inherited through the TARGET's own `extends` chain still counts. Advisory
  only, appears as `deprecations` in `--format json|toon`, and is muted with
  `--no-deprecation-lint` or `META_NO_DEPRECATION_LINT=1`.
- **The field authoring lint runs on every `verify`, in every port.** It reports two
  mistakes that load with no error. `WARN_REFERENCE_FIELD_NOT_FOUND` flags an
  `identity.reference` whose `@fields` names a field the object does not have; a field
  inherited through `extends` or added by an overlay file counts as present.
  `WARN_DUPLICATE_FIELD_NAME` flags a field name declared more than once in one object's
  `children` list; a subtype overriding an inherited field and an overlay redeclaring a
  field are not findings. This lint is advisory only and never changes the exit code. In
  the Node `meta` it appears as `fields` in `--format json|toon`. The other ports print it
  as text on stderr (Maven logs it as warnings). Mute it per port:

  | CLI | Flag | Environment |
  |---|---|---|
  | Node `meta verify` | `--no-field-lint` | `META_NO_FIELD_LINT=1` |
  | `dotnet meta verify` | `--no-field-lint` | `META_NO_FIELD_LINT=1` |
  | `mvn metaobjects:verify` | `-Dmeta.verify.noFieldLint=true` | `META_NO_FIELD_LINT=1` |
  | `metaobjects verify` | `--no-field-lint` | `META_NO_FIELD_LINT=1` |

  The codes and message text are identical in every port, gated by
  [`fixtures/field-lint-conformance/`](../../fixtures/field-lint-conformance/README.md).
- **The requirement gate runs on every `verify`, in every port**
  ([ADR-0057](../../spec/decisions/ADR-0057-requirement-checks-and-tests-in-every-port.md)).
  It is not a subverb and nothing mutes it. A model with no `requirement.*` node gets no
  line and no change to the exit code. A model with one gets the ledger summary on every
  run, and an error (a link above the floor, a dangling reference on a `live` or `partial`
  requirement, a live policy applied to nothing) exits non-zero. Unlike the lints above,
  this one can fail the build. One of its warnings can be raised to an error, per port:

  | CLI | Flag | Environment |
  |---|---|---|
  | Node `meta verify` | `--require-implementers` | `META_REQUIRE_IMPLEMENTERS=1` |
  | `dotnet meta verify` | `--require-implementers` | `META_REQUIRE_IMPLEMENTERS=1` |
  | `mvn metaobjects:verify` | `-Dmeta.verify.requireImplementers=true` | `META_REQUIRE_IMPLEMENTERS=1` |
  | `metaobjects verify` | `--require-implementers` | `META_REQUIRE_IMPLEMENTERS=1` |

  The switch reports `WARN_REQUIREMENT_NOTHING_IMPLEMENTS` (a live functional requirement
  that nothing implements) at severity `error`, under the same code, and changes no other
  finding. The codes, severities and message text are identical in every port, gated by
  [`fixtures/requirement-check-conformance/`](../../fixtures/requirement-check-conformance/README.md).
  The seven requirement *authoring-lint* advisories are still printed by the Node `meta`
  only. See [requirements.md](requirements.md#the-gate-in-every-port).

### The prompt directory: `--prompts` everywhere (F101)

`verify --templates` selects the gate; the DIRECTORY it resolves `template.*` refs against is
**`--prompts <dir>`** on every port. It used to be spelled three ways, which is the kind of
divergence that costs a polyglot adopter an afternoon:

| Port | Converged (use this) | Still accepted | Notes |
|---|---|---|---|
| Node `meta` | `--prompts <dir>` | — | the reference; always spelled this way |
| `metaobjects` (Python) | `--prompts <dir>` | `--templates-root <dir>` | alias, deprecated in 1.1 |
| `dotnet meta` (C#) | `--prompts <dir>` | `--templates <root>` (inline value) | alias, deprecated in 1.1 |

The old spellings **keep working**. The 1.0 CLI surface is frozen, so adding a spelling is
additive and a patch may do it; REMOVING one is a major event. They are deprecated in 1.1 and
removed no earlier than a major — an adopter's scripts do not break at a patch or a minor.

Why `--prompts` won rather than the majority spelling: `--templates` is already the subverb's
name on all three ports, and a flag that both selects a gate and carries its argument is the
part people get wrong. On C# `--prompts` sets the directory only — it does not imply the gate,
exactly as `--out` does not imply `--codegen`.

**And when you name no directory at all, `prompts/` is what every port that HAS a
default looks for first** (1.0.5). The Node CLI has always defaulted to `prompts`; `dotnet meta gen` and
`metaobjects gen` defaulted to `templates`, so a project laid out the way the Node CLI
describes had a `gen` looking somewhere its bodies were not — the `render-helper` generator
silently resolving refs against a directory that did not exist. The rule is now
`prompts/` **if that directory exists**, else `templates/`.

A FALLBACK, never a flip: `prompts/` has to be there before it wins, so a project whose
bodies live in `templates/` resolves exactly where it always did. That is what makes the
correction shippable in a PATCH — flipping outright would move where an existing project's
refs come from, and it would fail by finding nothing rather than by saying so. The Maven
plugin is unaffected: it has no default and refuses without an explicit `<templateRoot>`,
which is a stricter answer to the same question and stays as it is.

**Port status (staged per ADR-0021):** the **TypeScript Node `meta` is the
reference** and implements all three subverbs today. **Python `metaobjects`
ships the subverbs**: `verify --codegen` (regen-to-temp + diff vs `--out`), `verify --templates` (each `template.*` node's `{{field}}`
↔ payload-VO field tree via the render `verify()` gate, resolving refs through a
filesystem provider rooted at `--prompts`), and `verify --db` which is
**cleanly rejected with exit 2** ("schema verify is the migrate engine,
ADR-0015"). Bare `verify` runs `--codegen` and `--templates` (the template gate is skipped
with a note when the run names no config and no `--prompts`). The **C# `dotnet
meta`** port likewise ships the codegen-side subverbs: `verify --templates` (its
historical template/prompt drift gate), `verify
--codegen` (regenerate the configured generators to a temp dir and diff against
the committed `--out` tree, never touching it), and a **clean `--db` rejection
(exit 2)** — bare `dotnet meta verify` runs `--templates` and, when an output
directory and `codegen/Generators.cs` are present, `--codegen`. The output directory is
`csharp.outDir` in `.metaobjects/config.json` (the same setting `gen` writes to); `--out <dir>`
wins over it. With neither, the codegen gate is skipped with a note that names the setting. A bare run prints the subverb note. The **Java/Kotlin `mvn metaobjects:verify`** port expresses the same vocabulary as a
`mode` parameter (Maven goals are parameter-driven, not flag-driven). With `mode` unset the goal
runs both gates below, skipping the template gate with a note when no `templateRoot` is set.
`-Dmeta.verify.mode=codegen`
(codegen only, byte-identical to the historical goal — regen-to-temp + diff vs committed
output; drift is computed per **unique `outputDir`** over the whole `<generators>`
selection, so several generators may share one `outputDir` without cross-flagging each
other's committed files as stale) and `-Dmeta.verify.mode=templates` (each `template.*` node's `{{field}}`↔payload-VO
field tree via the render `Verify` engine, resolving refs through a filesystem provider rooted
at `-Dmeta.verify.templateRoot`). The one goal covers BOTH Java (`codegen-spring`) and Kotlin
(`codegen-kotlin`) since they share it. `mode=db` is **cleanly rejected** ("schema verify is the
migrate engine, ADR-0015"); an unknown mode fails listing the valid ones. (Schema `--db` remains
Node-only by the ADR-0015 design — see below.)

## Owned generators: the unchanged-copy notice, `eject --undo`, and `gen --strict`

You are expected to own generators, but not to carry a copy that never changed. An ejected copy
that is still the shipped reference stays at the release it was copied from, so `gen` names
those copies in one line and a flag takes them back. A copy you changed is never touched
unless you name it and pass the force flag.

| Port | Notice | Take unchanged copies back | Unknown attribute in `gen` |
| --- | --- | --- | --- |
| TypeScript | `meta gen` | `meta eject --undo [<name>...] [--force]` | warns; `meta gen --strict` is an error |
| Python | `metaobjects gen` | `metaobjects eject --undo [<name>...] [--force]` | warns; `metaobjects gen --strict` is an error |
| Java / Kotlin | `metaobjects:generate` | `mvn metaobjects:eject -Dundo=true [-Dnames=a,b] [-Dforce=true]` | already an error (as `verify`); `-Dmeta.lax=true` relaxes both goals |
| C# | `dotnet meta gen` | `dotnet meta eject --undo [<name>...] [--force]` | warns; `dotnet meta gen --strict` is an error |

Undo with no names removes every copy that is the shipped reference; with names, any named copy
that differs refuses the whole call and removes nothing. It never edits your generator list
(`metaobjects.config.ts`, `codegen/Generators.cs`, `pom.xml`, `metaobjects.config.yaml`): it prints the
edit that points each entry back at the shipped generator. `--strict` exits 1 and writes
nothing. No port has a `doctor` command: `eject --list` (or the matching goal) is the report.

## `gen` refuses rather than guesses — and `--baseline` is how you answer it

Every port's `gen` decides per file whether it may overwrite, from a committed hash
manifest (`.metaobjects/.gen-state/.hashes.json`). A file that still hashes to what the
generator recorded writing is safe to overwrite; one that was edited, or that no record
covers, is **refused by name and left exactly as it is**.

**A refusal fails the run — exit 1 — on every port.** TypeScript has always done this;
Python and C# printed the warning and exited 0 until 1.0, so an adopter who wired `gen`
into CI as a drift gate was green while codegen was refusing to write. If a build starts
failing on this at 1.0, it was already not protecting anything; the remedy below is the
one-time fix.

| flag | ports | what it does |
|---|---|---|
| `--baseline=default` | all | the above: refuse what cannot be proved to be generated output |
| `--baseline=adopt` | TS · Python · C# | record the files you HAVE as the merge base and **write nothing** |
| `--baseline=fresh` | TS only | overwrite the refused files from fresh output and re-baseline (**discards** hand edits). A local snapshot body for a path the manifest has no record of is ignored, not merged against, so stale content from an earlier checkout is not kept as a hand edit |

`--baseline` answers for one run. To decide once, per generator, set `handEdits` on its
entry instead:

| setting | ports | what it does |
|---|---|---|
| `handEdits: keep` | all | the default: an edited generated file is refused, and so is an edited file no generator emits any more |
| `handEdits: overwrite` | all | replace that generator's edited files with fresh output and re-baseline them; the orphan sweep deletes an edited file no generator emits any more when every generator writing into its directory overwrites. Each discarded file is named. A file the manifest has no record of is still refused |

| | `--baseline=fresh` | `handEdits: overwrite` |
|---|---|---|
| scope | one run, every generator | every run, one generator |
| a file with no manifest record | overwritten | refused |
| an edited orphan | untouched | deleted (when the whole directory overwrites) |
| `verify --codegen` | not affected | reports the edit as drift that `gen` fixes |

Syntax per port, and the orphan rule both follow:
[own-your-codegen](own-your-codegen.md#handedits-keep-or-discard-edits-to-one-generators-files).

**`adopt` exists because the refusal's own remedy was unreachable.** It told you to commit
`.hashes.json` — but nothing writes a manifest until a `gen` succeeds, and a run where
every file refuses writes none, so there was nothing to commit and the next run refused
identically. `adopt` breaks that loop: it records what is on disk, writes not one byte of
output, and leaves exactly one file to commit. Then `gen` again, and the regeneration
arrives as its own reviewable diff.

**What adopting declares** — say this out loud before running it: that the files you have
*are* generated output. It protects edits made from that point on, because they finally
have a base to merge against. An edit already inside one of those files becomes part of
the base, so the next `gen` will replace it. Commit first, then read that second diff.
Where the edit is the point, the sequence that keeps it is in
[own-your-codegen](own-your-codegen.md#recovering-a-refused-file-on-a-machine-that-never-generated-it),
and it needs `--baseline=fresh` (TypeScript). Python and C# implement `default` and
`adopt` only; there, discard a refused file by deleting it and re-running, which writes it
as new.

## The documentation generators — and the `agent/` pages

Documentation is written by `meta gen`, from entries in `generators`, like code
(ADR-0034 Amendment 9; `meta docs` was removed in 1.1.0 and prints where its work went).
Nothing is written that the list does not declare. Each factory below comes from
`@metaobjectsdev/codegen-ts/generators` and writes to the target named `docs` unless given
`target`; a run that lists one while `targets` declares no `docs` is refused by name, so
documentation never lands in the code's output directory by default.

| Generator | Factory | What it writes |
|---|---|---|
| `docs` | `docsFile()` | The NEUTRAL per-entity + per-template pages plus a README index, with the ER diagrams. Makes no language assumption at all (ADR-0020). |
| `api-docs` | `apiDocsFile()` | The generated SDK reference under `api/` — types, endpoints, filter operators — plus `AGENT-API.md`, its condensed agent form. |
| `requirements` | `requirementsFile()` | The declared ledger, as `requirements.md` + `requirements.toon`; nothing for a model with no `requirement.*` node. |
| `agent-docs` | `agentDocsFile()` | Three pages an agent reads BEFORE touching a tier (below), under `agent/`. |
| `metamodel-docs` | `metamodelDocsFile()` | The reference of the BUILT-IN metamodel (every registered type, subtype and attribute), not your model, under `metamodel/`. Its rendered form is published at <https://metaobjects.dev/reference>. |
| `docs-site` | `docsSiteFile()` | The HTML site under `site/`; `meta eject docs-site` copies its templates and assets to `codegen/docs-site/` for you to change. |

```ts
targets: { docs: { outDir: "./docs/generated" } },
generators: [entityFile(), routesFile(), docsFile(), apiDocsFile(), agentDocsFile()],
```

`meta gen --generators docs,api-docs,agent-docs` writes only those entries; a name the config
does not declare is refused. Every one but `docs-site` can be replaced by a copy you own
(`meta eject <name>`), listed in `generators` in place of the factory. See
[own-your-codegen](own-your-codegen.md#the-docs-generators-are-generators-like-the-rest). A
config that fails to load stops `meta gen`: the load error, exit 2, nothing written.

The model pages and the api reference link to each other from what the list declares: the
runner reads the directory each `apiDocsFile()` writes to and whether `docsFile()` is listed,
per target, and hands both to every generator (`ctx.docs`). `docsFile({ apiSurfaces })` names
api pages that live somewhere else, another port's for instance, each with its `baseUrl`.

### The `agent/` surface

- **`agent/schema.md`** — before touching persistence. Per table: the column, the FIELD
  that declared it, the declared type, the dialect SQL type, nullability, default and key
  role; then indexes, foreign keys and checks; then views with their `origin.*` lineage,
  relationships, and enums with their member sets. It **cites the migrations rather than
  restating the DDL** — the migration files are the DDL, they are generated, and a page
  that reproduces `CREATE TABLE` is a second spelling that goes stale.
- **`agent/ui.md`** — before touching a form or a grid. Per field: the control the form
  renders, label, HTML type, rules, form-excluded, and what the LIST endpoint accepts for
  filtering and sorting; plus each declared `layout.dataGrid`. The endpoint under each
  object is the FULL address the routes mount it at — `apiPrefix` included — and it agrees
  with the object's own `$path`, because `$path` IS that address: a TPH subtype is served
  under its discriminator base, so `Car.$path` is `/vehicles/car`, never `/cars`.
- **`agent/requirements.md`** — before adding a capability. The ledger plus a **node
  index**: every claimed node → the requirements claiming it, at every grain, with the
  literal FQN on every line.

Two properties worth knowing:

**Every page is derived from a builder that already exists**, and none has a derivation of
its own. The schema page reads the expected-schema snapshot `meta migrate` diffs and emits
from; the UI page reads the same descriptor emitted as the `<Entity>` const that
`useEntityForm` consumes at runtime; the requirements page reads the same walk the ledger
surface and the generated test stubs are built on. A page an agent is told to trust has to
be true, and this is the only way to keep three more of them true.

**An empty page is no file.** Each renders nothing when its tier has nothing to describe —
no physical schema, no generated UI, no ledger — so a project sees only the pages it has
content for, and one with none sees no `agent/` directory at all.

Physical names, the dialect and view dispatch all come from `metaobjects.config.ts`, which
`meta gen` always has. The neutral model pages make no use of them and stay neutral. `agent/schema.md` asks the same
guard `meta gen` does — a model that emits database code must declare a `dialect`, and
`DEFAULT_DIALECT` is inert — so the page is skipped, with the runner's own message, exactly
when `meta gen` would refuse the model, and also when the expected schema cannot be built at
all (a primary-key move, a duplicate physical name: conditions `meta migrate` reports
properly, and docs must not be the command that fails on them).

`meta verify --codegen` (above) is what keeps the committed pages honest, including the
skips: a generated page committed in `agent/` that a fresh run no longer writes (the
previous schema's `agent/schema.md`, say) is reported as drift, so a skip cannot leave a
stale page in place, green. A hand-written file in the docs directory is left alone.

## Declarative config (`metaobjects.config.yaml`) — Python codegen

The Python `metaobjects` CLI reads its generator list from a declarative project config,
`metaobjects.config.yaml` (#267; since 1.1.0 the only list, ADR-0034 Amendment 9). Its
**`targets` registry uses the TS `metaobjects.config.ts` vocabulary** (named targets, each
with its own `outDir`) — a polyglot adopter learns one targets-registry shape regardless of
port. The keys are not identical beyond that: a Python target carries its own `generators`,
`entities` and `templateSpec`, and `requirementTests` and `apiDocs` are blocks that exist only
here, where TypeScript passes those generators' options in code. A JSON Schema ships at
[`server/python/src/metaobjects/codegen/metaobjects-config.schema.json`](../../server/python/src/metaobjects/codegen/metaobjects-config.schema.json)
for editor autocomplete and non-Python validation.

```yaml
metadata: metaobjects            # optional, default "metaobjects" — relative to this file
providers:                       # optional; "module:symbol" refs, resolved config-relative (no PYTHONPATH=)
  - my_project.providers:register_custom_types
libraries: [ai]                  # optional; MetaObjects-shipped library packages (see below)
requirementTests:                # optional; options of the `requirement-tests` generator, every key optional
  witnessModule: tests.requirement_witnesses   # the default
  grain: concern                 # or: member
  filter: codegen.requirement_hooks:include    # "module:symbol", resolved config-relative
  renderer: codegen.requirement_hooks:render   # "module:symbol", resolved config-relative
  warnUncovered: true            # the default
templates: prompts               # optional; where template refs resolve from (default prompts/, else templates/)
apiDocs:                         # optional; options of the `api-docs` generator, every key optional
  apiSubDir: api/python          # the default
  projectName: shop              # default "project"
  modelBaseUrl: https://docs.example.com/model
targets:
  api:
    outDir: src/generated/api
    generators: [entity, filter-allowlist, routes]   # stable names from `metaobjects gen --list`,
                                 # or an owned copy as "module:symbol". Nothing runs that is not listed.
  admin:
    outDir: src/generated/admin
    generators: [entity]
    entities: [Author, Book]     # optional allowlist; omit = every entity
  docs:
    outDir: docs/python          # a directory of its own: another port's pages here read as drift
    generators: [api-docs]       # the api reference is an entry like any other
    templateSpec: template-spec.json   # optional; a declarative template-spec, relative to this file
```

- **`metaobjects gen`** loads the config and metadata once and runs every target into its
  own `outDir`, with a cross-target guard against two targets writing the same output path.
  `--target <name>` scopes the run to a single target; `--generators <names>` narrows it to
  the declared entries named (an owned entry matches its registry name too) and refuses a
  name no target declares. A target whose `generators` is empty writes nothing and says so.
- **`metaobjects verify --codegen`** — also run by bare `verify`, which adds `--templates`
  (see above) — regenerates the same list into a temp tree (the exact `gen`
  pipeline, including the cross-target duplicate-output-path guard) and diffs each **unique
  `outDir`** against the union of the co-resident targets' regen, aggregating the exit code
  (non-zero if *any* outDir has drifted). Targets sharing an `outDir` are verified together,
  so a shared `outDir` is never a false-positive `extra`. `--target` widens to the
  `outDir`-sharing closure (an `outDir` is verified as a unit). Strict-attr loading
  (ADR-0023) still applies unless `--lax` is passed.
- **`--config <path>`** picks the config file explicitly on either command; without it both
  look for `./metaobjects.config.yaml` in the current directory. **No config is an error**:
  `gen` and `verify --codegen` print `no metaobjects.config.yaml`, exit 2 and write nothing.
- **Run options still apply to the list:** `--entities` (narrows each target's entities),
  `--provider` (added to `providers`), `--templates` (`--prompts` on `verify`), `--baseline`.
  Column naming is not a run option: it is `naming` in `.metaobjects/config.json`, which every
  port reads, and `--column-naming` is refused
  ([physical-naming.md](migrations/physical-naming.md)).
- **Providers resolve config-relative.** A `providers:` entry is imported
  with the config file's own directory prepended to `sys.path`, so a
  consumer provider module living beside the config resolves with no
  `PYTHONPATH=` needed (unlike `--provider module:symbol`, which relies on the ambient
  environment).
- **Not read since 1.1.0.** The positional `<metadata_dir>` and `--out` of `gen` (and `--out`
  of `verify --codegen`) are refused with a line naming `metadata` and the targets' `outDir`;
  `--template-spec` is refused in favour of a target's `templateSpec`; a top-level `docs`
  block fails `gen` with `found 1.0 docs configuration`. See
  [the migration section](migrations/docs-are-generators.md#python).

## `libraries` — opting into a MetaObjects-shipped library package

MetaObjects ships a small set of declared designs under `library/` — see
[libraries.md](libraries.md) for what they are and how to adapt one. A project opts into
one by name, and its nodes become available to `extends`:

```jsonc
// .metaobjects/config.json  — the port-neutral file, beside `dependencies`
{ "schema_version": 1, "sources": [], "libraries": ["ai"] }
```

```yaml
# metaobjects.config.yaml  (Python `metaobjects`)
libraries: [ai]
```

```jsonc
// then, in your own metadata
{ "object.entity": { "name": "AgentCall", "extends": "metaobjects::ai::LlmCallBase", ... } }
```

- **A LAYER at a time.** A token is `<library>` or `<library>/<layer>`; the bare name is
  the CORE layer, which declares no `source.rdb` and therefore adds **no tables and no
  generated code**. `"ai/db"` adds the persistence layer and IMPLIES `"ai"` (a db layer
  is nothing but `overlay: true` redeclarations, so without its base it would be
  `ERR_OVERLAY_NO_TARGET`). A token whose LAYER is unknown is dropped WHOLE rather than
  reduced to its core — implying the core from a mistyped `ai/database` would hand you
  an inert core and no tables, with no diagnostic.
- **It lives in `.metaobjects/config.json`**, not in `metaobjects.config.ts`. Which
  designs a project adopts is a fact about the PROJECT, not about how one port generates
  code from it; that file is the port-neutral one every port already reads. A config
  still carrying the old key gets a pointed error rather than silence.
- **Opt-in, never automatic.** A library package registers real top-level nodes. A project
  that never references one should not find them in its model, its generated output or its
  docs — so nothing is loaded until the key names it.
- **An unknown name is a hard config error** that lists the packages this version ships.
  The programmatic loader API skips an unrecognised package instead, deliberately: an API
  caller asking for something a given version does not ship should still be able to load
  its own metadata, but a name a human typed into a config file is a mistake worth failing
  on — skipped, it resurfaces later as `ERR_UNRESOLVED_SUPER` pointing at the adopter's own
  metadata, which is the wrong place to send someone looking.
- **Every command that loads metadata honours it** — `gen`, `verify`, `docs`, `migrate`,
  `prompt-snapshot`. It was previously reachable only from the programmatic
  `MetaDataLoader.fromDirectory`, which no CLI uses, so a generator that consumes a library
  was registered *for* the command line while its input was unreachable *through* it
  ([#333](https://github.com/metaobjectsdev/metaobjects/issues/333)).

On the JVM the same opt-in is a pom element, read by `metaobjects:generate` and
`metaobjects:verify`:

```xml
<loader>
  <name>my-model</name>
  <libraries><library>ai</library></libraries>
</loader>
```

and programmatically, `MetaDataLoader.fromDirectory(name, dir, opts, List.of("ai"))` or
`loader.setLibraries(List.of("ai"))` before `init()`. Java had neither the option nor an
embed until [#332](https://github.com/metaobjectsdev/metaobjects/issues/332): the port
shipped `LlmTraceHelperGenerator` with no way to load the metadata that generator exists to
consume, and its tests stayed green only by declaring a bespoke `LlmCallBase` inline under
a different package — the bypass ADR-0024 already named, and the reason a port can ship a
generator it cannot feed without anyone noticing.

On C# the opt-in is loader-only — `MetaDataLoader.FromDirectory(dir, new[] { "ai" })` — because
the `dotnet meta` CLI has no project-config file to carry a key. All five ports resolve
`metaobjects::ai::LlmCallBase`; three of them (Node `meta`, Python `metaobjects`, Maven) expose
it declaratively.

### `meta eject <library>` — taking the metadata to own

`meta eject` takes generator names AND library names. A library ejects every layer into
your first DECLARED source root (resolved through `sources`, never a hard-coded
directory) as `meta.<library>.<file>.yaml`, each stamped with a provenance header, and
never overwrites without `--force`. It does not edit your config.

**One step remains, and the loader enforces it**: remove the library from `libraries`.
Left there, the shipped tree and your copy both load and merge asymmetrically —
additions take effect, deletions do not — so the load is refused with
`ERR_LIBRARY_PACKAGE_COLLISION`. Its mirror, `ERR_LIBRARY_PACKAGE_NOT_OWNED`, fires on a
NEW node declared into a library's package while the library is opted in; an
`overlay: true` amendment of one of its own nodes is the documented door and is
untouched.

`meta eject --list` reports, per ejected library, `identical` or `differs` against the
shipped tree with counts changed / only-upstream / only-yours — the same staleness
report it gives for owned generators, one level up.

## `meta gen` / `meta verify` run an advisory anti-pattern pass (Node `meta`)

Both `meta verify` and a real `meta gen` write run (not `--dry-run`) end with a
**"verify-as-teacher"** advisory scan over your authored source. It flags a few
high-precision constructs you hand-rolled that the metadata could model and names
the construct that replaces it:

| Hand-rolled pattern | Suggested construct |
|---|---|
| an aggregate computed by hand (SQL `AVG`/`SUM`, a summing `.reduce(...)`) | For grouped, served or reported figures: `object.report` (dimensions + measures, read-only list route). For a per-row figure on one entity: `object.projection` with `origin.aggregate` and a generated query. |
| money as a float / hand-rolled minor units (a money-named field with `* 100`, `/ 100`, `.toFixed(2)`, `parseFloat`) | `field.currency` |
| a fixed value set enforced by a SQL `CHECK (... IN (...))` | `field.enum` |

It is **warnings only** — it never changes the exit code (bias to under-flagging;
a >15% false-positive rate is a project kill criterion). This pass is
**Node-`meta`-specific**; the C#/Java/Kotlin/Python codegen surfaces do not run it.

#### Quieting it — two tools, and they are not interchangeable

Reach for the narrow one first. Turning the whole scan off to silence one directory
is how a useful advisory stops being read at all.

| You want to | Use |
|---|---|
| skip a directory whose files you cannot act on | `verify: { antiPatternIgnore: [...] }` in `metaobjects.config.ts` |
| turn the scan off for a run | `--no-antipatterns`, or `META_NO_ANTIPATTERNS=1` |

```ts
// metaobjects.config.ts
export default defineConfig({
  // ...
  verify: { antiPatternIgnore: ["db/changelog/**", "vendor/sql/**"] },
});
```

Path globs relative to the project root; `**` spans separators, and a glob matching
a directory prunes the whole subtree. Declared globs **add** to the built-ins.

**Immutable migration files are already excluded and need no config.** A Flyway
`V001__…sql` / `U001__…sql`, a timestamped `20240115120000_add_users.sql`, a
zero-padded `0000_init.sql`, an `up.sql`/`down.sql` pair, and the `db/migration`
and `migrations` directories are all skipped wherever they live — because those
files are checksummed by the tool that applied them, so a finding on one can never
be acted on. Flyway **repeatable** (`R__`) scripts are deliberately *not* in that
set: Flyway re-applies one when its checksum changes, so editing it is the
sanctioned workflow and a finding on it is actionable.

### Reading the whole report

**Text output caps each advisory section at 20 lines** and then says how many it
held back. That cap exists to spare a terminal, and it is one shared value, not one
per section — raise it with **`--limit <n>`**, or remove it with **`--limit all`**,
on both commands.

**A structured run is never capped.** `--format json` / `--format toon` carry
*every* finding, with its `file`, `line`, `rule`, `construct` and `message`, plus
the total:

```
meta gen --format json      → { gen[], summary, help[], antiPatterns: { status, total, rows[] },
                                warnings[]? }
meta verify --format json   → { verify[], exitCode, summary, help[],
                                antiPatterns: { status, total, rows[] },
                                requirements: { status, total, rows[] },
                                requirementCounts?, schemaDrift?, notRepresented[] }
```

A pass that did **not** run says so (`status: "skipped"` with a `note` giving the
reason) rather than reporting an empty list — "found nothing" and "never looked"
are different answers. `meta verify`'s payload carries each gate's pass/fail
verdict. The schema gate's differences are in `schemaDrift` (`changes[]`, one
`{ kind, object, detail }` per difference with the same explanation the text prints,
plus the ledger `findings[]`); every other gate's drift **detail** stays on stderr as
text, and the payload's own `notRepresented[]` says so. A view that matches the
metadata and is recreated only because the migration alters a table it reads is not
drift, so it appears in neither. `meta migrate` still emits that drop/create pair and
names the views in a note (`notes[]` in its structured output).

`meta gen`'s `warnings[]` carries **every warning the run printed**, in the order it
printed them: the runner's own (a generator that emitted nothing, an unsatisfied
`requires`, a hand-edited file it refused), a generator's `ctx.warn`, an unknown
attribute, and the CLI's advisories about a stale agent context or an ignored hash
manifest. The key is absent on a run that printed none. A generator named in
`generators` by a stable name that was removed (`"mermaid-er"`) is refused with a message
saying what replaced it (`docsFile()` draws the ER diagram).

In a structured run every narration line moves to **stderr**, so stdout is one
parseable document. `--format` is honored by `gen`, `verify` and `migrate`; any
other command prints text and says so if you pass it. There is no `--json` flag —
`--format json` is the one spelling.

## `meta upgrade` — retired vocabulary, not schema

Deliberately **not** a `migrate` subverb. `migrate` owns database schema and is the most
destructive command in the toolchain; overloading it with a metadata rewrite would make
"what does this touch?" ambiguous at exactly the wrong moment.

It **cannot load the metadata, and does not try**. Once vocabulary is deregistered, metadata
carrying it fails the load — which is the state this command exists to repair. So it reads
each file's raw text and replaces spans, which is also what keeps JSONC comments and key
order intact; a parse-and-reprint would destroy both while reporting success.

Four properties worth knowing before you wire it into CI:

- **Dry-run by default.** `--apply` writes. `--to <version>` bounds which changes apply.
- **It refuses what needs a decision, and exits non-zero.** `@status: abandoned` can be
  resolved by deleting the node, retyping it, or fixing the residue it describes — a guess
  would emit metadata that *loads* and means something else, which is worse than refusing
  because you would believe the migration finished. The non-zero exit stands even when every
  mechanical change succeeded, so a pipeline cannot record a partial upgrade as complete.
- **JSON and YAML alike.** Both authoring forms ([ADR-0006](../../spec/decisions/ADR-0006-ai-first-yaml-authoring.md))
  are rewritten, by two arms that make the same guarantees: the JSON arm matches key spans
  directly, the YAML arm locates them with a parser and still edits by span, so neither
  reprints your file. A YAML document that does not **parse** is named as NOT CHECKED and
  gets its own exit code (3), because a fixer reporting a file it could not open as clean is
  worse than one that fails.
- **It fixes contradictions, not only retirements.** Some metadata stops loading because two
  *live* attributes may no longer sit together. `@fields` beside `@expr` on an
  `index.lookup` or an `identity.secondary` is the case that exists today
  ([#342](https://github.com/metaobjectsdev/metaobjects/issues/342)): an index keys off
  plain columns or a key expression, never both. `upgrade` drops `@fields`, and that is not
  a coin toss — the pair used to load with `@fields` **silently discarded**, so the index in
  your database is already the expression one and dropping it changes no emitted DDL.

## `meta fmt` — canonical formatting (#304)

Every port already ships the canonical serializer the cross-port conformance
corpora byte-match against — that is what the five `expected.json` fixtures
under `fixtures/conformance/` prove on every run. `fmt` just surfaces it as a
command, in the `gofmt`/`buf format` tradition: one canonical form, no
formatting debate, usable as a CI gate via `--check`.

| Port | Command |
|---|---|
| Node `meta` (reference) | `meta fmt [<file>...] [--check]` |
| C# | `dotnet meta fmt [<file>...] [--check]` |
| Java / Kotlin | `mvn metaobjects:fmt [-Dmeta.fmt.check=true] [-Dmeta.fmt.files=<csv>]` |
| Python | `metaobjects fmt [<file>...] [--check]` |

**Files.** The metadata files the project's resolved sources contain — each
port's own source/collection resolution (Node: `resolveCollection()` in
`@metaobjectsdev/sdk`; never a hardcoded `metaobjects/`). Optional explicit
file arguments narrow the run to those files, which must be members of the
resolved set.

**Per file, standalone — own-mode, declared-here layer only (ADR-0039).**
`fmt` never merges a file with its siblings to format it. Two things follow:

- An `extends` onto a base declared in ANOTHER file is preserved exactly as
  written — never resolved, and never an error here (resolving `extends` is
  the full project loader's job, not the formatter's; own-mode serialization
  only needs the raw ref string).
- A file declaring `overlay: true` ANYWHERE in its tree is reported as
  **skipped**, not only when no base exists in the same file. A formatter
  never changes structure: a plain declaration and a same-(type,name)
  `overlay: true` redeclaration in the SAME file DOES have a local base to
  merge into, and the ordinary loader would merge them — but doing that
  silently drops the overlay marker from the output, which is a structural
  change `fmt` must never make. So every port checks the raw document for
  `overlay: true` before attempting anything, independent of whether a
  local base is present; `ERR_OVERLAY_NO_TARGET` (raised when one is not)
  is a defensive second signal, not the only one. A file mixing a plain
  declaration with an overlay anywhere is skipped WHOLE — `fmt` never
  partially formats a file. This is the concrete shape of "overlay files
  stay overlays": `fmt` leaves them untouched rather than attempt a
  reconstruction — merged or not — it cannot prove preserves structure.

**YAML is left untouched.** The canonical interchange form is JSON
([ADR-0006](../../spec/decisions/ADR-0006-ai-first-yaml-authoring.md)); no
port ships a canonical YAML emitter that round-trips today. A `.yaml`/`.yml`
file is always reported as skipped, never converted to JSON.

**Safety: fmt never changes meaning.** Before writing a file, every port
reloads the WHOLE project with that file's candidate content substituted in
and requires both that it loads with no errors and that the reloaded model's
canonical serialization is byte-identical to the untouched baseline. A file
that fails this check is left exactly as it was and reported as an error —
never partially written, never silently corrupted. `--check` runs the exact
same decision and never writes anything, successful or not. TS, C# and Python
substitute the candidate via an in-memory source, never touching disk until
the check passes; the Java/Kotlin Maven goal writes the candidate, reloads,
and reverts the write immediately if the check fails (or always, under
`-Dmeta.fmt.check=true`) — a different mechanism, the identical guarantee.

**Per-port surface differences (documented, not gaps).** Every port shares the
single-file formatting contract and the safety check; the CLI SURFACE varies
exactly as each port's existing `gen`/`verify` surface already does:

- **C#** takes the same optional `<metadataDir>` positional `gen`/`verify`/`docs`
  do (falling back to the `.metaobjects/config.json` ladder) rather than a list
  of individual files — this port's loader has always resolved a directory, not
  a file set, and `fmt` does not add a second kind of positional. The narrowing
  capability exists in `FmtCommand.Run`'s `explicitFiles` parameter for an
  embedder, just not on the CLI.
- **Java/Kotlin** takes Maven parameters, not flags: `-Dmeta.fmt.check=true` /
  `-Dmeta.fmt.files=<csv>`, mirroring `-Dmeta.verify.mode`. It inherits the
  Mojo-wide `-Dmeta.lax` convention `gen`/`verify` already use: strict by
  default (an unregistered type/subtype or `@attr` fails the standalone
  per-file parse too), `-Dmeta.lax=true` to relax it, rather than the lenient
  default the other three ports chose for `fmt` specifically. One goal covers
  BOTH Java and Kotlin: `fmt` only ever touches metadata files, which carry no
  per-language distinction, so there is nothing Kotlin-specific to add.
- **Python** mirrors the Node reference exactly: `metaobjects fmt [<file>...] [--check]`.

**Fixture corpus.** `fixtures/fmt-conformance/` (see its README) pins the
single-file contract above across all five ports: given one file's raw
content, every port must produce the same canonical bytes, or classify the
same refusal (`"overlay"` vs `"error"`). Each port's own test suite runs it,
the same way `fixtures/conformance/` gates the loader.

## Schema is Node-only — by design

No port other than the Node `meta` exposes `migrate` or `verify --db`. The C#,
Java, Python, and Kotlin command surfaces are **codegen only** (`gen` + codegen
`verify`). The Java port's former `metaobjects:migrate` / live-DB `metaobjects:verify` Maven
goals and the C#/Python migrate surfaces were removed in the schema-authority
consolidation; the only schema entry point anywhere is the Node `meta`.

## Migration output formats (`--migration-format`)

The engine generates the up/down SQL **once**; a pluggable output adapter decides
the file envelope ([ADR-0015](../../spec/decisions/ADR-0015-single-shared-migrate-engine.md) §3).
The format is **orthogonal to dialect** — a Flyway shop is still on postgres or
sqlite — so it is its own flag:

| Format | Layout | Selected by |
|---|---|---|
| `default` | `<ts>-<slug>/up.sql` + `down.sql` | default |
| D1/Wrangler | `<seq>_<slug>.sql` + `.down/<same>` | `--dialect d1` |
| `flyway` | `V<N>__<slug>.sql` + `U<N>__<slug>.sql` | `--migration-format flyway` |

**Why `--migration-format` and not `--format`:** `--format` is already the global
output-rendering flag (`toon` / `json` / `text`). The config key, being namespaced
under `migrate`, has no such clash — set `migrate.format` once in
`.metaobjects/config.json` and a JVM shop never passes the flag. The flag wins
over the config key.

**Flyway specifics (#192).** This is the adapter ADR-0015 designated when the Java
`meta:migrate --flyway` mojo was removed. Versions are assigned by scanning the
target dir for the highest `V<N>__` and incrementing, so it composes with
hand-authored migrations already present; a dotted version (`V10.5__`) increments
on its leading integer. The down SQL is emitted as `U<N>__` — Flyway's own undo
convention. Undo is a paid Flyway edition feature and **Community ignores `U__`
files** rather than failing, so they are inert-but-correct there and become live on
Teams/Enterprise. Output dir defaults to Flyway's convention
`src/main/resources/db/migration`; `--out-dir` overrides it.

**Flyway owns apply.** `--apply`, `apply-pending` and `--rollback` are **refused**
under this format, each naming the Flyway command instead: writing behind Flyway
desyncs its `flyway_schema_history`. Generate with `meta migrate`, apply with
`flyway migrate`. `--dialect d1` with `--migration-format flyway` is also refused —
D1 has its own Wrangler layout and transport.

**Flyway owns `flyway_schema_history`.** Under this format the table is left out of every
schema comparison: `meta migrate` (live with `--from-db`, and a committed snapshot that
records it), `meta verify --db`, and the "now migrate" next step `meta gen` prints.
`meta verify` takes the same `--migration-format` flag with the same precedence (flag, then
`migrate.format`, then `default`); `meta gen` reads the config key. Set `migrate.format` once
and all three agree without a flag.

```bash
meta migrate --db "$DB_URL" --dialect postgres \
  --migration-format flyway --slug add_program_view
# -> src/main/resources/db/migration/V4__add_program_view.sql
# -> src/main/resources/db/migration/U4__add_program_view.sql
```

## Agent-context scaffold is Node-only — by design

The `.metaobjects/AGENTS.md`/`CLAUDE.md` always-on files and the
`.claude/skills/metaobjects-*/` reference tree are assembled by **one** tool: the
Node `meta agent-docs` command. Per [ADR-0033](../../spec/decisions/ADR-0033-single-agent-context-assembler.md)
the per-port native assemblers (Python/Java/C#) and their byte-identity conformance
gates were removed — that content is effectively one static artifact, and every port
already needs the Node `meta` CLI or its binary for schema ops (ADR-0015).

```bash
npx meta agent-docs --server <lang>    # csharp | java | kotlin | python | node
```

The C#, Java/Kotlin, and Python CLIs keep a **non-executing `agent-docs` pointer
stub** that prints `agent-context scaffolding moved to the meta CLI — run: npx meta
agent-docs --server <lang>` to stderr and exits non-zero. The **live staleness check**
in `gen`/`verify` stays per-port (it only *reads* the scaffold to nudge when it drifts);
its message now points at `npx meta agent-docs --server <lang>`.

## Running Kotlin codegen via Maven

`codegen-kotlin`'s generators extend `MultiFileDirectGeneratorBase` — the same
generator SPI the `metaobjects:generate` Mojo loads — so they run through the existing goal
with no Kotlin-specific Mojo. Configure a Kotlin generator on the Maven plugin:

```xml
<plugin>
  <groupId>com.metaobjects</groupId>
  <artifactId>metaobjects-maven-plugin</artifactId>
  <configuration>
    <generators>
      <generator>
        <classname>com.metaobjects.generator.kotlin.KotlinEntityGenerator</classname>
        <args><outputDir>${project.build.directory}/generated-sources/kotlin</outputDir></args>
      </generator>
    </generators>
  </configuration>
</plugin>
```

`mvn metaobjects:generate` emits the Kotlin sources; `mvn metaobjects:verify`
codegen-drift-checks them. See `server/java/codegen-kotlin/README.md` for the full
generator list.

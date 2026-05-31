# SP-E CLI Parity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Fresh subagent per unit + spec-compliance review + code-quality review + simplifier, then merge forward. Steps use `- [ ]`.

**Goal:** Per-port codegen-CLI parity per the locked 2026-05-30 architecture: C# reconciled to `dotnet meta`; Python gets a `metaobjects` console-script (gen+verify); Java gets a `meta:verify` codegen-drift goal + Kotlin gen-path confirmed; cross-port CLI matrix doc + smoke gate. Schema stays Node-only.

**Architecture:** No new schema commands. `verify` = codegen drift (regenerate + fail-on-diff), distinct from FR-004 template-verify. Kotlin generators already extend the SPI the Java `meta:gen` Mojo loads — confirm + document, not a new Mojo.

**Tech stack:** C# (.NET tool packaging), Python (argparse console-script), Java (Maven plugin Mojo). Design: `docs/superpowers/specs/2026-05-31-sp-e-cli-parity-design.md`.

**Worktree:** `<repo-root>/.claude/worktrees/sp-e-cli-parity` (branch `sp-e-cli-parity`, off origin/main).

---

### Unit 1: C# → `dotnet meta` reconciliation

**Files:**
- Modify: `server/csharp/MetaObjects.Cli/MetaObjects.Cli.csproj` (PackAsTool + ToolCommandName, drop `AssemblyName=meta`)
- Modify: `server/csharp/MetaObjects.Cli/Program.cs` (usage strings `meta …` → `dotnet meta …`)
- Modify: any README/doc/script referencing the bare C# `meta`

- [ ] **Step 1 — Inventory the collision.** `grep -rn "AssemblyName>meta<\|\bmeta gen\b\|\bmeta verify\b" server/csharp scripts docs` to find every place the C# bare `meta` name surfaces.
- [ ] **Step 2 — Repackage as a .NET tool.** In the csproj: remove `<AssemblyName>meta</AssemblyName>`; add `<PackAsTool>true</PackAsTool>`, `<ToolCommandName>dotnet-meta</ToolCommandName>`, `<PackageId>MetaObjects.Cli</PackageId>` (or the existing id), keep `<OutputType>Exe</OutputType>`. (dotnet tools with command `dotnet-meta` are invoked as `dotnet meta`.)
- [ ] **Step 3 — Fix usage strings.** In `Program.cs`, the `usage: meta <command>` text → `usage: dotnet meta <command>`; same in `RunGen`/`RunVerify` usage lines.
- [ ] **Step 4 — Verify.** `cd server/csharp && dotnet pack MetaObjects.Cli/MetaObjects.Cli.csproj -o /tmp/sp-e-pack 2>&1 | tail -5` produces a tool package; confirm `gen`/`verify` still run via `dotnet run --project MetaObjects.Cli -- gen …`/`verify …` against a tiny fixture (or the existing Cli.Tests). `cd server/csharp && dotnet test MetaObjects.Cli.Tests/MetaObjects.Cli.Tests.csproj` green.
- [ ] **Step 5 — Commit.** `refactor(cli-cs): package as `dotnet meta` tool (no bare `meta` collision); gen/verify unchanged (SP-E Unit 1)`

### Unit 2: Python `metaobjects` console-script

**Files:**
- Create: `server/python/src/metaobjects/cli.py` (`main(argv=None)` with `gen` + `verify`)
- Modify: `server/python/pyproject.toml` (`[project.scripts] metaobjects = "metaobjects.cli:main"`)
- Create: `server/python/tests/codegen/test_cli.py`

- [ ] **Step 1 — Study the Python codegen entry.** Find how the Python generators are invoked programmatically (e.g. `render_entity_model` + the generator suite, mirror how `tests/codegen` drives them or how a hypothetical `meta gen` would). Find the loader entry (`MetaDataLoader.from_string`/from-dir).
- [ ] **Step 2 — Failing test.** `tests/codegen/test_cli.py`: `from metaobjects.cli import main`; `main(["gen", <metadataDir>, "--out", <tmp>])` writes files (assert a file exists); `main(["verify", <metadataDir>, "--out", <tmp>])` returns 0 when in sync and non-zero after mutating a committed file. Run — fails (no cli module).
- [ ] **Step 3 — Implement `cli.py`.** `argparse` with subcommands: `gen <metadataDir> --out <dir> [--package <pkg>]` (load metadata, run the codegen generators, write to `--out`, print written files); `verify <metadataDir> --out <dir>` (regenerate to a temp dir, diff against `--out`; on drift print the drifted files + "regenerate and commit", return 1). `main` returns an int exit code. No `migrate`.
- [ ] **Step 4 — Wire the entry point** in `pyproject.toml` `[project.scripts]`.
- [ ] **Step 5 — Verify.** `cd server/python && uv run --extra dev pytest tests/codegen/test_cli.py -q` green; `uv run metaobjects gen --help` works (entry point resolves). No regression: `uv run --extra dev pytest tests/ --ignore=tests/integration -q`.
- [ ] **Step 6 — Commit.** `feat(cli-py): metaobjects console-script — gen + verify (codegen drift); schema stays Node-only (SP-E Unit 2)`

### Unit 3: Java `meta:verify` codegen-drift goal + Kotlin gen-path

**Files:**
- Create: `server/java/maven-plugin/src/main/java/com/metaobjects/maven/MetaDataVerifyMojo.java`
- Reference: `MetaDataGeneratorMojo.java` (the gen goal — reuse its generator wiring), `AbstractMetaDataMojo.java`
- Create/modify: a codegen-kotlin test or example proving `meta:gen` runs a Kotlin generator; `server/java/codegen-kotlin/README.md` (document the path)

- [ ] **Step 1 — Add `MetaDataVerifyMojo`** (`@Mojo(name = "verify", …)`). Reuse the generator-loading + metadata-loading from `MetaDataGeneratorMojo`/`AbstractMetaDataMojo`, but instead of writing to the configured output, generate into a temp dir and compare against the committed output; if any file differs (or is missing/extra), throw `MojoFailureException` listing the drifted files + "run meta:gen and commit". Generator-neutral (works for codegen-spring AND codegen-kotlin generators).
- [ ] **Step 2 — Confirm Kotlin via `meta:gen`.** Write a JUnit test in the maven-plugin or codegen-kotlin module that configures a `codegen-kotlin` generator (`KotlinEntityGenerator`) through the same generator-instantiation path the Mojo uses, and asserts it emits a Kotlin file. (Kotlin generators extend `MultiFileDirectGeneratorBase`, the SPI the Mojo loads — so this should work. If it doesn't, add the minimal shim and note why.)
- [ ] **Step 3 — Document** in `server/java/codegen-kotlin/README.md`: how to wire a Kotlin generator into `mvn meta:gen` + `meta:verify` (a `<configuration><generators><generator><classname>…KotlinEntityGenerator</classname>…` example).
- [ ] **Step 4 — Verify.** `cd server/java && mvn -q -pl maven-plugin -am install -DskipTests` then `mvn -q -pl maven-plugin test` (+ the Kotlin gen-path test) green. If the Mojo is hard to unit-test standalone, an integration-style test invoking it on a tiny fixture is fine.
- [ ] **Step 5 — Commit.** `feat(maven-plugin): meta:verify codegen-drift goal; confirm+document Kotlin codegen via meta:gen (SP-E Unit 3)`

### Unit 4: Cross-port CLI matrix doc + smoke gate + CLAUDE.md

**Files:**
- Create: `docs/features/cli.md` (the matrix)
- Modify: `CLAUDE.md` (Java bullet `meta:gen/meta:editor` → `+meta:verify`; one-line CLI-architecture pointer)
- Smoke tests: lightest-touch per port (reuse existing test jobs)

- [ ] **Step 1 — CLI matrix doc.** `docs/features/cli.md`: a table mapping each capability (`init`, TS `gen`, schema `migrate`/`verify --db`, per-language codegen `gen`, codegen-drift `verify`) to the tool that runs it (Node `meta` / `dotnet meta` / `mvn meta:gen`+`meta:verify` / `metaobjects` console-script), with the locked-architecture rationale (schema = Node-only; codegen = per-build-tool) + a pointer to the consolidation design doc.
- [ ] **Step 2 — Per-port smoke.** Confirm each port has at least one test exercising its codegen CLI/goal end-to-end: C# (Cli.Tests gen+verify), Python (test_cli.py from Unit 2), Java (the verify Mojo test from Unit 3). TS already has CLI tests. Add the thinnest missing piece; don't over-build.
- [ ] **Step 3 — CLAUDE.md.** Update the Java port bullet to include `meta:verify`; add a one-line pointer to `docs/features/cli.md` + the locked CLI architecture in the cross-language-porting or status section. Keep it accurate (C# is `dotnet meta` now; Python has `metaobjects`).
- [ ] **Step 4 — Commit.** `docs(cli): cross-port CLI matrix + per-port codegen-CLI smoke + CLAUDE.md (SP-E Unit 4)`

### Unit 5: Final review + finish

- [ ] **Step 1 — Final review.** Simplifier + reviewer over the whole SP-E diff (focus: no schema command leaked into a non-Node port; C# `dotnet meta` packaging correct + gen/verify unchanged; Python verify genuinely detects codegen drift; the Java verify Mojo regenerates+compares correctly + is generator-neutral; Kotlin path real, not theater).
- [ ] **Step 2 — Finish.** Merge forward (integrate-before-merge — main is very active). Update memory + close the enterprise-readiness program.

## Self-review notes
- `dotnet meta` = a tool with `ToolCommandName=dotnet-meta`; confirm `dotnet pack` emits it and the bare-`meta` artifact is gone.
- Python `verify` and Java `meta:verify` are CODEGEN drift (regenerate + diff), NOT FR-004 template-verify — keep them distinct + named clearly.
- Kotlin: prove the `meta:gen` SPI path with a real test before claiming it works; don't just assert.
- No `migrate` anywhere but the Node `meta`. Grep each new CLI surface to be sure.
- This is the last sub-project — after merge, refresh the program memory + the CLAUDE.md status, and note the whole SP-0..SP-E program shipped.

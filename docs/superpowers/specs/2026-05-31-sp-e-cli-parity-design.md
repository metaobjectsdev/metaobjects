# SP-E — CLI Parity (per the locked 2026-05-30 architecture)

**Date:** 2026-05-31
**Status:** Designed (user-approved key decisions; spec-review gate waived — "go with your recommendation")
**Relates to:** enterprise-readiness program (SOON #6). Implements the CLI architecture locked in `docs/superpowers/specs/2026-05-30-ts-schema-authority-consolidation-design.md`.

## The locked architecture (not re-litigated here)

- **One canonical `meta` = the Node CLI**, owning **schema** (`migrate`, `verify --db`) for all backends + TS codegen + `init`. Shipped as a standalone binary so non-TS adopters need no Node toolchain for schema ops.
- **Per-language codegen runs in that language's own build tool** — `mvn …:gen` (Java/Kotlin), a `dotnet`/MSBuild task (C#), a console-script (Python), the Node `meta` (TS). No unified codegen binary; no proxying; no `meta-ts`/`meta-java` names.
- The bare `meta` name belongs unambiguously to the Node schema+TS CLI; the C# tool reconciles to `dotnet meta`.

## Current state (verified 2026-05-31)

| Port | Ships today | Gap |
|---|---|---|
| **TS** | Node `meta`: `init`/`gen`/`migrate`/`verify`/`export` | ✅ canonical — none |
| **C#** | `MetaObjects.Cli` console app, **`AssemblyName=meta`**, commands `gen`+`verify` (migrate already correctly absent) | 🔴 the binary is literally named `meta` → **shadows the Node `meta`** on PATH; must reconcile to `dotnet meta` |
| **Java** | maven-plugin: `meta:gen` + `meta:editor` | 🟡 no codegen-drift `verify` goal |
| **Kotlin** | codegen-kotlin generators extend `MultiFileDirectGeneratorBase` — the **same SPI** the Java `meta:gen` Mojo loads | 🟢 likely already invokable via `mvn meta:gen` with a Kotlin generator configured — verify + document, not a new Mojo |
| **Python** | **no CLI** (no `console_scripts`, no `__main__`) | 🔴 needs a codegen console-script |

(C# correctly has no `migrate` — CLAUDE.md is accurate. The earlier "C# still has migrate" was a mis-read.)

## Decisions (locked with user — my recommendations)

1. **C# binary → `dotnet meta`**: package `MetaObjects.Cli` as a .NET tool with command name `dotnet-meta` (invoked `dotnet meta`); stop producing a bare `meta` executable. No behavior change to `gen`/`verify`; just the invocation name, so it can't collide with the Node `meta`.
2. **Python console-script named `metaobjects`**: `[project.scripts] metaobjects = "metaobjects.cli:main"`, subcommands `gen` + `verify`. NOT named `meta` (that's the Node schema CLI) and NO `migrate` subcommand (schema is Node-only).
3. **`verify` = codegen drift** (regenerate generated code from metadata + fail if it differs from the committed output) — the concrete enterprise-CI primitive ("a teammate changed metadata without regenerating → caught"). This is the SP-0 C# drift-gate pattern generalized to a CLI/goal. It is **distinct from** the existing FR-004 template/prompt-drift `verify` (Renderer.verify) — that stays where it ships; SP-E does not unify the two, only adds codegen-drift `verify` where missing.

## Implementation units

Each unit ends with the simplify + review gate; the sub-project merges forward once.

- **Unit 1 — C# `dotnet meta` reconciliation.** In `server/csharp/MetaObjects.Cli/MetaObjects.Cli.csproj`: add `<PackAsTool>true</PackAsTool>` + `<ToolCommandName>dotnet-meta</ToolCommandName>` + a `<PackageId>`; remove/replace `<AssemblyName>meta</AssemblyName>` so the produced artifact is the dotnet tool `dotnet meta`, not a bare `meta` binary. Update the CLI's own usage string (`usage: meta …` → `usage: dotnet meta …`) and any doc/README referencing the bare `meta` for C#. Verify `dotnet pack` produces a tool whose command is `dotnet meta`, and `gen`/`verify` still run. (Decision: confirm whether anything in CI/scripts invokes the C# `meta` binary by that name and update it.)

- **Unit 2 — Python `metaobjects` console-script.** Add `server/python/src/metaobjects/cli.py` (a `main(argv)` with `gen` + `verify` subcommands) + the `[project.scripts] metaobjects = "metaobjects.cli:main"` entry in `pyproject.toml`. `gen <metadataDir> --out <dir> [--package <pkg>]` runs the existing Python codegen generators; `verify <metadataDir> --out <dir>` regenerates into a temp dir and diffs against `--out` (codegen drift → non-zero exit + a clear "regenerate and commit" message). Mirror the C# CLI's gen/verify UX where sensible. No `migrate`. Add a unit test invoking `main(["gen", …])` + `main(["verify", …])`.

- **Unit 3 — Java `meta:verify` (codegen drift) + Kotlin gen-path.** (a) Add a `MetaDataVerifyMojo` (`@Mojo(name="verify")`) to the Java maven-plugin that regenerates the configured generators into a temp dir and fails the build if the output differs from the committed target (codegen drift), mirroring `meta:gen`'s generator wiring. (b) Verify Kotlin codegen runs through the existing `meta:gen` Mojo: write a small test/example configuring a `codegen-kotlin` generator (e.g. `KotlinEntityGenerator`) as a `meta:gen` `<generator>` and confirm it emits — then document the path in the codegen-kotlin README. If the Mojo genuinely cannot load a Kotlin generator (SPI mismatch), add the minimal shim; otherwise document (no new Mojo). `meta:verify` is generator-neutral, so it covers Kotlin generators too.

- **Unit 4 — Cross-port CLI matrix doc + smoke gate + CLAUDE.md.** (a) A docs page (`docs/features/cli.md` or a section) with the matrix: who runs `gen`/`verify`/`init`/schema per port (Node `meta` = schema + TS; `dotnet meta` = C# codegen; `mvn meta:gen`/`meta:verify` = JVM; `metaobjects` console-script = Python), per the locked architecture. (b) A light per-port smoke test that the codegen CLI/goal actually runs end-to-end (`gen` produces a file; `verify` detects an injected drift) — wire into the port's existing test job where cheap. (c) Update CLAUDE.md's Java bullet (`maven-plugin (meta:gen/meta:editor)` → add `meta:verify`) and add a one-line CLI-architecture pointer.

## Edge cases / non-goals

- **No schema commands added anywhere but the Node `meta`** — no port gets `migrate`/`verify --db`. Schema stays Node-only (ADR-0015).
- **Not building the standalone Node `meta` binary** (Node SEA / `bun --compile`) — that's a separate distribution task in the consolidation spec; SP-E is per-port codegen-CLI parity, not the schema-binary packaging.
- **`verify` here is codegen drift**, deliberately distinct from FR-004 template-drift `verify`; SP-E does not merge or rename the existing template-verify surfaces.
- **Kotlin**: the expected outcome is "already works via `mvn meta:gen`, now documented + covered by `meta:verify`" — a new Mojo is a fallback only if the SPI path is genuinely broken.
- **C#**: `gen`/`verify` behavior is unchanged — only the packaging/invocation name moves to `dotnet meta`.

## Definition of done

- C# CLI is invoked as `dotnet meta` (a .NET tool), no longer producing a bare `meta` that shadows the Node CLI; `gen`/`verify` unchanged.
- Python ships a `metaobjects` console-script with `gen` + `verify` (codegen drift), tested.
- Java maven-plugin has a `meta:verify` (codegen-drift) goal; Kotlin codegen is confirmed runnable via `mvn meta:gen` (+ `meta:verify`) and documented.
- A cross-port CLI matrix doc exists; a per-port codegen-CLI smoke test gates each; CLAUDE.md is accurate.
- No port other than the Node `meta` exposes any schema command.

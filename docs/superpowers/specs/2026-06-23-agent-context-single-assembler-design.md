# Agent-Context: Single Assembler (collapse the per-port re-implementations) — Design

**Date:** 2026-06-23
**Status:** Design — decisions locked, pending spec review
**Supersedes (in part):** ADR-0027 (polyglot-docs-composition) and `2026-06-02-downstream-agent-context-design.md` — specifically the "each port ships its own native scaffolder / not a universal scaffolder" non-goal.

## Problem

The agent-context (the `.claude/skills/metaobjects-*` tree + the two always-on `AGENTS.md`/`CLAUDE.md` files) is assembled by **four native re-implementations** — `assemble.ts` (TS), `assemble.py` (Python), `AgentContextAssembler.java` (JVM), `AgentContextAssembler.cs` (C#) — each guarded by its own **byte-identity conformance gate** against the shared `fixtures/agent-context-conformance` goldens.

Two changes jointly removed the justification for that:
1. **deploy-all (2026-06-23):** references are no longer stack-selected — the `skills/` + `references/` tree is now **byte-identical for every project and every port**. The *only* per-project variation is two strings (`{{stackLine}}`, `{{codegenCommand}}`) in the two always-on files. So each assembler is now "copy a static tree + interpolate two strings."
2. **ADR-0015 (2026-05-30):** schema migrations are Node-only on every port (npm primary; an optional pre-compiled binary serves Node-free shops). So **every adopter already needs the `meta` CLI (or its binary)** — the "scaffold without Node" goal that justified the native assemblers was already traded away for migrations, two days before the agent-context design was written, and never reconciled.

Net: 4 codebases + 4 byte-exact test suites maintaining what is effectively one static artifact. Every agent-context change must be fixed and re-verified in 4 places (we hit this exact wall in CI on PR #71).

## Decision

**Option A — one assembler.** The Node `meta` CLI is the sole agent-context assembler. The Python, JVM, and C# ports stop assembling and embedding the agent-context entirely. Scaffolding is distributed exactly like migrations (npm primary; optional binary for Node-free shops). This is the AWS CDK / Pulumi / `protoc` model: one canonical CLI for a polyglot toolkit.

**`agent-docs` on the non-Node CLIs — A + pointer stub.** The native implementation is deleted, but each non-Node CLI keeps a tiny **non-executing** stub: invoking `agent-docs` prints a redirect — *"Agent-context scaffolding is provided by the `meta` CLI — run `npx meta agent-docs --server <lang>`."* It never execs (so it cannot version-skew, fail on PATH, or mishandle a missing runtime — the failure modes that make a thin shell wrapper a smell). The same line goes in each port's README and `init`/help output. This preserves discoverability with zero fragility.

**Sequencing — fold into the current branch.** This is implemented on `metaobjects-cli-axi-and-deploys` (PR #71), as deletions. The cross-port assembler *fixes* added earlier on that branch (porting deploy-all into the C#/Python assemblers, commit `e414b7a2`/`1090b972`) are **superseded by deletion** — they got CI green at the time and remain in history; the net branch diff removes those assemblers. PR #71 thus becomes Plan 1 + Plan 2 + this consolidation.

## Architecture

### Kept (Node/TS only — the single source of truth)
- `server/typescript/packages/sdk/src/agent-context/assemble.ts` — the sole assembler.
- The SDK bundle step (`bundle-agent-context.mjs`) + the gitignored bundled copy.
- **One** byte-identity conformance gate: `agent-context-conformance.test.ts` + `assemble.test.ts` vs `fixtures/agent-context-conformance` goldens, and `regen-agent-context-conformance.ts`.
- The Node `meta agent-docs` / `meta init` command, which already accepts `--server <lang>`/`--client <fw>` and reads `agent-context/servers/<lang>.meta.json` for each language's `codegenCommand` (e.g. `dotnet meta gen`, `mvn meta:gen`) — so it fully serves every stack's `{{stackLine}}`/`{{codegenCommand}}`.
- Root `agent-context/` — the source of truth (unchanged).

### Deleted — Python
- `server/python/src/metaobjects/agent_context/assemble.py` (+ the module's `assemble`/`make_stack`/`AssembledFile` surface that only served scaffolding).
- `server/python/tests/conformance/test_agent_context_conformance.py` (the byte-identity gate).
- The embedded `_content/` tree + its Hatch build hook (`hatch_build.py`) + the `content_root.py` resolver (to the extent they exist only for agent-context).
- The Python CLI `agent-docs` implementation → replaced by the pointer stub.

### Deleted — Java/Kotlin
- `server/java/metadata/src/main/java/com/metaobjects/agentcontext/AgentContextAssembler.java` + `AssembledFile.java` (+ `AgentContextScaffold` if it only wraps assembly).
- `AgentContextConformanceTest.java` (the byte-identity gate).
- The classpath-resource bundling of `agent-context/` + `ContentRoot.java` (to the extent agent-context-only).
- The Maven `agent-docs` goal/Mojo → pointer stub (a Mojo that logs the redirect).

### Deleted — C#
- `server/csharp/MetaObjects/AgentContext/AgentContextAssembler.cs` (+ `AssembledFile`).
- `server/csharp/MetaObjects.Conformance.Tests/AgentContextConformanceTests.cs` (the byte-identity gate) and `AgentContextStalenessTests.cs` if it depends on the embedded copy.
- The embedded-resource bundling of `agent-context/` in the `.csproj`.
- `AgentDocsCommand.cs` → replaced by the pointer stub.

### Pointer stub (each non-Node CLI)
A minimal command handler that prints, to stdout, the redirect line and exits 0 (or a small non-zero "not-here" code — decided in the plan), referencing the port's language: `run \`npx meta agent-docs --server <lang>\``. No process exec, no embedded content, no assembly.

### Docs / ADR
A new ADR (e.g. ADR-0033) records: agent-context scaffolding is consolidated to the Node `meta` CLI (npm primary; binary optional), consistent with ADR-0015; the per-port native assemblers are removed; non-Node CLIs redirect via a pointer stub. It supersedes the relevant non-goal in ADR-0027 / the 2026-06-02 spec. Update each port's README + `init` output with the redirect line.

## Components & boundaries

- **Assembler (Node):** one unit; input = (`agent-context/` content root, resolved stack); output = the file set. Unchanged, now the only one.
- **Conformance gate (Node):** one unit; assembler output == committed goldens. Replaces the four.
- **Pointer stub (×3 ports):** trivial, isolated, no dependency on agent-context content; pure constant output. Independently testable (assert the redirect string + exit code).

## Testing
- Keep + run the single Node conformance gate (`bun test test/agent-context`) + the SDK bundle/drift test.
- After each port's deletions: run that port's build + remaining test suite to confirm nothing else referenced the removed assembler/embedded copy (`uv run pytest -q`; `dotnet test` for the C# projects; `mvn -q test` / the JVM build; `bun test` for TS). The earlier audit found **no other consumers** of the native assemblers/embedded content beyond scaffolding, so deletions should be self-contained — verify per port.
- Add a tiny per-port test asserting the pointer stub prints the redirect and exits as specified.
- Full CI on PR #71 must go green (the previously-failing `conformance (csharp|python)` jobs now have *no* agent-context conformance to run — verify the conformance workflow still passes with those suites removed, not silently skipped into a false green).

## Risks & mitigations
- **A relies on the `meta` CLI/binary being available.** It is — npm is the primary distribution and is already mandatory for migrations (ADR-0015). If the standalone binary is *not* actually shipped today, Node-free shops still use `npx`/npm (same as migrate); the binary is the same optional escape hatch, not a new requirement. (Flagged for confirmation: is the bun-compiled binary released? It doesn't block A, but the ADR should state the real status.)
- **Discoverability loss** — mitigated by the pointer stub + README/init nudge.
- **Deletion ripple** — a port may reference the assembler/embedded copy elsewhere; the per-port build+test run catches it. The audit says no other consumers exist.
- **CI false-green** — ensure removing the per-port conformance suites doesn't leave a job that "passes" by running nothing; the conformance workflow's csharp/python legs should still execute their remaining real tests.

## Out of scope
- The full axi + TOON treatment of the Python (Plan 3), C# (Plan 4), and Maven (Plan 5) CLIs — separate, later. (Their `agent-docs` pointer stub is in scope here; their TOON output is not.)
- Changing the agent-context *content* (skills/references) — unchanged.
- Shipping/building the standalone binary — out of scope; only documenting its status.

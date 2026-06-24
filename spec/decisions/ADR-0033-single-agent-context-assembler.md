# ADR-0033: Single agent-context assembler — Node `meta` CLI only

## Status

Accepted (2026-06-23). Implemented on `metaobjects-cli-axi-and-deploys` (PR #71).

## Context

Agent-context scaffolding (the `.metaobjects/AGENTS.md`/`CLAUDE.md` always-on files +
the `.claude/skills/metaobjects-*/` tree) was assembled by **four parallel native
implementations**: `assemble.ts` (TS/Node), `assemble.py` (Python),
`AgentContextAssembler.java` (JVM), and `AgentContextAssembler.cs` (C#). Each was
guarded by its own **byte-identity conformance gate** against the shared
`fixtures/agent-context-conformance` goldens.

Two earlier decisions jointly removed the justification for that duplication:

1. **deploy-all (2026-06-23).** References are no longer stack-selected — the
   `skills/` + `references/` tree is now byte-identical for every project and every
   port. The only per-project variation is two strings (`{{stackLine}}`,
   `{{codegenCommand}}`) in the two always-on files. Each assembler was therefore
   doing "copy a static tree + interpolate two strings."

2. **ADR-0015 (2026-05-30).** Schema migrations are Node-only on every port (npm
   primary; an optional pre-compiled binary serves Node-free shops). Every adopter
   already needs the `meta` CLI or its binary. The "scaffold without Node" goal that
   justified native assemblers was already traded away for migrations — two days before
   the agent-context design was written — and was never reconciled.

Net consequence: four codebases and four byte-exact test suites maintaining what is
effectively one static artifact. Every agent-context content change required fixes and
re-verification in four places (this wall was hit concretely in CI on PR #71).

## Decision

**The Node `meta` CLI is the single agent-context assembler.** The Python, JVM, and C#
ports stop assembling and embedding agent-context content. Scaffolding is distributed
exactly like migrations (npm primary; optional pre-compiled binary for Node-free shops).
This follows the AWS CDK / Pulumi / `protoc` model: one canonical CLI for a polyglot
toolkit.

**Non-Node CLIs keep a non-executing pointer stub for `agent-docs`.** The native
implementation is deleted, but each non-Node CLI retains a minimal stub: invoking
`agent-docs` prints a redirect message to stdout and exits 1. It never execs any
process, reads embedded content, or imports any assembler symbol. This preserves
discoverability with zero fragility.

The redirect message printed by each stub is:

```
agent-context scaffolding moved to the meta CLI — run:
  npx meta agent-docs --server <lang> [--client <fw>] [--out <dir>]
```

**Each non-Node port retains its live staleness-read path.** The `agent_context_staleness`
/ `AgentContextScaffold` / staleness manifest code consumed by gen/verify was NOT part of
the assembler and is NOT removed. Only the assembly + file-write path is deleted.

**The single Node conformance gate is kept.** `agent-context-conformance.test.ts` +
`assemble.test.ts` vs `fixtures/agent-context-conformance` goldens remain. The three
per-port byte-identity gates are removed.

## Reconciliation with ADR-0015

ADR-0015 established that every adopter already needs Node (or the binary) for schema
migrations. A separate native scaffolder per port therefore bought nothing: the toolchain
dependency already existed. This ADR applies the same reasoning to agent-context
scaffolding — one CLI, one place to maintain.

## What was deleted

- **Python:** `server/python/src/metaobjects/agent_context/assemble.py` (+ associated
  `AssembledFile`/`Stack`/`ContentRoot` types); `test_agent_context_conformance.py`; the
  embedded `_content/` tree and its build hook. The `metaobjects agent-docs` command is
  replaced by the pointer stub.
- **Java/Kotlin:** `AgentContextAssembler.java` + `AssembledFile.java`; the
  `AgentContextConformanceTest`; classpath-resource bundling of `agent-context/`. The
  `mvn metaobjects:agent-docs` Mojo is replaced by the pointer stub.
- **C#:** `AgentContextAssembler.cs` + `AssembledFile`; `AgentContextConformanceTests.cs`;
  embedded-resource bundling of `agent-context/` in the `.csproj`. `AgentDocsCommand.cs`
  is replaced by the pointer stub.

## Invoking agent-context scaffolding

All ports — regardless of server language — use the Node `meta` CLI:

```bash
npx meta agent-docs --server python   # Python adopter
npx meta agent-docs --server java     # Java/Kotlin adopter
npx meta agent-docs --server csharp  # C# adopter
npx meta agent-docs --server typescript  # TypeScript adopter
```

The `--client` and `--out` flags are also available. For shops that do not want Node in
CI, the same command is available via the pre-compiled `meta` binary (see ADR-0015).

## Consequences

- **Less code, consistent by construction.** One assembler replaces four; agent-context
  content drift across ports becomes impossible rather than test-policed.
- **Every agent-context content change is made once.** The four-port sync burden on PR #71
  is eliminated.
- **Discoverability preserved.** Each non-Node CLI's `agent-docs` command prints the
  correct redirect rather than silently failing or omitting the command from help output.
- **No new toolchain requirement.** Every adopter already needs Node (or the binary) for
  migrations per ADR-0015. This ADR adds no new dependency.
- **Staleness detection unaffected.** The live staleness-read path (used by gen/verify
  nudge) is retained in every port.

## Supersedes

- The "Not a universal `npx` scaffolder for non-TS shops (noted as a possible later
  convenience; each port ships its own native command instead)" non-goal in
  `docs/superpowers/specs/2026-06-02-downstream-agent-context-design.md`.
- In part: ADR-0027 (polyglot-docs-composition) — specifically any implied per-port
  ownership of the agent-context scaffolding surface.

See also: `docs/superpowers/specs/2026-06-23-agent-context-single-assembler-design.md`
for the full design rationale.

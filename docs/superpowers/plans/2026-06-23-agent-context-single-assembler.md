# Single Agent-Context Assembler — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the agent-context to a single Node assembler — delete the Python, Java/Kotlin, and C# native assemblers + their byte-identity conformance tests + their embedded `agent-context/` copies, and replace each non-Node CLI's `agent-docs` with a non-executing pointer stub that redirects to the Node `meta agent-docs --server <lang>`.

**Architecture:** The Node `meta` CLI (npm primary; optional binary) becomes the sole scaffolder — consistent with ADR-0015 (migrations already require Node/binary). Per-port "assembly" was reduced to "copy a static tree + interpolate two strings" by deploy-all, so the native re-implementations + N byte-identity gates are pure cost. Folded into branch `metaobjects-cli-axi-and-deploys` (PR #71) as deletions; the earlier cross-port assembler *fixes* are superseded.

**Tech Stack:** Node/TS (`meta` CLI + SDK assembler, `bun test`), Python (`uv`/`pytest`, Hatch), Java/Kotlin (Maven), C# (.NET 8 / `dotnet test`).

## Global Constraints
- **Source of truth stays** monorepo-root `agent-context/`; the **only** kept assembler is `server/typescript/packages/sdk/src/agent-context/assemble.ts` + its single conformance gate (`agent-context-conformance.test.ts`, `assemble.test.ts`) + `regen-agent-context-conformance.ts`.
- **Pointer stub contract (all non-Node CLIs):** invoking `agent-docs` prints, to stdout, exactly: `agent-context scaffolding moved to the meta CLI — run: npx meta agent-docs --server <lang> [--client <fw>] [--out <dir>]` and exits non-zero `1`. It MUST NOT exec any process, read any embedded content, or import any assembler symbol.
- **Keep the staleness-nudge machinery** in each port (it reads the `.metaobjects/.agent-context.json` manifest the Node CLI writes; used by `gen`/`verify`). Delete only the *assembly* path.
- Public repo: no private names / local abspaths in committed files.
- Each port's FULL test suite must pass after its deletions (no dangling refs).

---

## Task 1: Add a `meta agent-docs` alias on the Node CLI (the redirect target)

**Files:**
- Modify: `server/typescript/packages/cli/src/index.ts` (dispatch + HELP_TEXT)
- Modify (maybe): `server/typescript/packages/cli/src/commands/init.ts` (export the docs-only path)
- Test: `server/typescript/packages/cli/test/agent-docs-alias.test.ts`

**Interfaces:**
- Produces: `meta agent-docs [--server <lang>]... [--client <fw>]... [--out <dir>]` that scaffolds the agent-context (the `.metaobjects/` always-on files + `.claude/skills/**`) for the given stack — the same code path `init` already uses (`assemble()` + `planScaffold()`), without the `metaobjects/` project scaffold.

- [ ] **Step 1: Read `init.ts`** to find the existing agent-context write path (`writeAgentContext()` ~lines 99-110, which calls `resolveStack` + `assemble` + `planScaffold`). Confirm whether `init --refresh-docs` already does exactly "docs only". If it does, `agent-docs` is a thin alias to that path; if not, extract the docs-only write into a reusable function.

- [ ] **Step 2: Write the failing test** `test/agent-docs-alias.test.ts`:
```ts
import { test, expect } from "bun:test";
import { run } from "../src/index.js";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("meta agent-docs --server csharp scaffolds the agent-context (no metaobjects/ project)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "meta-agentdocs-"));
  const code = await run(["agent-docs", "--server", "csharp", "--cwd", dir]);
  expect(code).toBe(0);
  expect(existsSync(join(dir, ".claude/skills/metaobjects-codegen/references/csharp.md"))).toBe(true);
  expect(existsSync(join(dir, ".claude/skills/metaobjects-codegen/references/python.md"))).toBe(true); // deploy-all
  expect(existsSync(join(dir, ".metaobjects/AGENTS.md"))).toBe(true);
  // codegenCommand for csharp comes from servers/csharp.meta.json
  expect(require("node:fs").readFileSync(join(dir, ".metaobjects/AGENTS.md"), "utf8")).toContain("dotnet meta gen");
});
```

- [ ] **Step 3: Run it; verify it fails** — `cd server/typescript/packages/cli && bun test test/agent-docs-alias.test.ts` → FAIL (`agent-docs` unknown command / falls to default).

- [ ] **Step 4: Implement** the `agent-docs` case in `index.ts`'s `run()` switch (mirror the `init` case), dispatching to the docs-only write path with the parsed `--server/--client/--out`. Add an `agent-docs` line to `HELP_TEXT` COMMANDS. Keep `init` as-is.

- [ ] **Step 5: Run the test + full CLI suite** — `bun test test/agent-docs-alias.test.ts && bun test` → PASS, no regressions.

- [ ] **Step 6: Commit** — `git add server/typescript/packages/cli/src/index.ts server/typescript/packages/cli/src/commands/init.ts server/typescript/packages/cli/test/agent-docs-alias.test.ts && git commit -m "feat(cli): add 'meta agent-docs --server <lang>' alias (canonical scaffolder for all ports)"`

---

## Task 2: Python — delete native assembler, stub `agent-docs`

**Files:**
- Delete: `server/python/src/metaobjects/agent_context/assemble.py`, `.../agent_context/types.py`, `.../agent_context/content_root.py`, `server/python/tests/conformance/test_agent_context_conformance.py`
- Delete (verify first): `server/python/src/metaobjects/agent_context/scaffold.py` (only if its only consumer was `agent-docs`)
- Modify: `server/python/hatch_build.py` (remove the `_content` vendoring), `server/python/.gitignore` (drop the `_content/` line), `server/python/src/metaobjects/agent_context/__init__.py` (drop deleted exports), `server/python/src/metaobjects/cli.py` (stub `_cmd_agent_docs`, fix imports)
- Delete dir: `server/python/src/metaobjects/agent_context/_content/`

**Interfaces:** Produces the pointer stub for `metaobjects agent-docs`. Keeps `agent_context_staleness`, `Manifest`, `AGENT_CONTEXT_MANIFEST_PATH`, `installed_metaobjects_version` (used by gen/verify nudge — do NOT delete).

- [ ] **Step 1: Map references before deleting.** Run `cd server/python && grep -rn "assemble\|make_stack\|AssembledFile\|resolve_agent_context_root\|plan_scaffold\|from .scaffold\|agent_context._content\|content_root" src tests | grep -v "_content/"`. Confirm: (a) only `_cmd_agent_docs` (cli.py ~561-646) calls `assemble`/`make_stack`/`resolve_agent_context_root`; (b) whether `scaffold.py`/`plan_scaffold` is used by anything other than `agent-docs` — if not, delete it too; if yes, leave it and only delete `assemble.py`/`types.py`/`content_root.py`. Record findings.

- [ ] **Step 2: Stub the command** in `cli.py` — replace the body of `_cmd_agent_docs` (~lines 561-646) with:
```python
def _cmd_agent_docs(args: argparse.Namespace) -> int:
    print(
        "agent-context scaffolding moved to the meta CLI — run: "
        "npx meta agent-docs --server python [--client <fw>] [--out <dir>]",
        file=sys.stderr,
    )
    return 1
```
Keep its argparse registration (~lines 763-789) so the command still exists (it just redirects). Remove the now-unused argparse options that only fed the deleted impl if they cause unused-var lint; otherwise leave minimal.

- [ ] **Step 3: Remove imports + exports.** In `cli.py` delete the imports of `assemble`, `make_stack`, `resolve_agent_context_root` (keep `Manifest`, `agent_context_staleness`, `AGENT_CONTEXT_MANIFEST_PATH`, `installed_metaobjects_version`, and `plan_scaffold` only if Step 1 kept `scaffold.py`). In `agent_context/__init__.py` drop the `assemble`/`make_stack`/`AssembledFile`/`Stack`/`types` re-exports.

- [ ] **Step 4: Delete the files** identified (assemble.py, types.py, content_root.py, the conformance test, scaffold.py if unused, `_content/`), remove the `hatch_build.py` vendoring (lines ~30-39 → no-op or delete the hook) and the `.gitignore` `_content/` line.

- [ ] **Step 5: Verify the Python suite + build.** Run `cd server/python && uv run pytest -q` → all pass (the staleness tests still pass; the agent-context conformance test is gone). Then confirm the package still builds without the hook: `uv build 2>&1 | tail -3` (or the project's build command) → success. If any dangling import remains, fix it.

- [ ] **Step 6: Commit** — `git add -A server/python && git commit -m "refactor(python): drop native agent-context assembler + embedding; agent-docs redirects to meta CLI"`

---

## Task 3: Java/Kotlin — delete native assembler, stub the Mojo

**Files:**
- Delete: `server/java/metadata/src/main/java/com/metaobjects/agentcontext/AgentContextAssembler.java`, `.../AssembledFile.java`, `.../Stack.java`, `.../ContentRoot.java`, `server/java/metadata/src/test/java/com/metaobjects/agentcontext/AgentContextConformanceTest.java`
- Modify: `server/java/maven-plugin/pom.xml` (remove the `bundle-agent-context` `copy-resources` execution), `server/java/maven-plugin/src/main/java/com/metaobjects/mojo/AgentDocsMojo.java` (stub `execute()` + drop imports)

**Interfaces:** Produces the pointer stub for `mvn metaobjects:agent-docs`. Keeps `AgentContextScaffold`/`Manifest`/staleness (verify they don't import the deleted `AssembledFile`/`Stack`; if they do, that code only served agent-docs → handle in Step 1).

- [ ] **Step 1: Map references.** `cd server/java && grep -rn "AgentContextAssembler\|AssembledFile\|com.metaobjects.agentcontext.Stack\|ContentRoot" --include=*.java --include=*.kt src */src 2>/dev/null | grep -v "/target/"`. Confirm only `AgentDocsMojo` uses `AgentContextAssembler`/`AssembledFile`/`ContentRoot`/`Stack`. Confirm `AgentContextScaffoldTest`/`AgentContextStalenessTest` don't depend on the deleted types (the manifest says they're independent — verify).

- [ ] **Step 2: Stub the Mojo** — in `AgentDocsMojo.java`, replace `execute()` (~lines 70-132) with:
```java
@Override
public void execute() throws MojoExecutionException {
    getLog().warn("agent-context scaffolding moved to the meta CLI — run: "
        + "npx meta agent-docs --server java [--client <fw>] [--out <dir>]");
    throw new MojoExecutionException("agent-docs is no longer implemented in the Maven plugin; use the meta CLI.");
}
```
Delete the four `import com.metaobjects.agentcontext.*` lines (~7,9-11). Keep the `@Mojo(name = "agent-docs", ...)` annotation so the goal still exists (it just fails-with-redirect).

- [ ] **Step 3: Remove the embedding** — in `server/java/maven-plugin/pom.xml`, delete the `<execution><id>bundle-agent-context</id>...copy-resources...</execution>` block (~lines 57-76).

- [ ] **Step 4: Delete the assembler + conformance files** listed above.

- [ ] **Step 5: Verify the JVM build + the CI-run tests.** Run the same tests CI runs plus a build:
```
cd server/java && mvn -pl metadata,maven-plugin -am install -DskipTests -q \
 && mvn -pl metadata test -Dtest='ConformanceTest,YamlConformanceTest,ObjectModelConformanceTest,RegistryManifestConformanceTest,AgentContextScaffoldTest,AgentContextStalenessTest' -q
```
Expected: BUILD SUCCESS, tests pass. (`AgentContextConformanceTest` is gone and was never in the CI `-Dtest` list, so CI is unaffected — confirm by grepping `.github/workflows/conformance.yml` for the test name: absent.)

- [ ] **Step 6: Commit** — `git add -A server/java && git commit -m "refactor(java): drop native agent-context assembler + classpath embedding; agent-docs Mojo redirects to meta CLI"`

---

## Task 4: C# — delete native assembler, stub `agent-docs`

**Files:**
- Delete: `server/csharp/MetaObjects/AgentContext/AgentContextAssembler.cs`, `.../AgentContext/AssembledFile.cs`, `.../AgentContext/Stack.cs` (verify path), `.../AgentContext/ContentRoot.cs`, `server/csharp/MetaObjects.Conformance.Tests/AgentContextConformanceTests.cs`, `server/csharp/MetaObjects.Cli/AgentDocsCommand.cs`
- Modify: `server/csharp/MetaObjects.Cli/MetaObjects.Cli.csproj` (remove the `agent-context` `<Content Include>` ItemGroup), `server/csharp/MetaObjects.Cli/Program.cs` (stub the `agent-docs` dispatch + help text), and `server/csharp/MetaObjects.Cli.Tests/AgentContextStalenessTests.cs` (it calls `AgentDocsCommand.Run` — update or delete)

**Interfaces:** Produces the pointer stub for `dotnet meta agent-docs`.

- [ ] **Step 1: Map references + resolve the two verify-items.** `cd server/csharp && grep -rn "AgentContextAssembler\|AssembledFile\|MetaObjects.AgentContext\|ContentRoot\|AgentDocsCommand" --include=*.cs . | grep -v "/bin/\|/obj/"`. Confirm (a) `Stack.cs` exists under `MetaObjects/AgentContext/`; (b) what `AgentContextStalenessTests.cs:~33` (`AgentDocsCommand.Run(...)`) actually tests — it tests staleness stamping, which depends on the manifest being written. Since `agent-docs` no longer writes the manifest (Node does), **update that test** to write a minimal `.metaobjects/.agent-context.json` fixture directly and assert the staleness decision, OR delete it if it's purely an agent-docs-writes-manifest test. Record the decision.

- [ ] **Step 2: Stub the dispatch** in `Program.cs` (~line 43), replace `"agent-docs" => AgentDocsCommand.Run(args[1..]),` with:
```csharp
"agent-docs" => AgentDocsRedirect(),
```
and add a local:
```csharp
static int AgentDocsRedirect()
{
    Console.Error.WriteLine("agent-context scaffolding moved to the meta CLI — run: "
        + "npx meta agent-docs --server csharp [--client <fw>] [--out <dir>]");
    return 1;
}
```
Remove the `agent-docs` lines from the help text (~lines 31-34) or replace with a one-line "agent-docs — see `npx meta agent-docs`".

- [ ] **Step 3: Delete** `AgentDocsCommand.cs`, the assembler files, `ContentRoot.cs`, and `AgentContextConformanceTests.cs`. Remove the `<ItemGroup>` embedding `agent-context/**` from `MetaObjects.Cli.csproj` (~lines 39-45).

- [ ] **Step 4: Apply the Step-1 decision** to `AgentContextStalenessTests.cs` (update to a manifest fixture, or delete).

- [ ] **Step 5: Verify the C# build + the CI-run tests.**
```
cd server/csharp \
 && dotnet test MetaObjects.Conformance.Tests/MetaObjects.Conformance.Tests.csproj --nologo --verbosity quiet \
 && dotnet test MetaObjects.Cli.Tests/MetaObjects.Cli.Tests.csproj --nologo --verbosity quiet
```
Expected: build succeeds (no dangling refs to the deleted namespace), all tests pass. The Conformance project still runs its other real tests (not a false-green); `AgentContextConformanceTests` is gone.

- [ ] **Step 6: Commit** — `git add -A server/csharp && git commit -m "refactor(csharp): drop native agent-context assembler + embedded resources; agent-docs redirects to meta CLI"`

---

## Task 5: ADR + READMEs + CI sanity

**Files:**
- Create: `spec/decisions/ADR-0033-single-agent-context-assembler.md` (confirm next ADR number first)
- Modify: each port's README mentioning `agent-docs` (Python/C#/Java), and `docs/superpowers/specs/2026-06-02-downstream-agent-context-design.md` (supersede note)
- Verify: `.github/workflows/conformance.yml`

- [ ] **Step 1: Confirm the next ADR number** — `ls spec/decisions/ | grep -oE 'ADR-[0-9]+' | sort -u | tail -3`. Use the next free number (the spec assumed 0033).

- [ ] **Step 2: Write the ADR** — record the decision (single Node assembler; non-Node ports redirect via pointer stub; reconciles ADR-0015), superseding the "each port ships its own native scaffolder" non-goal in ADR-0027 / the 2026-06-02 spec. Add a one-line `> Superseded (2026-06-23): see ADR-0033` note to both.

- [ ] **Step 3: Update the port READMEs** — replace any `dotnet meta agent-docs` / `metaobjects agent-docs` / `mvn metaobjects:agent-docs` usage doc with `npx meta agent-docs --server <lang>`.

- [ ] **Step 4: CI sanity (no false-green).** Confirm the Python (`pytest tests/conformance -q`) and C# (`dotnet test MetaObjects.Conformance.Tests`) legs still execute multiple OTHER real conformance tests after the agent-context test is removed (grep the dir/project for remaining `*conformance*` tests). They do, so no workflow edit is required — but if a leg would be left empty, add an explicit test list. Record the check.

- [ ] **Step 5: Commit** — `git add spec/decisions docs server/*/README* 2>/dev/null; git commit -m "docs(adr): ADR-0033 single agent-context assembler; redirect non-Node CLIs; supersede ADR-0027 non-goal"`

---

## Task 6: Whole-branch verification

- [ ] **Step 1: Run every port's suite once more** — TS (`cd server/typescript/packages/sdk && bun test test/agent-context` + `cd ../cli && bun test`), Python (`uv run pytest -q`), C# (the two `dotnet test` projects from Task 4), Java (the Task-3 mvn line). All green.

- [ ] **Step 2: Confirm the single conformance gate is the only one left** — `grep -rln "byte-identical\|agent-context-conformance\|AgentContextConformance" server --include=*.ts --include=*.py --include=*.cs --include=*.java | grep -v "/bin/\|/dist/\|/target/\|/_content/"` returns only the TS file(s).

- [ ] **Step 3: Push the branch** (continues PR #71) — `git push`. Then watch CI: `conformance (csharp)` / `conformance (python)` must pass by running their *remaining* tests (not zero). Do not merge; report PR ready.

---

## Self-Review

**Spec coverage:** single Node assembler kept (T1 confirms the canonical command; assembler untouched) ✔; delete Python/Java/C# assemblers + gates + embedding (T2/T3/T4) ✔; pointer stub per port (T2/T3/T4, contract in Global Constraints) ✔; keep staleness machinery (called out in every per-port task) ✔; ADR + supersede + READMEs (T5) ✔; CI-not-false-green (T5 S4, T6 S3) ✔; folded into branch as deletions (header) ✔. Out-of-scope (Plan 3/4/5 TOON; binary shipping) excluded.

**Placeholder scan:** the three flagged verify-items from the manifest (Python `scaffold.py`/`plan_scaffold` usage; C# `Stack.cs` path; C# `AgentContextStalenessTests` fate) are explicit Step-1 "map references / decide" steps in their tasks, not silent TODOs — each task records the finding before deleting. Stub code is given in full per port.

**Type/contract consistency:** the pointer-stub message + `exit 1` + "no exec/no import" contract is identical across T2/T3/T4 and the Global Constraints; the redirect target `meta agent-docs --server <lang>` is the command T1 creates. The kept-symbols list (staleness/manifest) is consistent across the per-port tasks.

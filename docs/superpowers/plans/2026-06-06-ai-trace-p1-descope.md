# AI-trace P1 — Descope the TS ai-runtime surface — Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Checkbox steps.

**Goal:** Remove the vendor clients + the `builtinCost` rate table from `@metaobjectsdev/ai-runtime` (ADR-0024 CUT), keeping the `CostFn` seam and the vendor-neutral call glue.

**Spec:** `docs/superpowers/specs/2026-06-06-ai-trace-p1-descope-design.md` · **ADR:** ADR-0024.

**Working dir:** `server/typescript` for bun. Worktree `.claude/worktrees/ai-trace-p1`. PUBLIC repo — no private names / home paths.

---

## Task 1: Remove vendor clients + trim builtinCost (one coherent descope)

**Files:**
- Delete: `packages/ai-runtime/src/anthropic.ts`, `src/openai.ts`, `test/anthropic.test.ts`, `test/openai.test.ts`, `test/cost.test.ts`
- Modify: `packages/ai-runtime/src/cost.ts`, `src/call-loop.ts`, `src/index.ts`, `package.json`, `test/call-loop.test.ts`

- [ ] **Step 1: Grep the blast radius** — confirm nothing outside the deletions imports the cut symbols:
```
cd <worktree> && grep -rn "AnthropicClient\|OpenAIClient\|builtinCost\|ai-runtime/anthropic\|ai-runtime/openai" server/typescript --include=*.ts | grep -v node_modules | grep -v dist
```
Expect hits ONLY in the files being deleted/modified (anthropic.ts, openai.ts, their tests, cost.ts, call-loop.ts, index.ts, call-loop.test.ts). If anything else references them, STOP and report.

- [ ] **Step 2: Update `call-loop.test.ts` cost assertions FIRST (TDD)** — the existing cost case relies on the `builtinCost` default. Change it to inject a `CostFn` and add a no-cost case. Read the file; replace the cost-bearing case with:
```ts
test("costMinor comes from an injected CostFn", async () => {
  const client: LlmClient = { async complete() { return { body: "ok", model: "m", usage: { inputTokens: 10, outputTokens: 20 } }; } };
  const rec = new Capture();
  await callLlm(
    { callType: "X", request: { prompt: "p", model: "m" } },
    { client, recorder: rec, cost: () => 75 },
  );
  expect(rec.rows[0]!.costMinor).toBe(75);
});
test("no CostFn → costMinor is null (no built-in rate table)", async () => {
  const client: LlmClient = { async complete() { return { body: "ok", model: "m", usage: { inputTokens: 10, outputTokens: 20 } }; } };
  const rec = new Capture();
  await callLlm({ callType: "X", request: { prompt: "p", model: "m" } }, { client, recorder: rec });
  expect(rec.rows[0]!.costMinor).toBeNull();
});
```
(Reuse the file's existing `Capture` recorder + `LlmClient` import. Match the actual `callLlm` signature: `callLlm(RunLlmCallInput, CallLlmDeps)`.)
Run `bun test packages/ai-runtime/test/call-loop.test.ts` → these new cases FAIL (builtinCost default still computes a cost when none injected).

- [ ] **Step 3: Trim `cost.ts`** to just the seam:
```ts
import type { LlmUsage } from "./client.js";

/**
 * Maps (model, usage) to a cost in integer USD minor units (cents), per the
 * field.currency wire contract. Returns null when unknown — never throws.
 * The library ships NO rate table (ADR-0024); adopters supply their own CostFn
 * (e.g. from their LLM library's usage + their own rates) via `deps.cost`.
 */
export type CostFn = (model: string, usage: LlmUsage | undefined) => number | null;
```
(Remove `MODEL_RATES` + `builtinCost`.)

- [ ] **Step 4: Update `call-loop.ts`** — `runLlmCall` no longer imports/defaults `builtinCost`. Change `import { builtinCost, type CostFn } from "./cost.js";` → `import type { CostFn } from "./cost.js";`. Replace the cost block:
```ts
  // was: const cost = deps.cost ?? builtinCost; ... if (completion !== undefined) { const c = cost(...); ... }
  if (completion !== undefined && deps.cost !== undefined) {
    const c = deps.cost(completion.model ?? input.request.model, completion.usage);
    if (c !== null) recInput.costMinor = c;
  }
```
(Remove the `const cost = deps.cost ?? builtinCost;` line.)

- [ ] **Step 5: Update `index.ts`** — change `export { builtinCost, type CostFn } from "./cost.js";` → `export type { CostFn } from "./cost.js";`. Confirm no other index line references anthropic/openai (they were subpath-only via package.json, not the main barrel — verify).

- [ ] **Step 6: Delete the files** — `git rm` `src/anthropic.ts src/openai.ts test/anthropic.test.ts test/openai.test.ts test/cost.test.ts`.

- [ ] **Step 7: Update `package.json`** — remove the `"./anthropic"` + `"./openai"` keys from `exports`; remove `@anthropic-ai/sdk` + `openai` from `peerDependencies` AND `peerDependenciesMeta` (KEEP `langfuse` + `@opentelemetry/api`); remove any `@anthropic-ai/sdk`/`openai` `devDependencies`. Leave `./langfuse` + `./otel` exports intact.

- [ ] **Step 8: Run + verify**
```
cd <worktree> && bun install            # regenerate lockfile after dep removal
cd server/typescript
bun test packages/ai-runtime            # all pass (cost.test gone; call-loop cost cases pass; langfuse/otel/composite/client/call-loop/smoke green)
bun run --filter '@metaobjectsdev/metadata' --filter '@metaobjectsdev/render' --filter '@metaobjectsdev/runtime-ts' --filter '@metaobjectsdev/ai-runtime' build
bun run --filter '@metaobjectsdev/ai-runtime' typecheck   # zero errors; no builtinCost/vendor refs
bun test packages/codegen-ts/test/ai-trace-sti.test.ts packages/codegen-ts/test/derive-trace-fields.test.ts  # codegen unaffected (generated helper never used the cut symbols)
```
- [ ] **Step 9: Re-grep** — `grep -rn "AnthropicClient\|OpenAIClient\|builtinCost\|ai-runtime/anthropic\|ai-runtime/openai" server/typescript --include=*.ts | grep -v node_modules | grep -v dist` → ZERO hits.

- [ ] **Step 10: Commit**
```bash
git add -A server/typescript/packages/ai-runtime bun.lock
git commit -m "feat(ai)!: descope ai-runtime — remove vendor clients + builtinCost rate table (ADR-0024)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-review notes
- Spec coverage: §1 remove → Steps 3-7; §2 cost → Steps 2-5; §3 deletion mechanics → Steps 6-7 + 9; §4 testing → Step 8.
- The CUT is destructive but ADR-0024-sanctioned; `CostFn` seam + `costMinor` column + LlmClient/callLlm/runLlmCall/Composite/Langfuse/Otel all KEPT.
- Most likely friction: a stray reference to a cut symbol elsewhere (Step 1 catches it); the `call<Entity>` generated code references `deps.cost?: CostFn` only (still valid — `CostFn` kept). No agent-context fragments touched (byte-gate unaffected).

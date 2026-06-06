# AI-trace P1 — Descope the TS ai-runtime surface — Design

_Date: 2026-06-06_
_Status: Design (approved for implementation — TS)_

## 0. Relationship to prior work

Phase 1 of [`docs/superpowers/plans/2026-06-06-ai-trace-descope-and-cross-port.md`](../plans/2026-06-06-ai-trace-descope-and-cross-port.md), governed by [ADR-0024](../../../spec/decisions/ADR-0024-ai-trace-scope-and-llm-caller-boundary.md) (MetaObjects owns the typed trace + recorder + vendor-neutral call glue; the provider call + pricing are bring-your-own). Builds on P0 (the recording core fix, shipped `021ff558`). The per-stack BYO-caller agent-context recommendation fragments already landed in `6deb0a99`; this phase adds the `LlmClient`-wiring detail to them and removes the vendor surface ADR-0024 cut.

## 1. Scope

**Remove (ADR-0024 CUT):**
- `AnthropicClient` (`packages/ai-runtime/src/anthropic.ts`) + its test + the `./anthropic` subpath export + the `@anthropic-ai/sdk` peer dep.
- `OpenAIClient` (`packages/ai-runtime/src/openai.ts`) + its test + the `./openai` subpath export + the `openai` peer dep.
- `builtinCost` + the `MODEL_RATES` table (`packages/ai-runtime/src/cost.ts`) + its `index.ts` export. **Keep the `CostFn` type** (the seam) + the `costMinor` column (unchanged in the metadata).

**Keep (ADR-0024):** `LlmClient`/`LlmRequest`/`LlmCompletion` seam, `Clock`/`IdGen`, `runLlmCall`, `callLlm`, `CompositeRecorder`, `LangfuseRecorder` (+ `langfuse` peer dep), `OtelRecorder` (+ `@opentelemetry/api` peer dep), the generated `record<Entity>`/`call<Entity>`.

**Out of scope (deferred):**
- **P1b — the agent-context fragment `LlmClient`-wiring enhancement.** Adding a "wire your LLM library behind `LlmClient`" snippet to each `references/<stack>.md` is desirable (ADR-0024 default) but touches the cross-port `agent-context-conformance` byte-gate (the bundle is emitted byte-identically by all 5 ports), so it warrants its own focused unit that regenerates the gate's expectations. Deferred to P1b. (Interim BYO guidance is not absent: the fragments already say "compose the call yourself" and `6deb0a99` shipped per-stack recommendations; the `LlmClient` seam is self-documenting via its types.)
- The `meta init` `llm-client.ts` scaffold (ADR-0024 "nice add").
- P2 (`TsPilotVocab`); P3 (cross-port).

## 2. The `cost` change (the one behavioral change)

`runLlmCall` currently does `const cost = deps.cost ?? builtinCost;` and always computes a cost. After removing `builtinCost`:
- `cost.ts` keeps only `export type CostFn = (model: string, usage: LlmUsage | undefined) => number | null;`.
- `runLlmCall` computes cost ONLY when `deps.cost` is provided: `if (deps.cost !== undefined && completion !== undefined) { const c = deps.cost(...); if (c !== null) recInput.costMinor = c; }`. No injected `CostFn` → `costMinor` stays unset (null in the row). This is correct per ADR-0024 ("ship no rates; adopter supplies the value").
- `index.ts` drops `builtinCost`, keeps `type CostFn`.
- The cost unit test (`cost.test.ts`) is **deleted** (it tested `builtinCost`); `call-loop.test.ts`'s cost assertion switches from relying on the `builtinCost` default to **injecting a `CostFn`** (e.g. `cost: () => 75`) and asserting `costMinor === 75`, plus a case with no `cost` dep asserting `costMinor` is absent/null.

## 3. Deletion mechanics

- Delete `src/anthropic.ts`, `src/openai.ts`, `test/anthropic.test.ts`, `test/openai.test.ts`, `test/cost.test.ts`.
- `package.json`: remove the `./anthropic` + `./openai` entries from `exports`; remove `@anthropic-ai/sdk` + `openai` from `peerDependencies` + `peerDependenciesMeta` (keep `langfuse` + `@opentelemetry/api`). Remove any `@anthropic-ai/sdk`/`openai` devDependencies if present.
- Confirm nothing else in the workspace imports `@metaobjectsdev/ai-runtime/anthropic` / `/openai` / `builtinCost` (grep). The generated `call<Entity>` takes an injected `client` + optional `cost` — it never referenced the vendor clients or `builtinCost`, so codegen is unaffected.

## 4. Testing
- `bun test packages/ai-runtime` green after deletions (cost test deleted; call-loop cost assertion injects a `CostFn`).
- Build + typecheck: `ai-runtime` typechecks with no `builtinCost`/vendor-client references; `codegen-ts` unaffected (the generated helper never referenced them).
- A grep-gate (by the implementer) confirms no remaining references to the deleted symbols/subpaths (`AnthropicClient`, `OpenAIClient`, `builtinCost`, `/anthropic`, `/openai`) anywhere in the workspace.
- No agent-context fragments are touched in P1 (their enhancement is P1b) → the `agent-context-conformance` byte-gate is unaffected.
- No live LLM/service in CI.

## 5. Decisions recorded
- `builtinCost` + `MODEL_RATES` removed; `CostFn` seam kept; `runLlmCall` no longer defaults cost (cost only when injected).
- Vendor clients (`AnthropicClient`/`OpenAIClient`) + their subpaths + the `@anthropic-ai/sdk`/`openai` peer deps removed; `langfuse`/`@opentelemetry/api` recorders kept.
- BYO-caller guidance: the existing per-stack agent-context recommendation fragments stand as the interim guidance; enhancing them with the explicit `LlmClient`-wiring snippet is **P1b** (separate, to handle the `agent-context-conformance` byte-gate); the `meta init` scaffold is deferred.

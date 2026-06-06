# AI-trace: descope + cross-port — program plan

> **For agentic workers:** this is a PROGRAM plan spanning multiple ports. Each phase below gets its own detailed (bite-sized, TDD) implementation plan via superpowers:writing-plans at execution time. Do NOT execute a phase from this document alone — it defines deliverables, sequence, and acceptance gates, not per-step instructions.

**Goal:** Realign the AI LLM-trace stack to [ADR-0024](../../../spec/decisions/ADR-0024-ai-trace-scope-and-llm-caller-boundary.md): own the typed trace + recorder + vendor-neutral call glue; drop the vendor implementations + pricing table; fix the broken core; and cross-port the recording half (JVM/Python/C#/Kotlin) with bring-your-own caller delivered as per-stack guidance.

**Governing decision:** ADR-0024 (keep/cut/fix/port + BYO-caller boundary). Read it first.

**Public-repo hygiene:** the metaobjects repo is PUBLIC. No adopter/app names, no local paths, in any committed artifact — refer to "an adopter", "a JVM/Spring adopter", "a Python adopter", "downstream consumers".

---

## Phase 0 — Fix the core (TypeScript). *Blocks everything; do first.*

The recording half is the thing being standardized + ported; it must be correct before it's replicated. Detailed plan at execution time; deliverables:

1. **One canonical `LlmCallBase` whose fields == the recorder's row keys**, with a gate test asserting `recordLlmCall`'s row keys ⊆ the base's effective fields. Today they disagree (recorder writes `voResponse`, which the shipped base lacks → documented path throws). Fix in `library/ai/llm-call.yaml` + `runtime-ts/src/llm-recorder.ts`.
2. **Wire or remove `voRequest` / `system` / `llmResponse`.** `voRequest` (typed request) is the headline wedge — thread the typed request VO through `LlmCallInput` and write it. Decide `system` (provider name) + `llmResponse` (raw response): write them or delete the columns. No dead columns.
3. **Unify happy-path + error-path row construction** into one factory in `runtime-ts`/`ai-runtime` (today the error row is hand-duplicated).
4. **Redaction/size seam:** add `redact?(row) => row` (+ optional truncation) to `RecordLlmCallOptions`/recorder, applied before persist. Document that `params` must not carry credentials.
5. **`LlmCallDbRecorder` never throws into the call path** (wrap the `om.create`; surface via an `onError` like the composite/export recorders).

**Acceptance:** a test exercises the *shipped* `LlmCallBase` (not a bespoke entity) end-to-end via `record<Entity>`/`call<Entity>` against Testcontainers PG; the recorder↔base contract gate is green; no dead columns; redaction seam covered.

---

## Phase 1 — Descope the TS surface. *After P0.*

Apply ADR-0024's CUT to the TS `@metaobjectsdev/ai-runtime` package. Deliverables:

1. **Delete `AnthropicClient` + `OpenAIClient`** (`src/anthropic.ts`, `src/openai.ts` + tests + the `./anthropic`/`./openai` subpath exports + their optional peer deps).
2. **Delete `builtinCost`'s rate table; keep the `CostFn` *type*** (the seam) and the `costMinor` column. `callLlm` takes an injected `cost?: CostFn` (no default rate map). Update tests.
3. **Keep** the `LlmClient` seam, `callLlm`, `Clock`/`IdGen`, `CompositeRecorder`, and `LangfuseRecorder`/`OtelRecorder` (optional, lowest-priority; flagged droppable if maintenance bites).
4. **Add the BYO-caller guidance (TS):** a downstream agent-context fragment recommending the Vercel AI SDK behind `LlmClient`, with a ~10-line example; and a `meta init` scaffold dropping a starter `llm-client.ts`. (See the agent-context downstream mechanism already in the repo.)

**Acceptance:** `ai-runtime` ships no vendor-SDK client and no rate table; `LlmClient`/`callLlm`/`call<Entity>` still work with an injected client; greenfield TS path documented + scaffolded; suite green.

---

## Phase 2 — Resolve the `TsPilotVocab` carve-out. *Decision gate before P3.*

`@responseRef` + `template.prompt`-as-`object.entity`-child are carved out of cross-port registry-conformance and ledgered as known-gaps in 3 ports. With cross-porting committed (P3), **promote them to all five ports**: register `@responseRef`, admit the `template.prompt` child rule, wire into the sealed registry + `registry-conformance` manifest, delete the `TsPilotVocab` exclusion, and un-ledger the `ai-trace-prompt-nested` + `ai-trace-sti` fixtures. (Fallback if P3 is abandoned: revert the two metamodel additions; keep the trace base to plain-entity vocabulary that already passes cross-port.)

**Acceptance:** registry-conformance green in all five ports with `@responseRef` + the template-child rule present; no `TsPilotVocab` member; the two `ai-trace-*` fixtures un-ledgered (or the metamodel additions reverted).

---

## Phase 3 — Cross-port the recording half + call glue. *JVM first (the live driver).*

For each port, replicate the (now-fixed) recording half + vendor-neutral call glue. **No vendor adapters, no rate table** (ADR-0024). Sequence: **JVM → Python → C# → Kotlin** (JVM first because the live driver is a JVM/Spring adopter; Python second because the next adopter is Python).

Per-port deliverables (each gets its own detailed plan):
1. **`LlmCallBase`** available via the port's `library/` embed + `libraries` opt-in (the YAML is shared; the embed mechanism is per-port).
2. **Recorder seam** — `LlmRecorder` + `NullRecorder` + DB recorder in the port's data-access idiom (OMDB/Spring-tx for JVM, SQLAlchemy for Python, EF Core for C#, Exposed for Kotlin) + `recordLlmCall` (parse-then-persist via the port's `extract`).
3. **`deriveTraceFields`** loader pre-pass (typed `voRequest`/`voResponse` injection) — study the TS reference; this is loader-pipeline work (per CLAUDE.md, port from the reference, don't re-derive).
4. **`record<Entity>` + `call<Entity>` codegen** in the port's idiom (Spring repo / Pydantic / EF Core / Exposed), `call<Entity>` taking an injected `LlmClient`-equivalent.
5. **`LlmClient` seam + thin `callLlm`** (vendor-neutral; no provider impl).
6. **BYO-caller guidance:** a per-stack agent-context fragment recommending the idiomatic library (Spring AI/LangChain4j; LiteLLM; Microsoft.Extensions.AI) + an `init` scaffold.
7. **Conformance:** un-ledger `ai-trace-prompt-nested` + `ai-trace-sti` for the port; a persistence round-trip (the port's Testcontainers-PG harness) proving typed `voResponse` round-trips and STI shares one table.

**Per-port acceptance:** the shipped `LlmCallBase` + generated `record`/`call<Entity>` work end-to-end against Testcontainers PG; conformance fixtures green (un-ledgered); no vendor adapter or rate table shipped.

---

## Sequence + gates (summary)

```
P0 (TS fix core) ──► P1 (TS descope) ──► P2 (resolve carve-out) ──► P3 (port: JVM → Python → C# → Kotlin)
   gate: shipped-base          gate: no vendor          gate: registry          gate per port: shipped-base
   contract green + no         client/rate-table;       conformance green       e2e + fixtures un-ledgered;
   dead cols + redaction       greenfield doc+scaffold  in 5 ports; no          no vendor adapter
                                                        TsPilotVocab member
```

**Standing rule for every phase:** run the pre-merge gate (code-reviewer + code-simplifier) before merging each unit; do feature work in a `.claude/worktrees/` worktree off the current `origin/main`; never hit a live LLM/service in CI (canned clients, Testcontainers PG only).

## What this plan deliberately does NOT do
- Build/maintain per-vendor SDK adapters or a pricing table in any port (ADR-0024 CUT).
- Codegen the SDK adapter (no metadata source).
- Absorb multi-span agent-trace trees / tool/memory/embedding event tables (that is an adopter's observability platform, not the standard — the `traceId`/`parentSpanId` fields are the link-out hook).
- Own evals/dashboards/playground (off-the-shelf tools + the adopter own these; the trace store merely enables linking by call id).

# ADR-0024 — AI-trace scope: the typed trace + recorder is the standard; the LLM caller is bring-your-own

**Status:** Accepted (2026-06-06)
**Deciders:** human (project owner) + Claude
**Relates to:** ADR-0020 (codegen tiering — native per-port vs. language-neutral), ADR-0023 (strict metadata provenance), and the AI LLM-trace design docs (`docs/superpowers/specs/2026-06-02-ai-llm-call-trace-persistence-design.md`, `2026-06-05-ai-runtime-call-loop-and-recorders-design.md`, `2026-06-05-ai-trace-1c-shared-table-sti-design.md`).

## Context

The AI LLM-trace stack shipped TypeScript-first across four arcs (#1 shipped `LlmCallBase` metadata + loader `libraries` opt-in; #1b `@responseRef` + `deriveTraceFields` + `record<Entity>`; #2/#3 `@metaobjectsdev/ai-runtime` = `LlmClient` seam + `callLlm` + `builtinCost` + Composite/Langfuse/OTel recorders + `AnthropicClient`/`OpenAIClient` + `call<Entity>`; #1c shared-table STI via TPH).

A staff review plus a survey of several real downstream adopters (a JVM/Spring adopter, a Python agent engine, a TS edge app) established five facts:

1. **The unique, defensible value is the *typed* trace** — request/response persisted as typed value objects in the adopter's own database, the same payload projection the prompt pillar declares and drift-checks at build time. No off-the-shelf observability tool (Langfuse/Helicone/Braintrust/Phoenix/LangSmith) can do this; they store opaque/loosely-typed blobs by construction. This is a real, narrow moat.
2. **Every surveyed adopter already has its own LLM-calling layer** (provider client, fallback/routing, retries, cost tracking) and would not replace it. They built their own only because nothing existed; what they want from the library is a place to *record* the call as typed data, not a new caller.
3. **The shipped vendor adapters + pricing table are off-mission and a maintenance treadmill.** `AnthropicClient`/`OpenAIClient` chase vendor-SDK churn; `builtinCost`'s hardcoded rate map goes stale within a quarter — in a project whose pitch is catching drift. Shipping these drifts toward the explicitly-out-of-scope "LLM provider" (CLAUDE.md → Explicitly out of scope).
4. **The whole stack is TS-only**, with a `TsPilotVocab` carve-out excluding `@responseRef` (and `template.prompt`-as-`object.entity`-child) from the cross-port registry-conformance gate. A permanent carve-out erodes the byte-identical-cross-port invariant that is the project's core identity.
5. **A correctness bug exists:** `recordLlmCall` writes a `voResponse` column the shipped `LlmCallBase` does not declare (so the documented `extends LlmCallBase` + generated-`record<Entity>` path throws `Unknown field`), while `voRequest`/`system`/`llmResponse` are declared/injected but never written (dead columns). The green tests pass only because they bypass the shipped base with bespoke entities.

A from-scratch adopter, by contrast, *would* want a convenience loop (render → call → record). So the boundary is not "calling = out"; it is "the vendor-neutral call glue is in; the vendor implementation + pricing are out."

## Decision

**MetaObjects owns the recording (typed trace + build-time drift + recorder seam) and the vendor-neutral call glue. It does NOT own the provider call or pricing — those are bring-your-own, satisfied by the ecosystem's LLM libraries plugged into a one-method seam.**

### KEEP (own; cross-port)
- **`LlmCallBase` typed-trace data model** + the `library/` shipping mechanism + the loader `libraries: ["ai"]` opt-in.
- **Recorder seam:** `LlmRecorder` interface + `NullRecorder` + `LlmCallDbRecorder` + `CompositeRecorder`. This is the plug adopters integrate into their existing caller. (A surveyed Python adopter independently invented the identical Protocol+null-recorder seam — strong convergence evidence.)
- **`recordLlmCall`** (parse-then-persist) and the **typed `voRequest`/`voResponse`** columns + **`deriveTraceFields`** — the wedge.
- **`record<Entity>` and `call<Entity>` codegen** — the latter is the greenfield convenience (render → call-via-injected-client → record in one typed call).
- **`LlmClient` *interface* + `callLlm` thin loop + `Clock`/`IdGen`** — the **vendor-neutral** call glue. `LlmClient` is a one-method contract (`complete(request) → completion`); it names no vendor.
- **`@responseRef`** + **`template.prompt` as a child of `object.entity`** — required to derive the typed response column. (Must be cross-ported — see "Resolve the carve-out.")
- **#1c shared-table STI** (reuses FR-017 TPH) and the **build-time drift gate** (`verify`).
- **`CostFn` seam + the `costMinor` column** (the trace stores cost; the adopter supplies the number).

### CUT (do not ship or maintain in the standard)
- **`AnthropicClient` / `OpenAIClient`** — vendor-SDK implementations. A greenfield adopter is better served plugging the ecosystem's library (see "BYO caller") into the `LlmClient` seam than using a hand-rolled SDK wrapper we would have to chase. Shipping these is the provider treadmill.
- **`builtinCost`'s hardcoded rate table** — keep the `CostFn` seam; ship no rates. A pricing table the project won't maintain is worse than none.

### FIX (before any cross-porting)
1. **Reconcile the recorder ⇄ base contract:** one canonical `LlmCallBase` whose fields are exactly the recorder's row keys, with a test gating `recordLlmCall`'s keys ⊆ the base's effective fields.
2. **Wire or remove `voRequest`/`system`/`llmResponse`.** The typed-request half (`voRequest`) is the headline wedge — wire it, or the feature is "typed response only."
3. **Unify** the happy-path and error-path row construction into one factory (today the error row is hand-duplicated — the exact drift this feature exists to prevent).
4. **Add a redaction/size seam** before persist (prompts/responses/params hold PII + secrets; a trace store must let adopters scrub + cap).
5. **`LlmCallDbRecorder` must not throw into the call path** (telemetry never breaks the app — match the seam's own contract).

### BYO caller — how an adopter obtains a `LlmClient`
The single value an adopter brings is the `client` in `call<Entity>(payload, { client })`. The library does not ship the client. Per port, in priority order:
1. **Default — per-stack agent-context recommendation (markdown).** The existing downstream agent-context channel ships a per-stack `references/*.md` fragment: "implement `LlmClient` over `<the idiomatic LLM library for this stack>`," with a ~10-line example. Zero maintenance; adopter controls the SDK version; each app picks the library that fits it.
   - TS → Vercel AI SDK; Python → LiteLLM (or Instructor/Pydantic-AI for typed output); JVM → Spring AI or LangChain4j; C# → `Microsoft.Extensions.AI` / Semantic Kernel.
2. **Nice add — one-time `init` scaffold.** `meta init` (per-port equivalent) drops a starter `llm-client.*` wired to the stack's standard library, which the adopter then owns and edits. A scaffold, not a regenerated artifact — no churn liability.
3. **On demand only — one optional thin adapter per port to the ecosystem *aggregator*** (AI SDK / LiteLLM / Spring AI / Microsoft.Extensions.AI), with the library as an optional/peer dep. Adapt to the *thing that itself abstracts providers* (one stable target), never to the providers (many churning targets). Build only if adopters ask.

### NEVER
- **Codegen the SDK adapter.** The vendor library's request/response shape is not in the metamodel and changes with SDK versions — codegen has nothing to derive from. (Generating `call<Entity>`, which takes an *injected* client, is fine and stays — that is metadata-driven.)
- **Maintained per-vendor adapters in core** (`AnthropicClient`-style) — the treadmill.

### Resolve the carve-out
`TsPilotVocab` is not a steady state. With cross-porting committed (below), **promote `@responseRef` + `template.prompt`-as-`object.entity`-child to all five ports** and delete the carve-out + un-ledger the `ai-trace-*` conformance fixtures. (The fallback, if cross-port is abandoned, is to revert those two metamodel additions and keep the trace base to the plain-entity form that already passes cross-port clean.)

## Consequences

**Positive:** stays on mission (codegen + prompt pillars), off the LLM-provider treadmill; honors the cross-port invariant (no permanent carve-out); lets adopters consolidate their hand-rolled per-call recorders onto one typed, drift-gated standard; the differentiated parts are owned, the commodity part is borrowed from the ecosystem.

**Negative / cost:** reverses part of shipped #2/#3 (delete `AnthropicClient`/`OpenAIClient` + the `builtinCost` rate table). Requires the FIX work before porting, and the cross-port of the recording half + call glue to JVM/Python/C#/Kotlin. This is data-access + codegen per port (which all ports already do) — materially smaller than porting the (now-cut) vendor/calling layer would have been.

**Per ADR-0020:** the `LlmClient`→real-library wiring is inherently per-language (a different library each) → it is **Tier-1 per-port guidance** delivered via agent-context, not a Tier-2 shared neutral artifact.

## Implementation
Sequenced in `docs/superpowers/plans/2026-06-06-ai-trace-descope-and-cross-port.md`: P0 fix the core (TS), P1 descope (TS), P2 resolve the carve-out, P3 cross-port the recording half + call glue (JVM driver first), each port shipping the recorder + typed `LlmCallBase` + `record`/`call<Entity>` codegen + an agent-context LLM-library fragment (+ `init` scaffold), and **no maintained vendor adapters**.

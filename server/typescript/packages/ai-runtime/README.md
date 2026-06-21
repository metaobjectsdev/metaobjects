# @metaobjectsdev/ai-runtime

LLM call loop + typed-trace recorder adapters for MetaObjects — a provider-neutral `LlmClient` seam, a `callLlm` bridge, and Composite / Langfuse / OpenTelemetry trace recorders. Bring your own LLM client and cost function (ADR-0024); the seams and recorders live here.

Part of the [MetaObjects](https://github.com/metaobjectsdev/metaobjects) monorepo.

## Install

```bash
npm install @metaobjectsdev/ai-runtime
```

## What it provides

- **`LlmClient`** — a provider-neutral seam you implement (or adapt) for your LLM vendor; no vendor SDK is bundled.
- **`callLlm`** — the call bridge that invokes your client and records a typed trace of each call (request/response/cost).
- **Trace recorders** — `Composite`, `Langfuse`, and OpenTelemetry adapters; plug in your own via the recorder interface.
- **`CostFn`** — a pluggable cost function seam (no built-in rate table — supply your vendor's pricing).

Pairs with the generated `call<Entity>` helpers and the metadata-native LLM-call trace persistence (typed `voRequest` / `voResponse` jsonb columns derived from a declared `template.prompt`). See the **metaobjects-prompts** skill and the repo `docs/` for the trace-persistence flow.

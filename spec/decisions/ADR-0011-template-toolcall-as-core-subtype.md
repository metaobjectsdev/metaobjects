# ADR-0011 — `template.toolcall` as a core MO subtype

**Status:** Accepted — 2026-05-27
**Applies to:** all language ports (TS, Java, Python, C#, Kotlin)
**Related:** ADR-0004 (provider-based type registration), ADR-0007 (source v2 paradigm subtypes + `@kind` discriminator), ADR-0010 (template.output parser codegen), `docs/features/extending-with-providers.md`.

## Context

LLM tool-call envelopes are a near-universal concept in modern LLM applications:
Anthropic's `tool_use`, OpenAI's function-calling, Mistral's tools, Google
Gemini's function-calling, and MCP's tool definitions all describe variations
of the same shape — **a named tool with a typed input schema that the LLM can
invoke, producing a structured payload the consumer parses and uses**.

The first consumer to declare this concept in metadata (a downstream
reference-implementation project) initially modeled it via the
**consumer-provider extension** mechanism — a project-local provider
registered `template.toolcall` with `@toolName` / `@payloadRef` /
`@retryReminder` / `@fallback` attrs. This worked but raised two questions:

**(1)** Should every LLM-using consumer reinvent this subtype, or should MO
core ship it once and let consumers extend with vendor-specific attrs?

**(2)** If MO core ships it, where does it sit — under `template.*` (the
namespace for "renderable artifacts bound to a typed payload") or as a new
top-level type?

## Decision

**MO core ships `template.toolcall` as a third sibling subtype** alongside
`template.prompt` and `template.output`, with three vendor-agnostic attrs:

| Attr | Required | Description |
|---|---|---|
| `@toolName` | yes | Wire tool name surfaced to the LLM (vendor-specific format). |
| `@payloadRef` | yes | Output value-object the tool produces (resolved against the metamodel). |
| `@description` | no | Tool description surfaced to the LLM for selection. |

**Crucially, `template.toolcall` does NOT inherit `genericAttrs`** (the
`@payloadRef` + `@textRef` + `@format` set required by `template.prompt` and
`template.output`). It declares its own attrs. `@payloadRef` IS required —
identically named to the generic attr but declared explicitly on this subtype.
`@textRef` is NOT required because a tool-call has no renderable text body —
the body IS the structured output schema (resolved via `@payloadRef`).

This is the precise design rationale (per
[`docs/features/extending-with-providers.md` § "When to escalate to a new
subtype"](../../docs/features/extending-with-providers.md)): when the closest
existing subtype's required attrs don't apply, subtype escalation is honest.

## Why under `template.*` rather than a new pillar

Considered and rejected: a new top-level type `tool.*` with subtypes per
vendor (`tool.anthropic`, `tool.openai`, etc.).

Reasons against:

- **Namespace cohesion.** `template.*` is already MO's family of
  "LLM-interaction concerns." A toolcall sits naturally there, even though it
  isn't *literally* renderable text. The conceptual coupling is tight enough
  that splitting across pillars would harm discoverability.
- **Vocabulary footprint.** Adding a new pillar costs every port a new
  registry slot, a new conformance section, new docs pages, and a new mental
  model. The marginal benefit of "tools are not templates" purity is small
  compared to the cost.
- **Vendor sub-subtype proliferation.** A `tool.anthropic` / `tool.openai`
  approach forces vendor identity into the metadata vocabulary rather than
  the consumer-extension layer. Vendor differences are *wire details*, not
  *metamodel structure*.

## Vendor specifics stay at the consumer layer

Each LLM vendor's wire details (retry semantics, fallback shapes, cache
control hints, parallel-invocation rules, vendor-specific tool naming
conventions) are added via consumer-supplied providers using
`registry.extend(TYPE_TEMPLATE, "toolcall", { attributes: [...] })`. This
mirrors how `dbProvider` extends `source.rdb` with `@column` and `@db.indexed`
without forcing those into core.

Example (a downstream Anthropic-flavored extension):

```ts
const anthropicToolcallProvider: MetaDataTypeProvider = {
  id: "myapp-anthropic-toolcall",
  dependencies: ["metaobjects-core-types"],
  registerTypes(registry) {
    registry.extend(TYPE_TEMPLATE, "toolcall", {
      attributes: [
        { name: "retryReminder", valueType: ATTR_SUBTYPE_STRING, required: false,
          description: "Anthropic-specific: reminder appended on retry when tool_use parse fails." },
        // @fallback omitted from declared attrs — its value is a structured
        // object literal and the loader's open-policy on undeclared @-attrs
        // accepts it. Reader-side codegen interprets it.
      ],
    });
  },
};
```

Future OpenAI / Mistral / MCP consumers add their own vendor providers the
same way. **Core stays vendor-neutral; consumers add the wire details.**

## Industry alignment

Cross-checked against major LLM frameworks: LangChain (`BaseTool` ≠ `BasePromptTemplate`),
Vercel AI SDK (`tool({description, parameters, execute})`), OpenAI function-calling
spec, Anthropic `tool_use` block schema. Every framework treats tools as a
distinct abstraction from prompts.

MO's decision differs from the framework convention by keeping toolcall in the
`template.*` namespace, but matches the convention by giving it a separate
*subtype identity* (not just attrs on `template.prompt`). The compromise — same
namespace, separate subtype — preserves namespace cohesion without conflating
the two concepts at the structural level.

## Why not `template.prompt + @kind` discriminator

The `template-constants.ts:6-8` design note anticipates "future structured-prompt
(role/turn/tool) divergence" within `template.prompt`. Considered: model toolcall
as `template.prompt` with `@kind: tool` (mirroring `source.rdb @kind`).

Reasons against:

- **`template.prompt` requires `@textRef`** (the renderable body). Toolcalls
  have no rendered body. Making `@textRef` optional weakens the
  renderable-template invariant across all `template.prompt` consumers.
- **The "role/turn" divergence** the design note anticipated IS within-prompt
  aspects (a single prompt has a role; a single prompt is one turn in a
  conversation). The "tool" aspect is structurally different — it's not a
  prompt with tools, it's a tool definition that prompts can reference.
- **`@kind` on `source.rdb` discriminates within a single conceptual home**
  (a table and a view are both "things you query SQL against"). Tools vs.
  prompts is cross-concept; subtype boundary is the honest split.

## Consequences

**+** Every LLM-using MO consumer gets the toolcall vocabulary out of the box.
No reinvention; conformance fixtures validate the contract cross-port.

**+** Vendor-specific extensions remain the consumer's responsibility,
preserving the consumer-provider pattern as the canonical "vendor flavor"
escape hatch.

**+** Downstream reference implementations simplify: a project-local
provider shifts from `registry.register` (creating the toolcall subtype
from scratch) to `registry.extend` (adding vendor-specific attrs to the
core subtype) — a smaller, more idiomatic demonstration of how downstream
consumers add vendor specifics to universal core concepts.

**−** Adds a third subtype to a previously two-subtype-only family. The
explicit `genericAttrs`-vs-`toolcallAttrs` split in `template-schema.ts`
introduces a small asymmetry future contributors must understand.

**−** Locks MO into `toolcall` as a vendor-neutral concept. If future vendor
divergence becomes severe enough that the core attrs themselves vary by
vendor, this will need to be revisited. Currently `@toolName` + `@payloadRef`
+ `@description` is the universal intersection of all major LLM-vendor tool
specs; this seems durable.

## Cross-port rollout

- **TypeScript (rc.5):** ship core subtype + conformance fixture coverage.
  Conformance-fixture test-only providers shift from registering
  `template.toolcall` (now core) to a different test-only subtype (e.g.,
  `template.briefing`) to keep the provider-extension fixtures meaningful.
  Downstream reference-impl consumers migrate from `registry.register`
  (creating the subtype) to `registry.extend` (adding vendor-specific attrs).
- **Java / C# / Python (rc.6 follow-up):** mirror the subtype registration +
  attr set. The cross-port conformance fixtures already in place gate the
  rollout.
- **Kotlin:** inherits the Java port; nothing to do beyond Java.

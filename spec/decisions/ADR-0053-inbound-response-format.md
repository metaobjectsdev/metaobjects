# ADR-0053: The reply's syntax is `@responseFormat` on `template.prompt`

## Status

**Accepted** (2026-08-19). Closes the open question left by
[ADR-0052](ADR-0052-template-direction-outbound-vs-inbound.md) — where the inbound (LLM-response)
format lives once the parser-on-receipt is driven from `template.prompt @responseRef`. Breaking only
in company with ADR-0052; on its own it is additive.

## Context

ADR-0052 moves the inbound half of the prompt pillar — the response shape, the FR-010
output-format fragment, and the parser-on-receipt — from `template.output` onto
`template.prompt @responseRef`. It deliberately did not decide where the *syntax of the reply*
lives, on the grounds that settling a vocabulary question inside a re-homing decision smuggles an
attribute addition past ADR-0037's procedure.

That deferral does not survive contact with the code: **the inbound tier cannot be re-pointed
without an answer.** Every inbound emitter in all five ports dispatches on exactly one bit — is the
reply JSON or XML — and it currently reads that bit from `template.output @format`. Move the tier
and the bit has no source.

**`template.prompt @format` cannot serve.** It is already the syntax of the *rendered prompt body*,
which is what drives the render engine's escaper and whitespace. The two are genuinely independent,
and the repository already contains the counterexample. In
`server/typescript/packages/docs-site/test/fixture/input/acme/ai/meta.ai.yaml` a prompt renders as
plain text and its response is XML — declared, before this ADR, as two nodes:

```yaml
- template.prompt:  { name: npcReview,       "@responseRef": NpcResponse, "@format": text }
- template.output:  { name: npcReviewOutput, "@payloadRef":  NpcResponse, "@format": xml  }
```

The response's XML-ness is intrinsic, not incidental: `NpcResponse.reason` carries `@xmlText: true`.
One attribute cannot hold `text` and `xml` at once.

**The overload is already shipping, and is already a latent defect.**
`codegen-ts/src/generators/trace-helper-file.ts:116-143` reads a single
`template.prompt @format` twice — once as the reply syntax (`"xml"` → `Format.XML`, else
`Format.JSON`) and once as the prompt body's render format — under a comment that names the
collision outright: *"Same @format attr, two intentionally different shapes."* A prompt whose body
is markdown and whose reply is XML is mis-parsed by that helper today.

**Reusing `@format` would also fail closed in the wrong direction.** `@format` defaults to `text`.
Gating inbound codegen on it means a prompt that declares `@responseRef` but omits `@format` gets
**no parser at all, silently** — the mirror image of the absurd artifact ADR-0052 exists to remove.

## Decision

**Register `@responseFormat` on `template.prompt`: optional, closed enum `json | xml`, default
`json`.** It is the syntax of the model's *reply*. `@format` keeps its existing meaning on both
subtypes: the syntax of the *rendered body*.

The inbound codegen tier gates on **`@responseRef` presence**, never on a format value. Declaring a
response shape is the request for a parser; the format only selects which parser.

### Clearing ADR-0037's decision procedure

ADR-0037 asks what a candidate *does*, in order:

- **(0) Derivable** from an existing subtype + attrs + structure? **No.** The only candidate source,
  `@format`, is occupied by an independent fact about the opposite direction, and the docs-site pair
  proves the two values differ in practice. A third value cannot be derived from a two-valued
  attribute that is already fully spent.
- **(1) Physical-only** — native type and meaning unchanged? **No.** It selects a parser and a
  prompt fragment, both of which change generated behaviour.
- **(2) Own native type, behaviour, or attributes?** **No.** A reply syntax is not a *thing* that
  owns custom logic and it is not a structural variant of a type — it *configures* how an existing
  type's inbound half behaves. ⇒ **attribute**, not a subtype and not a `@kind`.
- **No same-name overload.** `@responseFormat` is deliberately not a second `@format`; ADR-0037
  prefers self-documentation over economy, and the whole defect being closed here is one name
  meaning two things.

### Why the enum is `json | xml` and not `@format`'s seven members

Every shipping consumer of the reply syntax dispatches on exactly two values — `Format.JSON` and
`Format.XML` — in all five ports. Registering `text`, `html`, `csv`, `markdown` or `spreadsheet`
would put members in the registry that nothing dispatches on, which is precisely what
[ADR-0007](ADR-0007-source-v2-paradigm-subtypes-multisource.md) Amendment 2 and
[ADR-0040](ADR-0040-index-type-and-secondary-key-purity.md) forbid. Those five are
**reserved-not-registered**; the re-entry bar is the standing one: *a member enters the registry
only when a shipping consumer dispatches on it.*

### Why the default is `json`

`trace-helper-file.ts:120-122` already treats anything that is not `xml` as JSON. Defaulting
`@responseFormat` to `json` reproduces that behaviour exactly, so every existing `@responseRef`
carrier whose reply is JSON needs no edit, and only the XML cases become explicit. The default is
therefore behaviour-preserving rather than a new policy.

## Consequences

**Additive to the registry, in all five ports.** `expected-registry.json` gains one attribute on
`template.prompt`. A project that declares no `@responseRef` sees no change.

**It removes an ambiguity rather than adding one.** After this, `@format` answers "how is this body
written?" on both subtypes, and `@responseFormat` answers "how is the reply written?" on the one
subtype that can have a reply. Neither name can be read two ways.

**It fixes the trace helper.** `trace-helper-file.ts` stops deriving the reply syntax from the
prompt body's format and reads `@responseFormat` instead. A markdown prompt expecting an XML reply
now parses correctly — a behaviour change, and a correction of previously-wrong behaviour.

**`@promptStyle` travels with it.** ADR-0052 moves `@promptStyle` to `template.prompt`; both
attributes now describe the same inbound contract from the same node, which is what makes the FR-010
fragment and the parser agree by construction instead of by convention.

## Alternatives considered

**Hang the format off the response `object.value`.** Coherent — the shape and its syntax travel
together — and it adds no attribute to `template.*`. Rejected because a value object is reusable by
construction: binding a syntax to a shape means two prompts that share a response shape cannot
disagree about its wire syntax, and the shape has no way to know which call produced it. The syntax
is a property of the exchange, not of the data.

**Reuse `template.prompt @format` for both directions.** Zero new vocabulary, and it is what the
trace helper already does. Rejected on the evidence above: it makes the text-prompt/XML-reply case
inexpressible, it silently emits nothing when `@format` is absent, and it preserves the exact
one-name-two-meanings defect this ADR exists to close.

**A `template.response` subtype carrying both `@promptStyle` and the format.** Rejected in ADR-0052
for reasons that still hold: it adds registered vocabulary to express what `@responseRef` already
expresses, and it detaches the response contract from the call that elicits it.

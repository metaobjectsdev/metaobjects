# ADR-0052 — A template's subtype axis is DIRECTION: `template.output` renders outbound, a response is parsed inbound

_Status: accepted. 2026-08-19. Narrows [ADR-0010](ADR-0010-template-output-parser-codegen.md) (parser-on-receipt) and the FR-010 output-format fragment onto `template.prompt @responseRef`. Breaking; rides the coordinated pre-1.0 breaking slot alongside FR-037/FR-038._

## Context

`template.output` currently means two unrelated things, and its own registry description
says only one of them:

> An output / serialization template (FR-004): **every rendered artifact other than an LLM
> prompt** — a document (email, export, docs, config) or an email.

That is a statement about **outbound rendering**. But the same subtype also owns the
**inbound** half of the prompt pillar:

- `@promptStyle` — *"FR-010 output-format **prompt** presentation: 'guide' / 'inline' /
  'exampleOnly'"*. This generates a fragment **instructing an LLM how to format its reply**.
  It is an attribute about talking to a model, hosted on the subtype defined as everything
  that is *not* an LLM prompt.
- The FR-006 **parser-on-receipt** (ADR-0010), generated from `template.output` in all five
  ports.

So one subtype spans both directions, and the contradiction is visible in a single
attribute description.

**The tell is an artifact nobody would author.** `output-parser-file.ts` filters on
`TEMPLATE_SUBTYPE_OUTPUT` with **no `@kind` filter at all**, so declaring an email template
generates `WelcomeEmail.output.ts` — a parser for text the system just rendered and sent.
That is not a bug in the filter; it is what falls out when one subtype means two things.

**The ambiguity has an adopter-visible cost: two spellings for one question.** "What shape
does a model's response have?" can be declared either as

1. `template.prompt @responseRef` → a payload shape (what `trace-helper-file.ts` already
   consumes: *"@responseRef types the result; @payloadRef types the request"*), or
2. `template.output @payloadRef` + the generated parser.

Both work. Nothing says which is intended, they emit different artifacts, and the adopter in
[#309](https://github.com/metaobjectsdev/metaobjects/issues/309) reasonably chose (2).

## Decision

**A template subtype's axis is DIRECTION.**

- **`template.output` is OUTBOUND ONLY** — a rendered artifact for a person or a file.
  Keeps `@kind` (`document` | `email`), `@textRef`, `@subjectRef`, `@htmlBodyRef`,
  `@textBodyRef`, `@format`. It generates **no parser**.
- **The INBOUND half moves to `template.prompt @responseRef`** — the response shape, the
  FR-010 output-format fragment, and the parser-on-receipt. `@promptStyle` re-homes to
  `template.prompt`.

`template.prompt` gains **no email vocabulary** and no new reference attr: `@responseRef`
already exists and already means precisely this.

## Why this is a correction, not a redesign

The metamodel had already decided it; the code did not follow. `template.output`'s shipped,
byte-gated description excludes LLM prompts, and `@responseRef` already denotes the response
shape. This ADR makes the emitters agree with text that has shipped in five ports since
FR-004.

It also **shrinks** vocabulary rather than growing it — two spellings collapse to one — which
is the direction ADR-0037's decision procedure prefers, and it restores `@promptStyle` to a
subtype where its name is not self-contradictory.

**A response only exists for a request.** That is the load-bearing reason the inbound half
belongs to the prompt and not to a free-standing subtype: the parse contract is meaningless
without the call that elicited it, which is why the trace helper already needs both refs
together.

## Consequences

**Breaking.** A project declaring a `template.output` purely to parse an LLM response must
move that declaration to the eliciting `template.prompt`'s `@responseRef`. This is exactly
the #309 adopter's shape, so the migration note is not hypothetical and must be written
before the cut. Rides the coordinated pre-1.0 breaking slot; a migration guide belongs under
`docs/features/migrations/`.

**Five ports.** The parser generator's filter, the FR-010 fragment emitter, and
`@promptStyle`'s registration all move. `expected-registry.json` changes (an attr moves
subtypes), so all five ports sync in lockstep.

**A doc claim is retired.** `template.output`'s description stops being contradicted by its
own attribute set.

**Non-goal — do NOT collapse `template.prompt` and `template.output`.** Their attribute sets
are near-disjoint (prompt: `@model`, `@maxTokens`, `@requiredSlots`, `@responseRef`; output:
`@kind`, `@subjectRef`, `@htmlBodyRef`, `@textBodyRef`), and merging them would put email
part-refs on the LLM-call type — inapplicable on almost every instance, which is the shape
ADR-0037 rejects for a subtype axis. Direction is the axis; the two subtypes are two
directions of outbound plus one inbound rider, not one type.

## Open question — where `@format` lives on the inbound side

`@format` currently serves both directions: it drives the render engine's
escaping/whitespace **and** tells the parser what syntax to read. Outbound it clearly stays
on `template.output`. Inbound it must travel with `@responseRef`, and the options are a new
`template.prompt` attr (e.g. `@responseFormat`) or hanging it off the response payload
object. **Not decided here** — it is a vocabulary question that should clear ADR-0037's
procedure on its own evidence, and deciding it inside this ADR would smuggle in an attribute
addition under a re-homing decision.

## Alternatives considered

**Filter the parser on `@kind`** (skip `email`). Removes the absurd artifact without moving
anything — but leaves `@promptStyle` on the wrong subtype, leaves both spellings legal, and
encodes the direction split as a per-generator exclusion rather than as the type system. A
band-aid over the actual boundary; worth shipping only as an interim if the breaking slot is
far off.

**A third subtype for the inbound shape** (`template.response`). Coherent, and it would
carry `@promptStyle` and `@format` cleanly. Rejected because it adds registered vocabulary to
express something `@responseRef` already expresses, and it detaches the response contract
from the call that elicits it — the relationship the trace helper depends on.

**Leave it.** Rejected: the ambiguity already produced a real adopter defect path, and the
generated email parser is an artifact the toolchain cannot explain.

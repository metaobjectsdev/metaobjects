# Downstream metadata decisions — when and how to extend the metamodel

You're building on MetaObjects and you've hit a concept the shipped vocabulary
doesn't name. Should you model it? As what shape? And how do you keep whatever you
add from aging badly? This is the **judgment layer** for adopters.

It is deliberately *not* the mechanics layer. For the provider API, `register` vs
`extend`, loader wiring, and the subtype-vs-attr-vs-abstract decision table, see
[extending-with-providers.md](extending-with-providers.md). For the canonical
ordered test, see
[ADR-0037](../../spec/decisions/ADR-0037-metamodel-vocabulary-expansion-decision-framework.md).
This guide is the decision *around* those.

> **Why decide with a procedure, not a guess?** Generated code is disposable — the
> metamodel is the durable spine. A field you mis-shape today is a field you migrate
> across every port later. Vocabulary is close to forever; spend a few minutes on it.

## Step 0 — exhaust the existing vocabulary first

Most "I need a new type" needs die here. Before you register anything:

- **Search what already exists.** `meta types <term>` and `meta types --all` — the
  shipped vocabulary is broad (currency, enum, uri, inet, uuid, jsonb storage,
  projections, relationships, indexes, templates, …).
- **Can an existing subtype + attributes carry it?** A validated variant of an
  existing type is almost always an attribute, not a new type.
- **Can an abstract + `extends` carry it?** A reusable *set* of fields/constraints is
  an abstract you `extends`, not new vocabulary.
- **Is it a one-off author-supplied property?** The registered `attr.properties` bag
  is the sanctioned escape hatch for arbitrary key/values — it does not require a new
  attribute and stays inside strict provenance (ADR-0023).

## Step 1 — check whether core (or the roadmap) already models it

Before inventing, converge. Two failure modes to avoid:

- **Re-deriving a shape core already ships (or plans).** If the roadmap already
  charts the concept, model it *in a shape that can fold into the eventual core
  vocabulary* rather than a divergent one.
- **Claiming a chartered name.** The declared-API surface and ecosystem tier reserve
  the type names `api`, `operation`, `surface`, and `binding` for planned core
  vocabulary. Do not use those names for a project-local type — a later core release
  would force a breaking rename. Pick a project-local name that stays clear of them.

## Step 2 — run the ADR-0037 ordered test

Only now, and only if steps 0–1 didn't resolve it, run the framework's ordered test
(gloss — [ADR-0037](../../spec/decisions/ADR-0037-metamodel-vocabulary-expansion-decision-framework.md)
is the authority):

1. **Derivable** from existing metadata + codegen? → derive it, add nothing.
2. **Physical-only** (same native type/meaning, only the DB column differs)? → the
   `@dbColumnType` escape hatch, not first-class vocab.
3. **A thing with its own native type, behavior, or attributes?** → a **subtype**.
4. **A structural variant *within* a subtype that already earned step 3** — same
   native type, different generated shape? → a **`@kind`** (the one chartered
   structural-variant axis).
5. **Otherwise** it just modifies/validates/configures an existing type → an
   **attribute**.

Litmus for 3-vs-5: *would I want to attach behavior or extra attributes to this
concept later?* If not, it's an attribute. A would-be subtype that differs from an
existing one only by a property is an attribute.

## Design rules for downstream vocabulary that ages well

When step 2 does land you on a new subtype (or `@kind`, or attribute), these keep it
from becoming a liability:

- **Keep the node protocol- and address-free.** The subtype names the *concept*; the
  transport/protocol is a closed structural-variant discriminator *within* the subtype
  (the way `source.rdb` puts table/view/materializedView behind `@kind`, and
  `template.output` puts document/email behind `@kind`) — never the subtype axis
  itself. Endpoints, URLs, hostnames, and addresses never enter metadata.
- **Names-only, fail-closed config.** Declare the *names* of the config keys a node
  requires; keep the *values* (URLs, tokens, credentials, addresses) in environment or
  config. Generate a startup check that fails closed when a required key is missing. A
  value in metadata is both a leak and a drift source; a silent fallback is worse than
  a loud crash.
- **Reference typed payloads, don't inline shapes.** Point a node at a declared value
  object (a payload reference) rather than embedding a shape, so the payload
  participates in codegen and drift detection like everything else.
- **Register, never free-ride.** Wire a `MetaDataTypeProvider` explicitly into the
  loader (per [ADR-0023](../../spec/decisions/ADR-0023-strict-metadata-provenance.md)) —
  do not loosen `strict` to smuggle ad-hoc attrs past the sealed registry.

## The lifecycle: register → converge → maybe promote

Downstream vocabulary is not a fork; it's a staging area.

1. **Register.** Your provider `register`s the new `(type, subType)` (or `extend`s an
   existing one with attrs). It's yours, in your repo, gated by your own
   registry-conformance fixture.
2. **Converge.** When core later ships the concept, your provider shrinks from
   `register` to `extend` — you keep only your project-specific attrs and inherit the
   rest. (This is exactly how the tool-call envelope evolved: registered downstream
   first, then folded onto core's `template.toolcall` once it shipped —
   [ADR-0011](../../spec/decisions/ADR-0011-template-toolcall-as-core-subtype.md).)
3. **Maybe promote.** One consumer isn't enough evidence to add core vocabulary. If a
   **second, independent** consumer needs the same concept, that's a
   consumer→core promotion candidate — open an upstream issue with the convergence
   evidence rather than lobbying to add it from one data point.

## Worked example (the pattern, genericized)

A downstream monitoring consumer needed to deliver typed alerts and digests over
several channels — an HTTP webhook, a chat-room message, a heartbeat ping, a rendered
email handed off to a local mail command, and a local stream write. Walking the ladder:

- **Step 0/1:** no shipped subtype covers "outbound delivery channel," and the concept
  sits near the (deferred) declared-API + ecosystem-tier roadmap — so model it
  downstream in a fold-in-friendly shape, avoiding the chartered names.
- **Step 2:** "delivery channel" is a genuine thing with its own behavior and config
  (step 3) → a project-registered subtype; the individual channels are a closed
  structural variant *within* it (step 4) → a `@kind`, not five sibling subtypes.
- **Design rules:** the node references the alert/digest payload value object; it
  declares the *names* of the per-channel config keys and generates a fail-closed check;
  the channel `@kind` carries no URL or address. A small owned generator emits the
  per-channel wiring.

Notably, parts of this later turned out to match unshipped core shapes (a consumed-edge
address contract; "protocol is a binding, not a kind") — arrived at independently. That
is the converge-before-inventing rule paying off: a fold-in-friendly downstream model
becomes an `extend` instead of a rewrite when core catches up.

## Open edges

Some transports have no chartered home yet. Non-network channels — running a local
command, piping to a process, writing to a local stream — are not covered by any
chartered network binding today. Model them application-tier, behind the same variant
discriminator, so that whatever a future ruling decides doesn't force you to restructure
your metadata.

## See also

- [extending-with-providers.md](extending-with-providers.md) — the mechanics (provider
  contract, `register`/`extend`, wiring, error codes, the decision table).
- [ADR-0037](../../spec/decisions/ADR-0037-metamodel-vocabulary-expansion-decision-framework.md)
  — the vocabulary-expansion ordered test (the authority).
- [ADR-0023](../../spec/decisions/ADR-0023-strict-metadata-provenance.md) — strict
  provenance; why you register instead of loosening `strict`.
- [ADR-0011](../../spec/decisions/ADR-0011-template-toolcall-as-core-subtype.md) — the
  register→extend→promote lifecycle (the tool-call precedent).
- [ADR-0030](../../spec/decisions/ADR-0030-declared-api-surface-and-org-tier-boundary.md)
  — protocol is a binding, not a type axis; the chartered `api`/`operation`/`binding` names.

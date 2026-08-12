# ADR-0051 — Extension is registration: an undeclared attribute is always an error

_Status: accepted. 2026-08-12. Resolves an apparent conflict between [ADR-0011](ADR-0011-template-toolcall-as-core-subtype.md) and [ADR-0023](ADR-0023-strict-metadata-provenance.md)._

## Context

`meta verify` rejected an undeclared attribute on a `template.prompt` in TypeScript and
accepted it silently in Java. The same divergence existed on the brand-new `requirement.*`
family: TypeScript strict, Java permissive.

This looked like two ADRs in conflict — ADR-0011 charters consumers extending
`template.toolcall` with vendor-specific attributes; ADR-0023 mandates strict provenance
with a sealed registry. If both are true, which port is right?

**They were never in conflict.** Reading ADR-0011's actual chartered mechanism settles it:

> Each LLM vendor's wire details … are added via consumer-supplied providers using
> `registry.extend(TYPE_TEMPLATE, "toolcall", { attributes: [...] })`.

Its own worked example is a consumer provider, `id: "myapp-anthropic-toolcall"`, **declaring
its attributes**. ADR-0011 never chartered *undeclared* attributes — it chartered
*consumer-declared* ones. And ADR-0023 §1 is explicit about the enforcement half:

> undeclared attribute → `ERR_UNKNOWN_ATTR` (**closing the open-attr policy in all ports**)

The chronology confirms it is a leftover, not a decision. Java's any-attr wildcard predates
ADR-0023; when TypeScript implemented strict per-subtype enforcement and dropped its
wildcards, Java's survived unreconciled. The JVM manifest emitter has since had to *hide*
the wildcard to keep the cross-port manifest byte-identical — a sure sign the vocabulary and
the enforcement had drifted apart.

## Decision

**ADR-0011 governs the mechanism; ADR-0023 governs the enforcement; ADR-0050 supplies the
constraint.**

- **An undeclared attribute is `ERR_UNKNOWN_ATTR` on every type, in every port.** There is no
  chartered any-attr wildcard.
- **Extension is registration.** Vendor or domain vocabulary enters through a downstream
  `MetaDataTypeProvider`: `register()` for new types, `extend()` for attributes on shipped
  types. Provenance still means something, because "declared" includes "declared by your
  provider."
- **A projected attribute must be optional** (ADR-0050), already enforced at composition by
  `ERR_EXTEND_REQUIRED_ATTR` in all four registries.
- **Arbitrary author-supplied data** goes in the registered `attr.properties` bag, ADR-0023's
  existing escape hatch. Loosening `strict` is for applications *consuming* foreign models,
  never for authoring.

A wildcard is worse than a permissive extension point: it also swallows a **typo'd core
attribute**. A misspelled `@payloadRef` was silently ignored on one port and an error on
another — a silent-wrong-behaviour divergence, the worst class.

## Consequences

**Done now, because it was free now.** Java's `requirement.functional` and
`requirement.architectural` lose their wildcards, and a shared conformance fixture
(`error-unknown-attr-requirement`) gates the rule cross-port. This was **order-sensitive**:
`requirement.*` is unreleased with zero adopters, so tightening it before the cut costs
nothing, while tightening it after would make previously-loading metadata fail and would
need a scarce pre-1.0 breaking slot.

**Deliberately deferred: ~13 other Java types still carry the wildcard** — `object.*`,
`source.*`, `identity.*`, `relationship.*`, `validator.*`, `layout.*`, `origin.*`,
`index.lookup`, `template.*`. That divergence is **pre-existing**, unchanged by this release,
and removing it is a load-tightening that could surface real in-repo or downstream reliance.
It wants its own sweep, a fixture per type family, and its own release slot — not a pre-cut
drive-by.

**Why it survived at all:** the single existing unknown-attr fixture probed `field.string`,
and `field.*` is the one family that was already strict in every port. The one type family
everyone agreed on was the one type family tested. The fix is a fixture *family*, not a
single fixture — the deferred work is scoped that way.

## Alternatives rejected

**Charter the wildcard as the ADR-0011 extension point.** It is not scoped to
`template.toolcall`; it sits on ~15 types with no ADR-0011 story. It is also **ungateable** —
the cross-port manifest is structurally blind to attr wildcards, so the byte-gate could never
see it, leaving a fixture as the only possible enforcement. That is itself the argument that
the answer is strictness plus fixtures.

**Loosen TypeScript to match Java.** That makes ADR-0023 vacuous for most of the metamodel
and reintroduces the silent-typo failure the strict policy exists to prevent.

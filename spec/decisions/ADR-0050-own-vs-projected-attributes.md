# ADR-0050 — Own vs projected attributes: a provider is a cluster of capabilities

_Status: accepted. 2026-08-11. Supersedes FR-033 S2 on the homing of `template.*` attributes._

## Context

The metamodel is open under composition: every type, subtype and attribute comes from a
`MetaDataTypeProvider`, and the default bundle composes core types with the db, documentation,
prompt, ui and ui-web concerns. Downstream code may compose a different set.

Until now the boundary between "core" and "a concern" was drawn by intuition, and FR-033
drew it in a way that broke a type. FR-033 S2 re-homed the `template.*` attributes out of
core into the `metaobjects-prompt` provider — **including `@payloadRef` and `@toolName`,
which are required.** That made a core type's validity depend on a provider that can be
composed out.

The failure is silent, which is why it survived. Measured on the shipped TypeScript
registry, composing `coreProviders` without `metaobjects-prompt`:

| | with the provider | without |
|---|---|---|
| `template.prompt` registered | yes | **yes** |
| attribute count | 11 | **0** |
| `@payloadRef` | present, required | **absent** |

And loading a `template.prompt` that omits its required `@payloadRef`:

| composition | errors |
|---|---|
| with `metaobjects-prompt` | `ERR_INVALID_TEMPLATE`, **`ERR_MISSING_REQUIRED_ATTR`** |
| without | `ERR_INVALID_TEMPLATE` only |

The required-attribute rule did not fail loudly — it went quiet, and invalid metadata began
loading clean. `composeRegistry({ validate: true })` accepted the combination without a word.
Java, C# and Python carried the identical defect; this was never a per-port divergence.

An audit of all five concern providers found the other four already behaved correctly:
dropping `db`, `ui`, `ui-web` or `documentation` removes only *optional* vocabulary from
surviving types. **The rule was real and merely unwritten.**

## Decision

**A provider is a cluster of capabilities.** It may contribute new types, new subtypes,
attributes intrinsic to its own types, and attributes projected onto types another cluster
owns — in any combination. Projections may target only some subtypes: `metaobjects-prompt`
legitimately puts `@xmlText` on every `field.*`, `@enumAlias` on `field.enum` alone, and
`@normalize` on `object.value` alone.

Two kinds of attribute, with different homes:

- **OWN** — the type is invalid, unsatisfiable, or not meaningfully itself without the
  attribute. It registers **with the type, in the type's provider, always.**
- **PROJECTED** — a different cluster's concern applied to a type that is complete without
  it. It registers **in the concern provider, and MUST be optional.**

**The invariant:** removing a provider from a composition may remove types, and may remove
optional vocabulary from surviving types, but **must never invalidate, make unsatisfiable,
or silently weaken the validation of a type another provider registers.**

**Corollary:** a validation pass may only enforce presence rules over attributes registered
by the same provider as the pass's type. Core code enforcing rules over attributes an
optional provider owns is the same error in a second form.

### Deciding ownership

Ownership is decided **at the type level, not attribute by attribute.** Required-ness proves
an attribute is OWN — a required attribute is intrinsic by definition — but it is not
necessary. The test is whether the type's own registered semantics refer to the attribute:
its description, its rules, or a validation pass over it.

By that test the whole `template.*` attribute surface is OWN: `template.prompt`'s description
names the LLM overlay, `template.output`'s rules dispatch on `@kind`, and core's own passes
enforce presence rules over `@textRef` and `@subjectRef`. So **all fifteen moved, not just
the four required ones.** Splitting a family's attribute surface by required-ness would
reproduce the confusion that caused the defect.

The family belongs to core rather than the types moving into the prompt provider, because
`template.output` is not an LLM concern — documents, emails and exports are core rendering
territory, and a consumer legitimately uses them with no LLM machinery at all.

After the move, every spec file reads one way: **`types` sections carry own attributes;
`extends` sections carry only optional ones.**

## Consequences

- The four `template.*` types carry their own attributes in all five ports. `template.base`
  stays attribute-free — it is the abstract root.
- `metaobjects-prompt` keeps exactly its legitimate projections onto `field.*`, `field.enum`
  and `object.value`, all optional.
- **`fixtures/registry-conformance/expected-registry.json` is unchanged, byte-for-byte.** The
  manifest is provider-blind by design — it records types, attributes and child rules, never
  who registered them — so this was an internal restructuring, not a lockstep vocabulary
  change across four registries. Verified by diff, not assumed.
- A standing gate encodes the invariant
  (`server/typescript/packages/metadata/test/provider-composition-invariant.test.ts`):
  compose without each provider, assert no surviving type lost a required attribute. It is
  mutation-tested against the original homing, and asserts its own sweep is non-vacuous —
  a bundle where nothing projects anything would otherwise pass it trivially.
- Composing out a concern remains **possible**, and now yields a coherent reduced vocabulary.
  No provider combination is rejected. That is what a capability-cluster model means.

## Alternatives rejected

**Leave it and document the coupling.** A required attribute that vanishes with an optional
provider is not a documentation problem; the failure mode is a validation rule going quiet,
which no reader of the docs would notice.

**Let a provider declare "these types are incomplete without me."** A provider that needs to
declare incompleteness is misfactored. The fix is the factoring, never machinery to describe
the misfactoring.

**Reject the reduced composition at `composeRegistry` time.** This treats a symptom. With
own attributes travelling with their types, the reduced composition is *correct*, so there is
nothing to reject.

**Move only the four required attributes.** Ownership is a type-level property; a split
surface would leave the same confusion in place, one required-ness change away from
recurring.

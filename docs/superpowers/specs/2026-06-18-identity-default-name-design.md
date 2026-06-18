# Config-driven default name for singleton child types (fix the load-breaking identity bug)

> Status: design (agreed). Written 2026-06-18. Fixes a real, widespread load-breaking bug:
> `identity.primary` requires an author-chosen `name` (FR-024), but the no-name form is what
> ~8 doc files, `docs/llms/llms-full.txt` (the LLM context), the metaobjects.dev homepage
> example, and most quickstarts show — so a user *or Claude* who copy-pastes the canonical
> example gets a model that **fails to load** (`ERR_IDENTITY_NAME_REQUIRED`).

## Problem (verified)

`server/typescript/packages/metadata/src/subtype-rules.ts` (FR-024 D2) errors when any
`identity.*` node has `name === ""`. The docs/website/llms-full teach exactly that form.
Reproduced: a minimal model with `identity.primary: { fields: id }` (no name) fails to load.

## Decision

Make the default **config-driven**, and only where it is unambiguous:

1. **Default-name applies only to singleton child types** — a type that can occur *at most
   once per parent*. A static default name is collision-free **by construction** only for a
   singleton; for multi-cardinality children (validators, views, secondary/reference
   identities) a static default would collide.
2. **Cardinality is declared AND enforced in the provider JSON config.** Add a type-level
   `maxOccurs` to the type definition (`spec/metamodel/*.json` → `TypeDef`). The loader
   enforces it (error on more than `maxOccurs` of that `type.subType` under one parent).
3. **`defaultName` is honored only when `maxOccurs === 1`.** Add a type-level `defaultName`
   to the config; the loader assigns it when the node's name is empty.
4. **No counter-append auto-naming.** The historical "append a number per new validator/view"
   trick is rejected here: it produces *unpredictable* names that are hard to reference later
   and would confuse an LLM trying to `extends`/address a node — which cuts against the
   "LLM authors the model" thesis. Multi-cardinality children stay explicitly named.

`identity.primary` is the motivating case: exactly one per entity → `maxOccurs: 1`,
`defaultName: "primary"`. Stable and referenceable as `Entity.primary`.

## Changes

### Config (canonical source + embedded)
- `spec/metamodel/identity.json`: on `identity.primary`, add `"maxOccurs": 1`,
  `"defaultName": "primary"`. Regenerate the embedded definitions
  (`bun run scripts/generate-embedded-metamodel.ts`).
- `provider-data.ts` `TypeDef`: add optional `maxOccurs?: number` and `defaultName?: string`.
  Thread both into the registry's type-definition record.

### Loader
- During load, **before** the FR-024 name check, for any node with `name === ""`: look up its
  `type.subType` definition; if `maxOccurs === 1` and `defaultName` is set, assign the name.
- Add `maxOccurs` enforcement: count siblings of the same `type.subType` per parent; error
  (`ERR_TOO_MANY_<TYPE>` / reuse an existing code) when the count exceeds `maxOccurs`.
- `subtype-rules.ts` FR-024 D2: only error when the name is still empty after the default pass
  (so `identity.secondary`/`reference` — no `defaultName` — still require explicit names).

### Conformance
- Add a `fixtures/conformance/` fixture: an entity whose `identity.primary` omits the name →
  loads, and the effective/canonical serialization shows `name: "primary"`. Plus a negative
  fixture: two `identity.primary` under one entity → `maxOccurs` error.
- Add to `registry-conformance` if `maxOccurs`/`defaultName` surface in the manifest.

### Cross-port parity
The loader/subtype-rules exist per port (TS / Java / Python / C#). Ship TS as the reference,
then mirror `maxOccurs` + `defaultName` honoring in Java/Python/C# so the conformance fixture
passes on all five ports (the change is small and mechanical: read two config fields, apply +
enforce). The default vocabulary (`identity.primary → "primary"`) is identical everywhere.

### Sweep (separate, can land first)
Regardless of the engine change, fix the broken examples to a loading form (add explicit
`name:`): the ~8 feature docs, `docs/llms/llms-full.txt`, the `.claude` skills' examples, and
both website canonical examples. After the loader-default ships, the no-name form *also*
loads, but explicit-name docs stay correct and forward-compatible.

## Non-goals
- Counter-append auto-naming for validators/views (rejected — unpredictable, LLM-hostile).
- A dynamic name-generation strategy DSL. (Could revisit a deterministic `<field>`-scoped
  default for field-nested singletons later; out of scope here.)

## Why this is the right call
It removes the single most common bit of YAML bloat (every entity's primary identity) while
keeping names **stable, predictable, and referenceable** — the property an LLM-authored model
depends on. The cardinality gate makes the default safe by construction, and putting both
`maxOccurs` and `defaultName` in the provider config keeps it declarative (ADR-0023), not a
hardcoded loader special-case.

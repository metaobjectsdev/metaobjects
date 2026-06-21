# Config-driven metadata validation — design

_2026-06-21. The "gold standard" target for how metadata validation should be authored:
checks declared as **data** in shared config, interpreted by a small generic engine per
port — so a rule is written **once**, not re-coded in five languages, and a downstream
provider's new type validates itself with zero new validation code in any port._

Supersedes the open question left by
`docs/superpowers/specs/2026-06-19-metadata-validation-architecture-design.md` (Phase 2,
"validation on the TypeDefinition"). Sibling to **FR-033 / #23** ("Provider definitions as
declarative data") — if provider definitions become declarative data, validation rules are
just more fields in that same data; this spec defines those fields.

## Why

Validation today is split across three mechanisms, inconsistently:

1. **Reference descriptors** (`ReferenceDescriptor`) — `objectRef` / `references` are
   declarative data, but the data is **constructed in code per port** (`core-types.ts`,
   `CoreTypes.cs`, `core_types.py`, the Java registration builders). Same rule, written five
   times.
2. **~20 free-floating imperative passes** (`ValidationPhase` / `validation-passes.ts` / …) —
   enum values, source attrs, template format/kind/slots, etc. Each hand-coded per port.
3. **A `validate` hook on the TypeDefinition** — declared, plumbed, and invoked in all four
   ports, but **registered by no core type** (only a downstream test). An extension point
   core doesn't use itself.

The cost is that **every rule is implemented N times** (N = 5 ports), and a downstream
provider that wants to validate its own type must write a validator in every language it
targets. That contradicts the MetaObjects thesis (metadata is the spine; behavior is
data-driven) and ADR-0023 (providers add types via registered data, not code).

## The idea

Express each check as **data** attached to the type's registration, and give each port **one
generic interpreter per rule-shape**. The rule-shape set is **small and closed** — our entire
current corpus needs only four. New rule-shapes are added deliberately (with the same
"can't-be-computed + human-agreement" bar as ADR-0023 attrs), never speculatively.

```
shared JSON config (authored once)
   │   spec/metamodel/*.json  +  downstream provider JSON
   ▼
each port's spec reader  →  lowers rule data onto the TypeDefinition
   ▼
each port's generic validation engine  (one interpreter per rule-shape, written once)
   ▼
the same errors/codes/envelopes in every port  (conformance-gated)
```

### The four rule-shapes

| Shape | Data | Covers today | Engine behavior |
|---|---|---|---|
| `reference` | `{ attr, target, targetSubType?, dotted?, errorCode }` | `objectRef`, `references`, `payloadRef`/`responseRef` existence | resolve `attr`'s value against the symbol table; error if unresolved or wrong type/subtype |
| `allowedValues` | `{ attr, values[], errorCode }` | `@format`, `@kind`, `@promptStyle` | own-attr ∈ closed set (absent OK); same shape as enum `@values` |
| `requires` | `{ when: {attr, equals}, require: [attr…], errorCode }` | email needs `subjectRef`+`htmlBodyRef`; document needs `textRef` | when the guard attr matches, every `require` attr must be present |
| `fieldPathRef` | `{ attr, viaAttr, errorCode }` | `requiredSlots` are fields on the `payloadRef` target | each value (or array member) of `attr` names a field on the object resolved from `viaAttr` |

These four cover **all** current reference and template validation, plus enum value-set
checks. A rule that genuinely fits none of them falls back to the **`validate` hook** (a
per-port `NodeValidator`) — the documented, rarely-used escape hatch for novel cross-field
logic. Core dogfoods the hook only where no shape fits, so the extension point is real.

### Where the data lives

In `spec/metamodel/*.json`, on the ref/attr-bearing node, e.g. on `template.prompt`:

```jsonc
{ "name": "payloadRef", "valueType": "string",
  "reference": { "target": "object", "targetSubType": "value", "errorCode": "ERR_INVALID_TEMPLATE" } },
{ "rules": [
    { "requires": { "when": { "attr": "kind", "equals": "email" },
                    "require": ["subjectRef", "htmlBodyRef"], "errorCode": "ERR_INVALID_TEMPLATE" } },
    { "fieldPathRef": { "attr": "requiredSlots", "viaAttr": "payloadRef",
                        "errorCode": "ERR_INVALID_TEMPLATE" } }
] }
```

Each port's spec reader lowers `reference` / `rules` onto the `TypeDefinition` (the data
the existing descriptor model already carries — now sourced from JSON, not hand-built).
The embedded-JSON byte-identity gates (Java auto-copy; C#/Python committed copies) keep the
five ports reading the same bytes.

### Envelope contract (unchanged)

The engine emits the **same** error source envelopes the current passes do — plain source
for `objectRef`/`references`, FR5d resolved-source (`referrer` + `target`) for the template
references — so the existing conformance fixtures stay byte-green. Envelope shape is part of
each rule-shape's interpreter, not per-rule data.

## Downstream story (the payoff)

A downstream provider adds `widget.gauge` with a `@dataSourceRef` that must resolve to an
`object.entity`. It writes **one** JSON rule:

```jsonc
{ "reference": { "attr": "dataSourceRef", "target": "object", "targetSubType": "entity",
                 "errorCode": "ERR_INVALID_WIDGET" } }
```

All five ports enforce it. No validator code in TS, Java, C#, Python, or Kotlin. That is the
standard this spec exists to make real, and it is exactly ADR-0023's "register data, don't
invent code" applied to validation.

## Phasing (earn it; don't big-bang)

- **Phase 0 — cleanup (DONE, `599a4aed`).** Revert the TS payloadRef descriptor split so all
  ports validate references identically. Clean base.
- **Phase 1 — proof slice.** Move the `reference` shape from per-port code into shared JSON;
  one generic `reference` interpreter per port; conformance unchanged. This proves
  config-driven validation works byte-identically across five ports **before** extending —
  the de-risking step. (Compose with FR-033 #23 if it lands first: same data file.)
- **Phase 2 — `allowedValues`.** Move `@format`/`@kind`/`@promptStyle` closed-set checks to
  data + interpreter.
- **Phase 3 — `requires` + `fieldPathRef`.** Move the template conditional-requires and
  `requiredSlots` to data; **delete the bespoke template pass** in all ports. Templates become
  fully self-describing.
- **Phase 4 — opportunistic.** Migrate the remaining datafiable passes (source attrs, enum,
  discriminator, …) as touched; leave the rest as passes or move to the `validate` hook.
  Never invent a fifth rule-shape without a rule that needs it.

Each phase is independent, conformance-gated, and behavior-neutral.

## Non-goals / what stays code

- **Novel cross-field logic** that fits no shape → the `validate` hook. Don't contort the data
  model to absorb one-off rules.
- **No speculative rule-shapes.** Four shapes because four are needed. A fifth requires a real
  rule + the ADR-0023 "can't-be-computed + human-agreement" justification.
- **The generic interpreters are still per-port code** — but they are written once and never
  again; the *rules* are data. That is the irreducible floor, and it is fixed-size (four
  interpreters), not proportional to the number of types.

## Risks

- **Five-port interpreter work** — four interpreters × five ports. Bounded, but real. Phase 1
  proves the pattern on the cheapest shape first.
- **Envelope fidelity** — the FR5d resolved-source envelope must be reproduced exactly by the
  `reference`/`fieldPathRef` interpreters or the template fixtures break. Mitigation: the
  interpreters carry the envelope logic; fixtures gate it; Phase 1 captures the baseline.
- **Strict provenance (ADR-0023)** — the validation rule data is itself provider data and must
  be registered/sealed like any other; the spec readers must tolerate the new `reference`/
  `rules` fields (guard first). No rule may reference an unregistered attr.
- **Some passes resist datafication** (e.g. origin/projection cross-entity semantics) — those
  stay as passes or hook validators; that's expected, not a failure of the model.

## Open questions

- Should `rules` live inline on each attr/type in `spec/metamodel/*.json`, or in a sibling
  `validation` block per type? (Lean inline-on-type for locality.)
- Does FR-033 (#23) subsume the "data lives in JSON, readers lower it" mechanism? If it lands
  first, Phase 1 rides its reader; if not, Phase 1 builds the minimal reader path. Coordinate.
- Kotlin shares the JVM metadata layer — does it get the interpreters for free (like the
  registry), or need its own? (Likely free; confirm in Phase 1.)

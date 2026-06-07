# SP-G — Registry Conformance (cross-port metamodel-vocabulary manifest)

**Date:** 2026-06-02
**Status:** Designed (user-approved the idea + "do it"; spec-review gate waived)
**Relates to:** the SP-C finding (Java validator-vocabulary drift — `@mask` vs `@pattern`, `NumericValidator` with no min/max, `ArrayValidator` `@minSize`, Python loader not registering `length/regex/numeric/array`) — all silent because no behavioral fixture exercised that vocabulary.

## Problem

CLAUDE.md states the **metamodel subtype vocabularies must be identical across languages**, but that's enforced only by a manual discipline ("add to TS constants first, then parallel in the other ports") + *incidental* behavioral coverage (a drifted attr is caught only if some fixture happens to use it). SP-C proved that misses things for weeks: a whole port's validator registry can diverge — wrong attr names, missing subtypes, different required-ness — with every corpus still green. There is no test that compares the **registries themselves**.

## The gate: a canonical registry manifest, byte-identical across ports

Each port emits a normalized JSON serialization of its **logical metamodel vocabulary** (walking its type registry), and a conformance runner asserts it is **byte-identical** to a single-source committed `fixtures/registry-conformance/expected-registry.json`. Same proven pattern as `render-conformance` / `output-prompt-conformance` (byte-exact to a committed canonical) — strongest signal, simplest model, no escape-hatch ledger (the logical vocabulary must have zero per-port divergence by contract).

The registries are structurally parallel (`TypeDefinition` per `(type, subType)` + `AttrSchema` + `ChildRule` + common-attrs + default-subtypes in TS/Python; `MetaDataRegistry.typeDefinitions`/`commonAttributes`/`defaultSubTypes` + `ChildRequirement` in Java; C# likewise; Kotlin = the JVM registry), so every port can walk its registry and emit the manifest.

### Manifest schema (LOGICAL vocabulary — the in/out boundary is the crux)

```jsonc
{
  "types": [                                  // sorted by "type.subType"
    {
      "type": "field",
      "subType": "string",
      "inheritsFrom": "field.base",           // the declared parent type.subType, or null
      "attrs": [                              // sorted by name
        { "name": "maxLength", "valueType": "int", "required": false },
        { "name": "required",  "valueType": "boolean", "required": false }
      ],
      "childRules": [                         // sorted by "childType.childSubType"
        { "childType": "validator", "childSubType": "*" }
      ]
    }
  ],
  "commonAttrs": [                            // sorted by name — the registerCommonAttribute set
    { "name": "description", "valueType": "string", "required": false }
  ],
  "defaultSubTypes": { "field": "string", "object": "entity" }  // sorted keys
}
```

**INCLUDED (logical vocabulary — must be identical):** every registered `(type, subType)`; each one's attrs as `{ name, valueType, required }` (`valueType: null` for polymorphic/untyped attrs like `@default`); `childRules` (the structural child-requirement vocabulary, `*` wildcard preserved); `commonAttrs`; `defaultSubTypes`; `inheritsFrom` (the declared parent, if all ports track it — see Open boundary).

**EXCLUDED (legitimately per-port physical facets):** the node factory / `NodeConstructor` / Java `Class`; native type bindings (Java `DataTypes.DECIMAL`→`BigDecimal` value-class, TS native TS-type, EF/CLR types); codegen targets/options; the TS-only `D1` dialect and any other documented port-unique surface; ordering (we sort everything).

**Open boundary calls to settle during Unit 1 (verify each port actually tracks the facet identically before including it):**
- `allowed_values` / `default` on `AttrSchema` — Python tracks them; confirm TS/Java/C# do on the *schema* (vs only enforcing at load). Include only if universally tracked; otherwise exclude (out of scope for v1) + note it.
- `inheritsFrom` — include only if all ports expose the declared parent on the registry; if representation diverges, exclude from v1 + note.
- `childRules` representation — Java's `globalRequirements`/`ChildRequirement` may key differently than TS/Python `child_rules`; normalize to `{childType, childSubType}` or, if reconciliation is non-trivial, scope v1 to types+attrs+commonAttrs+defaultSubTypes and add childRules in a follow-on (documented, not silent).

The guiding rule: **include a facet only if it is part of the cross-port logical contract AND all five ports can emit it identically.** When unsure, exclude from v1 and document the deferral — a smaller airtight manifest beats a bigger flaky one.

## Expect to FIND divergences (this is drift-finding, like SP-F)

When the five emitters first run, they will almost certainly NOT match — that's the point. Each mismatch is a real registry divergence to **fix at the source** (reconcile the diverging port's registration to the cross-port contract), exactly as SP-C did for the validator attrs. Only once all five agree is the canonical `expected-registry.json` locked. SP-C already fixed the validator vocab, but this will surface anything else that has drifted (and prevent future drift).

## Implementation units

Each unit ends with the simplify + review gate; the sub-project merges forward once. TS is the reference (its constants are the documented source of truth).

- **Unit 1 — Manifest schema + TS reference emitter + canonical.** Settle the in/out boundary (resolve the three open calls above by inspecting all ports). Add a TS function that walks the `TypeRegistry` (core-types) and emits the canonical manifest (sorted, normalized). Generate `fixtures/registry-conformance/expected-registry.json` from it. Add a TS conformance test asserting the emitted manifest == the committed canonical. This pins the reference.
- **Unit 2 — C# emitter + reconcile.** Walk the C# registry → manifest; assert == canonical. Any divergence (subtype/attr/required/common/default) → fix the C# registration to match the contract (NOT the canonical, unless TS is the one wrong). Report divergences found.
- **Unit 3 — Java emitter + reconcile.** Walk `MetaDataRegistry` → manifest; assert == canonical. (Kotlin shares this registry — one emitter covers both JVM ports; add a Kotlin runner that asserts the same manifest.) Fix Java divergences at source.
- **Unit 4 — Python emitter + reconcile.** Walk `TypeRegistry` → manifest; assert == canonical. Fix Python divergences at source.
- **Unit 5 — Untested-vocabulary coverage gate.** A check that flags any registered `(type, subType)` or attr that NO conformance fixture across the corpora exercises — the meta-gap that let SP-C's drift hide. Start as a report; decide with the user whether it hard-fails or warns (it may legitimately flag a backlog). At minimum, emit the list so untested vocabulary is visible, not invisible.
- **Unit 6 — Reconcile canonical + CI + sweep.** Once all 5 ports agree, lock `expected-registry.json`. Wire all 5 registry-manifest runners into `conformance.yml` (unit-level, no Docker — fits the `conformance` matrix + the `conformance-kotlin` job). Document `fixtures/registry-conformance/README.md` (what's in/out of the manifest + the "fix-at-source on divergence" rule). Update CLAUDE.md's cross-language-porting section to point at the new structural gate. Final review; merge forward.

## Edge cases / non-goals

- **Not** comparing physical/native bindings or codegen output (that's behaviorally gated; this is the *loader vocabulary* only).
- **Not** single-source-of-truth *generation* of the constants (the drift-PROOF option #3 from the brainstorm) — that's a larger follow-up; SP-G is the detection gate. If drift recurs despite the gate, revisit generation.
- A facet that can't be emitted identically by all 5 ports is **excluded from v1 + documented**, never fudged into a per-port-conditional manifest.
- The canonical is single-source (one `expected-registry.json`); no per-port expected files.

## Definition of done

- Each of the 5 ports emits a canonical registry manifest, asserted **byte-identical** to one committed `fixtures/registry-conformance/expected-registry.json`, CI-gated.
- Any registry divergence surfaced during the build is fixed at the source (reported per port), like SP-C/SP-F.
- An untested-vocabulary report exists (hard-fail or warn, per the Unit-5 decision).
- `README.md` documents the in/out boundary + the fix-at-source rule; CLAUDE.md points at the gate. No facet silently per-port-conditional.

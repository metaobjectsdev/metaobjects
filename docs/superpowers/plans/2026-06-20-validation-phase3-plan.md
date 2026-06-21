# Validation Phase 3 — implementation plan

_2026-06-20. Follows the realized Phase 2 (validation-on-the-`TypeDefinition`, derived by the
loader, in all five ports — see
`docs/superpowers/specs/2026-06-19-metadata-validation-architecture-design.md` and the
`proto/validation-registry` branch). Phase 3 is the set of deliberate, conformance-gated
refinements left after the architecture was de-risked. Each task is independent; do them in
the order below or cherry-pick. TDD throughout._

## Status going in

- All five ports (TS / Java / C# / Python, + Kotlin via shared JVM) carry validation on the
  `TypeDefinition` (`references` + `validate`) and the loader derives it from the registry.
- `@objectRef` / `@references` are descriptor-driven everywhere (plain-source envelope).
- TS also has `@payloadRef` / `@responseRef` as descriptors (resolved-source via the
  per-descriptor `resolvedSource` flag); the other ports keep them as their existing pass.
- Green: TS 2045, Java metadata 1057 + conf 388 + ktx 33, C# conf 665, Python 1206 + conf 391.

---

## Task 1 — Propagate `@payloadRef`/`@responseRef` descriptors to Java/C#/Python

**Goal:** parity with TS — `payloadRef`/`responseRef` resolve via reference descriptors on
the template `TypeDefinition`s in every port, removing the bespoke existence checks.

**Value:** architectural consistency only — **behavior-neutral** (the existing passes already
produce the exact resolved-source envelope the fixtures pin). Low priority; do it for
uniformity, not for behavior.

**Risk (real):** in Java/C#/Python, `validateTemplates`/`ValidateTemplatePayloadRefs` is
**entangled** with template-only rules (`@format`/`@promptStyle`/`@kind`/`@textRef`/
`@requiredSlots`). `payloadRef` is not a clean standalone reference there. The pass must keep
R3 (`@requiredSlots` needs the resolved payload) + R4/R5/kind, and the migrated descriptor
must reproduce the **pinned `resolved`-source envelope** (`referrer` + `target`) exactly or
`error-template-payload-ref-unresolved` / `-not-value` break in three ports.

**Steps (per port — Java / C# / Python):**
1. Add a `resolvedSource` boolean to `ReferenceDescriptor` (Java record: add the field + a
   5-arg back-compat constructor delegating `resolvedSource=false`; C# record: optional
   param; Python dataclass: field default `False`).
2. In the registry runner, branch on `desc.resolvedSource`: emit the resolved-source
   envelope (`ResolvedSource.from(node.source, referrer, raw)` — Java; the C#/Python
   equivalents) instead of plain `node.source`. **Match the referrer/target the existing
   template pass uses** (capture from the pass before deleting it).
3. Declare `payloadRef` + `responseRef` descriptors (`targetSubType: value`,
   `resolvedSource: true`, `ERR_INVALID_TEMPLATE`) on the template subtypes
   (`template.prompt` / `template.output` / `template.toolcall`).
4. Remove **only** the payloadRef/responseRef existence+kind emission from the template pass;
   keep the payload *resolution* (R3 needs it) + R4/R5/kind/slots.

**Test:** the existing `error-template-payload-ref-unresolved` / `-not-value` /
`-required-slot-missing` conformance fixtures must stay byte-green in every port. Capture the
pre-migration envelope first (load each fixture, record `source`), then assert no diff.

**Recommendation:** optional. The architecture is already consistent at the load-bearing
level; weigh the uniformity against the entangled-pass risk.

---

## Task 2 — Declarative `reference` in the embedded spec JSON

**Goal:** the user's original vision — cross-references declared as **config**, not code.
Carry a `reference` object on the attr in `spec/metamodel/relationship.json` /
`identity.json` / template specs, and have each port's spec reader lower it onto the
`TypeDefinition`'s `references` (replacing the programmatic declaration in
`core-types.ts` / `CoreTypes.cs` / `core_types.py` / the Java registration builders).

**Shape (in the spec JSON, on the ref-bearing attr):**
```jsonc
{ "name": "objectRef", "valueType": "string",
  "reference": { "target": "object", "dottedFieldPath": false, "errorCode": "ERR_INVALID_RELATIONSHIP" } }
```

**Risk:** touches **four** spec readers (TS `defineProviderFromData`/`provider-data.ts`; Java
`SpecMetamodelReader`; C# `SpecMetamodelReader`; Python spec reader). **Guard each reader to
tolerate an unknown `reference` field first** (a strict reader may reject it). The embedded
JSON is also byte-identity-gated in some ports (Java auto-copies; C#/Python have committed
copies) — update all copies together.

**Steps:**
1. Add the `reference` field to the shared spec JSON (one attr at a time).
2. Each spec reader: parse `reference` → build a `ReferenceDescriptor` → attach to the
   lowered `TypeDefinition`. Keep the programmatic declaration as a fallback until all
   readers carry it, then delete it.
3. Re-run the registry-manifest / spec byte-identity gates per port.

**Test:** conformance unchanged (the descriptors are the same, just sourced from JSON);
registry-manifest gates green; a new unit test that the lowered `TypeDefinition.references`
matches the JSON.

---

## Task 3 — Java collect-all (loader-contract normalization)

**Goal:** a load reports **all** errors, not just the first — matching TS/C#/Python (which
already collect). The genuine user-visible UX win.

**Blast radius (the reason this is its own task):** Java's `load()` **eager-throws**
(`MetaDataLoadingException` on the first error), and that contract is depended on by:
- many tests asserting a bad model *throws* (`RelationshipReferentialActionsTest.loadThrough`,
  the Kotlin `RelationshipsTest` "unresolved objectRef now fails to load", others),
- the conformance runner (`ConformanceTest`) which **catches** the throw and compares,
- ~20 eager-throw validation passes (each aborts its pass on first error).

**Two implementation options:**
- **(A) Full collect** — `load()` returns/exposes a collected error list (new `getErrors()`);
  the conformance runner reads it; throw-expecting tests migrate to assert on the collected
  list. Cleanest end state, widest migration.
- **(B) Aggregate-and-throw** — keep `load()` throwing, but collect across passes (wrap each
  pass call in `ValidationPhase.run` in try/catch, collect, continue) and throw an
  **aggregated** exception carrying all errors (first error preserved for back-compat; the
  rest accessible via `getAllErrors()`). Smaller migration; the runner reads the first error
  unchanged (fixtures are single-error → green). **Recommended first step** — it's
  back-compatible and surfaces all errors without breaking the throw contract.

**Note:** option B only collects one-error-per-pass (each pass still aborts on its first).
True within-pass collect needs each pass to stop throwing — defer unless demand.

**TDD steps (option B):**
1. Add a failing test: a model with **two** dangling references reports **two** errors.
2. `ValidationPhase.run`: wrap each pass in try/catch, collect `ValidationError`s, continue;
   at the end, if any, throw an aggregated `MetaDataLoadingException` carrying the list
   (first error message/code preserved).
3. Confirm all throw-expecting tests + conformance (388) still green (single-error fixtures
   unchanged; the first error is preserved).
4. Expose `getAllErrors()` for callers wanting the full set.

**Test:** the new two-error test passes; metadata 1057 + conformance 388 + ktx 33 stay green.

---

## Task 4 — Downstream-code fidelity (OO/Python ports)

**Goal:** parity with TS's widened `ParseError.code` — a downstream provider's validator can
emit its **own** error code through Java/C#/Python (today they collapse an unknown code to
`ERR_UNKNOWN`).

**Steps:** widen the code carrier — C# `MetaError` gains a `RawCode` string (or `Code`
becomes string-backed); Python `MetaError` carries the raw string; Java's
`ValidationError.code` is already a String, so `ValidationPhase` must stop calling
`ErrorCode.valueOf(...)` on it (carry the raw code on the exception).

**Risk:** low, but **no current test exercises it** (the core path only emits built-in codes).
Add a downstream-extension unit test per port (mirror the TS `validation-registry.test.ts`
custom `widget.gauge` with its own code) so the fidelity is verified, then it has value.

**Recommendation:** do this *with* the per-port downstream-extension test (Task 4 + its test
together), or skip until a real adopter needs custom codes.

---

## Sequencing

1. **Task 3 (collect-all, option B)** — the only user-visible UX win; do it first, test-first.
2. **Task 2 (spec-JSON declarative)** — the "config not code" vision; medium, guard the readers.
3. **Task 1 (payloadRef propagation)** — optional uniformity; only if the entangled-pass risk
   is acceptable.
4. **Task 4 (downstream codes)** — only with its verifying test, or defer to adopter demand.

Each task is independent and conformance-gated. None is required for the architecture, which
is complete; these are refinements.

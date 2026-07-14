# FR-036 — Cross-port constraint-validation enforcement + semantics pins (closes the FR-035 release gaps)

**Date:** 2026-07-14
**Status:** Planned. Execution deferred to a fresh session (this doc is the self-contained brief).
**Depends on:** FR-035 present-key PATCH tristate — shipped across all 5 ports (npm/PyPI/NuGet/Maven
commits `fe592c11` TS, `1092e784` Python, `c3021bb7` C#, `25bc2d2a` Java, `0fb77748` Kotlin, all on
`origin/main`; the coordinated BREAKING release is HELD until the gaps below close).
**Proposed FR number:** FR-036 (verify the next free slot in `spec/roadmap.md`).
**Owner rulings captured (2026-07-14):**
1. **A `@required` string means NON-EMPTY** — reject `null` and `""`, ACCEPT whitespace-only. (Matches
   TS, the reference impl, and the registry's own `validator.required` "null/empty" text.)
2. **`validator.regex @pattern` means FULL-MATCH** — the whole value must match. Anchor as `^(?:…)$`.

This FR exists because a Fable semantic review (2026-07-14) of the `@Size`/`@Pattern`/`@NotBlank`
jakarta rendering concluded: **the validation VOCABULARY is metaobjects-native and sound — build on
it, no vocabulary change** — but the *rendering semantics* diverge across ports on two axes, and the
HTTP-tier *enforcement* is wired on only some ports. Closing the FR-035 release gaps therefore means
(A) pinning the two divergent semantics per the rulings above, (B) wiring per-field constraint
validation into the generated POST + PATCH handlers on the ports that don't run it, and (C) three
smaller FR-035 carry-over gaps. All of it is conformance-gated by NEW wire-tier scenarios (the class
of gate SP-F exists for — "artifact validated, wiring unverified" is exactly how this stayed hidden).

---

## 0. The corrected ground truth (Fable review — verify each file:line before changing)

**The enforcement matrix TODAY (this corrects the FR-035 KNOWN_GAPS text, which wrongly says
"TS/Python DO validate on PATCH"):**

| Port | POST enforces constraints over HTTP? | PATCH enforces on present values? |
|---|---|---|
| **TS** | yes — `insertSchema.safeParse` (`runtime-ts/src/drizzle-fastify/index.ts:204`) | **yes** — `updateSchema.safeParse` (:225); UpdateSchema keeps the full validator chain (`zod-validators.ts` ~326-336) |
| **Java** | yes — `@Valid @RequestBody` (`SpringControllerGenerator.java` ~274) | **no** — FR-035 rebound to raw `JsonNode` (~284) |
| **Kotlin** | yes — `@Valid` (`KotlinSpringControllerGenerator.kt` ~365) | **no** — FR-035 rebound to raw `JsonNode` (~400) |
| **C#** | **no** — minimal-API model binding never runs DataAnnotations (`RoutesGenerator.cs` ~177); `TryValidateObject` exists only in `ValidationConformanceTests.cs`. Only DB NOT NULL / `varchar(n)` / enum CHECK enforce | no |
| **Python** | **no** — generated router binds `dto: dict[str, Any]` on POST *and* PATCH (`router_generator.py` ~308/319); the SP-C-gated Pydantic model is never constructed on the HTTP path | no (only the FR-035 required-null 400, ~325-327) |

So **only TS actually enforces field constraints over HTTP at all.** C# and Python annotations are
decorative at the wire tier even on POST. The `validation-conformance` corpus validates the ARTIFACT
(the Zod schema / annotated DTO / Pydantic model, each run directly by the runner) but nothing gates
the WIRING — and `api-contract-conformance` has no constraint-violation scenario on either verb.

**The two semantic divergences (invisible today only because the corpus tests anchored patterns and
has no empty-string case):**
- **Required strings, 4 behaviors:** `@NotBlank` (Java/Kotlin) rejects whitespace (invented — no
  registry text authorizes trim); TS `.min(1)` rejects `""` accepts `"   "`; C# `[Required]` trims;
  Python emits nothing for a required string. Ruling 1 pins this to **non-empty** (TS's behavior).
- **`@Pattern` match-mode:** SP-C design says "un-anchored/search" (TS `.test()`, Pydantic
  `is_match`); jakarta (`matcher.matches()`) + .NET `[RegularExpression]` are full-match. `[A-Z]{3}`
  (no anchors) accepts `"xxABCyy"` on TS/Python, rejects on Java/Kotlin/C#. Ruling 2 pins **full-match**.

**Field-scoped vs entity-scoped split is correct and load-bearing:** cross-field validators
(`comparison`, `presentIff`, `requiredWhen`, `atLeastOne`) render ONLY as TS-owned DB CHECK
constraints (`migrate-ts/src/expected-schema.ts`), never as jakarta/Zod — so they evaluate the MERGED
row after UPDATE and hold under PATCH with zero handler work. Do NOT add cross-field validation to any
port's handler. Per-field only.

---

## 1. Program A — constraint-validation enforcement (the centerpiece)

### A1. Semantic pins (BLOCKING — land first or with the wiring)

**Pin 1 — required string = non-empty (Ruling 1).** For a `@required` (or `validator.required`)
NON-array string field, emit "null-or-empty rejected, whitespace allowed" in every port:
- **Java** `SpringDtoGenerator.validationAnnotations` (~516-520): replace the auto-`@NotBlank` with
  `@NotNull` + `@Size(min = 1)` (combine with any existing `@Size` max → `@Size(min=1, max=n)`).
- **Kotlin** `KotlinEntityGenerator` (~292-296): same — drop `@NotBlank`, add `@Size(min=1)` (or the
  Kotlin DTO's equivalent) alongside `@NotNull`. NOTE the Kotlin DTO is the `@Valid`-bound data class;
  keep it consistent with Java.
- **C#** `EntityGenerator.cs` (~810): `[Required]` trims by default → emit
  `[Required(AllowEmptyStrings = true)]` + `[MinLength(1)]`.
- **Python** `entity_model.py`: emit `min_length=1` on the Pydantic field for a required string (it
  currently emits nothing).
- **TS** — already correct (`.min(1)` without trim); no change. This is the reference behavior.
- Required ARRAYS keep `@NotNull` with no `@NotEmpty` (`[]` passes everywhere — already consistent).

**Pin 2 — `@Pattern` full-match (Ruling 2).** The canonical semantic is "the whole value matches".
Java/Kotlin/C# are already full-match (native) — no change. **TS + Python must anchor** the authored
pattern: wrap as `^(?:<pattern>)$` when emitting (`zod-validators.ts` regex branch ~535-538/569;
Python `entity_model.py` regex emit). Guard against double-anchoring if the author already wrote
`^…$` (either always-wrap — a redundant `^(?:^…$)$` still matches identically — or detect+skip;
always-wrap is simplest and correct). Update the SP-C design doc's "un-anchored" line to "full-match".

### A2. Enforcement wiring (BLOCKING)

Validate **present, non-null** values with the **same per-field rules as create**. Never bean-validate
the whole DTO/patch on PATCH (that would fire `@NotNull` on absent fields — violates FR-035 §12.3).
Never validate the post-merge row (would 400 a patch that never touched a field whose stored value
predates a tightened constraint). Present values only. null on a non-required field short-circuits every
constraint except `@NotNull` (jakarta + Zod both treat null as valid), so the tristate composes for free.

- **Java** — the FR-035 controller already binds `JsonNode` and builds `<Entity>Patch`. Inject
  `jakarta.validation.Validator`; after `Patch.fromJson`, for each PRESENT field run
  `validator.validateValue(<Entity>Dto.class, fieldName, value)` (uses the DTO's constraints on a
  single value; null-on-absent never runs) → 400 `{"error":"validation"}` on any violation. The Patch
  needs to expose the assigned (field→value) entries — add `Map<String,Object> assignedValues()` or a
  per-field getter iterable. Harnesses must provide a `Validator`
  (`jakarta.validation.Validation.buildDefaultValidatorFactory().getValidator()`).
- **Kotlin** — same shape: inject a `Validator`; after building the effective present-value map, run
  `validateValue(<Entity>Dto::class.java, name, value)` per present field → 400. (The Kotlin controller
  currently dispatches inline into Exposed; do the validation pass BEFORE the `update{}`.)
- **C#** — (a) **also wire POST**: after model binding, `Validator.TryValidateObject(input, ctx,
  results, validateAllProperties: true)` → 400 on failure (currently POST enforces nothing). (b) PATCH:
  in the per-key merge loop (`RoutesGenerator.AppendPartialMergeLoop`), for each present property run
  `Validator.TryValidateProperty(value, new ValidationContext(existing){MemberName=prop}, results)` →
  400. Emit the `{"error":"validation"}` envelope (matches the FR-035 required-null 400).
- **Python** — cleanest fix solves POST + PATCH together: generate an all-optional
  `<Entity>Patch` **Pydantic** model (`total=False`-equivalent — every field `Optional` with its
  validators) and bind the create model on POST + the patch model on PATCH, using
  `model_fields_set` for presence. A `ValidationError` → 400 `{"error":"validation"}`. This retires the
  `dict[str, Any]` binding and its decorative-annotation gap in one move. (Router: `router_generator.py`.)
- **TS** — already done (both verbs `safeParse`). No change.

### A3. Non-blocking pins (batch into the same release)

- **`@maxLength` × `validator.length @max` precedence** — undefined today; ports split (TS/C#
  validator-wins, Java/Kotlin/Python `@maxLength`-wins). Pin **strictest-wins: effective max =
  min(@maxLength, validator.length.max)** (deterministic, order-independent, safe vs the `varchar(n)`
  DDL cap). Apply in all five emitters. Add a corpus field carrying both.
- **Java/Kotlin `!isArray` gate on the string-length `@Size`** — `SpringDtoGenerator.java` ~522-536
  applies the char-count `@Size` without an `isString && !isArray` guard, so a
  `field.string @isArray @maxLength:255` would emit `@Size(max=255)` on the `List` (element-count
  reinterpretation). Add the gate (TS/C# already route arrays away). Real latent bug.
- **`@stringFormat: email`** — 4 acceptance sets across ports (contradicts the hostname precedent,
  which pins a byte-identical canonical regex). **Ruling: document-and-accept** as Tier-1 idiomatic
  variance (email canonicalization is a rabbit hole with little adopter payoff) — UNLESS the owner
  prefers a canonical matcher like hostname. Note it in the docs; do not block on it.
- **Registry hygiene:** `validator.regex` registers meaningless `@min`/`@max` (inherited from
  `validator.base`) — manifest noise; optional cleanup. And the loader gates no
  validator-subtype↔field-subtype compatibility (a `validator.regex` on a numeric field emits
  `@Pattern` on a `Long` → runtime `ConstraintDeclarationException`) — optional loader guard, low priority.

### A4. Conformance (the missing gates — REQUIRED)

- **`fixtures/validation-conformance/cases.json`**: add `name-empty` (`""` → reject),
  `name-whitespace` (`"   "` → ACCEPT, per Ruling 1), `pattern-unanchored` (an authored `[A-Z]{3}`
  against `"xxABCyy"` → reject, per Ruling 2), and a `both-length-bounds` field (`@maxLength` +
  `validator.length @max` on one field → strictest-wins). These convict the semantic pins cross-port.
- **`fixtures/api-contract-conformance/scenarios/`**: `create-constraint-violation-400.yaml` and
  `update-constraint-violation-400.yaml` — a POST/PATCH with a value that violates `@Size`/`@Pattern`
  → 400 `{"error":"validation"}`; run on **all 5 ports, BOTH lanes**. These are the wire-tier gates
  that would have caught the decorative-annotation class. (They will be RED initially on C#/Python POST
  and on C#/Java/Kotlin/Python PATCH — green them with the A2 wiring.)

### A5. Doc corrections (with the landing commit)

- FR-035 `KNOWN_GAPS.md` (codegen-spring + codegen-kotlin): the "TS/Python DO validate on PATCH" claim
  is wrong — only TS did; correct it (and it becomes moot once wired).
- Reconcile the registry text: field `@required` says "NOT NULL", `validator.required` says
  "null/empty" — align both to the pinned non-empty semantic.
- Update the SP-C validator-parity design doc's "un-anchored" line to "full-match".

---

## 2. Program B — TPH partial-PATCH tristate on Java + Kotlin (FR-035 carry-over)

FR-035 shipped the tristate on the non-TPH controllers; TS/Python/C# also cover TPH, but **Java and
Kotlin left their TPH per-subtype update handlers on the old `@Valid` full-DTO binding** (no
`update-explicit-null-clears` TPH scenario exists, so it was ungated). Bring them onto the tristate:
- Java `SpringControllerGenerator` TPH path + `SpringDtoGenerator.emitPatch` for TPH bases (the union
  DTO); the per-subtype repository `patch`.
- Kotlin `KotlinSpringControllerGenerator` TPH controller path.
- Add a TPH `update-explicit-null-clears` scenario under `fixtures/api-contract-conformance/tph/` and
  gate it on all 5 ports (TS/Python/C# should already pass).

## 3. Program C — Kotlin jsonb open-bag on PATCH (FR-035 carry-over)

A `field.string @dbColumnType:jsonb` open bag is currently **create-only** on Kotlin (kotlinx
`JsonElement` can't bind on the raw-`JsonNode` PATCH path without tripping the #179 open-bag guard) —
create writes it, PATCH silently drops it (create/update asymmetry). Resolve: bind the open bag on the
PATCH path via the same type/codec create uses (write the raw JSON subtree into the jsonb column), or,
if genuinely unbindable, make it symmetric (document it as create-only in the contract, not an
accident). Verify against the existing `jsonb-open-bag-roundtrip` (which seeds via POST — don't break
create). This is niche; do not block the release on it if the symmetric+documented resolution stands.

## 4. Program D — C# owned-nav jsonb-array on PATCH (pre-existing, assess)

A `@required field.object @isArray @storage:jsonb` column is EF-mapped as an owned navigation, so
`FindProperty` returns null and the C# merge loop skips it (present values too) — a pre-existing
KNOWN GAP (`DbContextGenerator.cs` ~365), not an FR-035 regression. Assess whether to handle owned-nav
columns in the merge (`entry.Reference/Collection` API) or leave documented. Likely a follow-up, not a
release blocker — confirm with the owner.

---

## 5. Sequencing + release

1. **Semantic pins first** (A1) + their conformance cases (A4 validation-conformance) — small, and they
   de-risk the wiring (so the new wire scenarios don't expose a silent 3-vs-2 split on a new surface).
2. **Enforcement wiring** (A2) + the api-contract constraint-violation scenarios (A4) — the bulk;
   fork-per-port is the proven pattern (see FR-035). RED-gate first, green port by port.
3. **Non-blocking batch** (A3), **TPH** (Program B), **open-bag** (Program C) — fold in.
4. **Program D** — confirm scope with owner; likely defer.
5. **Coordinated BREAKING release** (npm/PyPI/NuGet/Maven) once all green: CHANGELOG breaking-banner
   for BOTH the FR-035 tristate AND FR-036 (required-string now non-empty everywhere — Java/Kotlin no
   longer reject whitespace; `@Pattern` now full-match on TS/Python; C#/Python now enforce field
   constraints over HTTP where they were decorative; PATCH now validates present values).

**Discipline reminders (every one burned someone on FR-035):** two-lane real-boot gates, not goldens
alone; a golden may ENCODE the bug (verify before regenerating); run code-review + code-simplifier per
unit before merge; the JVM ports compile generated code under `allWarningsAsErrors` (no unused
imports / always-true guards); PG-testcontainer readiness flakes under load (re-run, not a code
failure); PUBLIC repo hygiene (no home paths / private names). The Fable review's full evidence is in
this session's transcript; re-verify each file:line before changing — several FR-035 premises were wrong.

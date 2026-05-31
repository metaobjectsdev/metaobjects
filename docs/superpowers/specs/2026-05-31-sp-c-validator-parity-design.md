# SP-C — Validator Parity (generated input validation, all 5 ports)

**Date:** 2026-05-31
**Status:** Designed (user-approved key decisions; spec-review gate waived — "continue")
**Relates to:** enterprise-readiness program (SOON #4). New gate: `fixtures/validation-conformance/`.

## Problem

The metamodel expresses field input constraints two ways: field attrs (`@required`, `@maxLength`) and explicit `validator.*` subtypes (`validator.{required,length,regex,numeric,array}` with attrs `@min`/`@max`/`@pattern`). When code is generated, each port *should* enforce these in its input-validation layer. Today it's inconsistent:

| Port | `@required` | `@maxLength` | `validator.regex @pattern` | `validator.numeric @min/@max` | `validator.length`/`array` |
|---|---|---|---|---|---|
| **TS** (Zod `InsertSchema`/`UpdateSchema`) | ✅ | ✅ | ✅ | ✅ | ✅ |
| **C#** (DataAnnotations) | ✅ | ✅ | ❌ | ❌ | ❌ |
| **Python** (Pydantic `Field`) | ✅ | ✅ | ❌ | ❌ | ❌ |
| **Java** (Spring DTO) | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Kotlin** (Spring payload) | ❌ | ❌ | ❌ | ❌ | ❌ |

TS is the only complete port; C#/Python are partial (field-attrs only); Java/Kotlin emit no input validation on their DTOs. (Kotlin's `KotlinValidatorGenerator` is an unrelated *startup table-drift* check, not input validation.) So an enterprise declaring `validator.regex` / `validator.numeric` / length / array constraints gets them enforced only in TS — a silent cross-port integrity gap. And nothing gates validation behavior in any corpus today, so it can drift freely.

## Decisions (locked with user)

- **Full scope:** honor `@required` + `@maxLength` AND all `validator.{length,regex,numeric,array}` subtypes in every port's generated input validation.
- **Behavioral validation-conformance corpus** (not a structural manifest — that was FR-007, rejected): shared `(constraints, payload, expected verdict)` cases; each port runs each payload through its **generated** validation artifact and asserts the verdict. Mirrors the recover/extract-conformance precedent.

## Canonical validator semantics (TS is the reference)

- `validator.required` / field `@required` → value must be present (and for strings, non-empty: `.min(1)`).
- `validator.length` (`@min`/`@max`) + field `@maxLength` → string **character count** in `[min, max]`.
- `validator.regex` (`@pattern`) → string matches the (un-anchored unless authored) regex.
- `validator.numeric` (`@min`/`@max`) → numeric **value** in `[min, max]`.
- `validator.array` (`@min`/`@max`) → array **element count** in `[min, max]`.

Attr vocabulary (cross-port identical): `VALIDATOR_ATTR_MIN` (`@min`), `VALIDATOR_ATTR_MAX` (`@max`), `VALIDATOR_ATTR_PATTERN` (`@pattern`); field `@required`, `@maxLength`.

## The behavioral gate: `fixtures/validation-conformance/`

```
fixtures/validation-conformance/
├── README.md
├── meta.json            # one entity exercising every constraint
└── cases.json           # [{ name, payload, expectValid }]  (single-source verdicts)
```

- **`meta.json`** — an entity (e.g. `Account`) with fields covering each constraint exactly: a required string; a string with `@maxLength` + `validator.length @min`; a string with `validator.regex @pattern`; an int/decimal with `validator.numeric @min/@max`; a scalar array with `validator.array @min/@max`.
- **`cases.json`** — a **valid baseline** payload (`expectValid: true`) plus, per constraint, a payload that violates **only that one constraint** (`expectValid: false`): over-`@maxLength`, under-`validator.length @min`, `@pattern` mismatch, missing-`@required`, number below/above `validator.numeric` bounds, array below/above `validator.array` bounds. **Single-violation design** means a simple **boolean** verdict gates each constraint individually — if a port fails to enforce constraint X, its violates-X payload is wrongly accepted and the case fails. (A richer `expectViolations: [{field, kind}]` is a deferred enhancement; the boolean verdict avoids per-port native-error mapping while still pinning each constraint.)

**Verdict normalization:** every port's runner maps its native validation result to a boolean `valid` (Zod `safeParse().success`; jakarta `validator.validate(dto).isEmpty()`; Pydantic construct-or-`ValidationError`; .NET `Validator.TryValidateObject`). Single-source `expectValid` — all 5 ports assert the same booleans.

## Per-port implementation units

Each unit ends with the simplify + review gate; the sub-project merges forward once.

- **Unit 1 — Corpus + TS reference verification.** Author `fixtures/validation-conformance/{meta.json,cases.json,README.md}`. Add the TS runner (build the generated `InsertSchema`, `safeParse` each payload, assert `success === expectValid`). Verify TS passes all cases (it's the reference — if a case fails, fix the corpus, not TS, unless TS has a real gap in numeric/array coverage, in which case fix TS). This pins the canonical verdicts.
- **Unit 2 — C# completion.** Extend `EntityGenerator` (or a dedicated DTO/validation emitter) to emit `[RegularExpression]` (regex), `[Range]` (numeric), `[MinLength]`/`[StringLength(max, MinimumLength=min)]` (length), `[MinLength]`/`[MaxLength]` on arrays — on top of existing `[Required]`/`[MaxLength]`. C# runner: `Validator.TryValidateObject(payload, …, validateAllProperties:true)` → verdict. Refresh the SP-0 drift-gated `Generated/*.g.cs` if changed. All cases pass.
- **Unit 3 — Python completion.** Extend the Pydantic entity-model generator to emit `Field(pattern=…, ge=…, le=…, min_length=…, max_length=…)` and array `min_length`/`max_length` (or `conlist`). Python runner: construct the model, catch `ValidationError` → verdict. All cases pass.
- **Unit 4 — Java (Spring) NEW input validation.** Emit `jakarta.validation` annotations on the generated DTO/payload record: `@NotNull`/`@NotBlank` (required), `@Size(min,max)` (length + array element count), `@Pattern(regexp)` (regex), `@Min`/`@Max` or `@DecimalMin`/`@DecimalMax` (numeric), `@Valid` on the controller request body. Java runner: a jakarta `Validator` over the generated DTO → verdict. All cases pass.
- **Unit 5 — Kotlin (Spring) NEW input validation.** Same jakarta annotations on the generated payload data class (use `@field:` site targets) + `@Valid`. Kotlin runner: jakarta `Validator` → verdict. All cases pass. (Distinct from the existing `KotlinValidatorGenerator` startup table-validator — leave that alone.)
- **Unit 6 — Gate + cross-port sweep.** Wire the 5 runners into CI (the byte-exact `conformance.yml` job — these are unit-level, no Docker). Confirm all 5 produce identical booleans for every case; no port silently skips a case. Document the corpus in its README + note the deferred richer-verdict enhancement.

## Edge cases / non-goals

- **Regex portability:** authored patterns must use a cross-language-safe subset (no PCRE-only constructs). The corpus pattern is a simple ASCII class (e.g. `^[A-Z]{3}$`) that behaves identically in JS/Java/.NET/Python regex engines. Documented in the corpus README.
- **Numeric bounds on decimal:** use the SP-A `field.decimal` semantics; `@min/@max` compare by value. Keep the corpus numeric field an `int` to avoid decimal-string parsing nuance in `@Min/@Max` (jakarta `@Min` is long-valued); a decimal-range case is a deferred enhancement.
- **Verdict granularity:** boolean now; per-field/per-constraint reason is a deferred enhancement (would need per-port native-error mapping).
- **Validation is advisory at the type layer, enforced at the boundary:** generated entities/DTOs carry the annotations; actual enforcement is the framework's job (Spring `@Valid`, FastAPI/Pydantic on parse, ASP.NET model binding, Zod on the route). The corpus tests the *generated artifact's* validation directly (construct + validate), which is the deterministic, Docker-free unit of the guarantee.
- **Not** changing the metamodel validator vocabulary or adding new subtypes.

## Definition of done

- Every port's generated input-validation enforces `@required` + `@maxLength` + `validator.{length,regex,numeric,array}`.
- `fixtures/validation-conformance/` runs on all 5 ports, byte-identical boolean verdicts, CI-gated; no silent per-port skips.
- TS reference unchanged in behavior (or minimally extended if a numeric/array gap surfaces); Java/Kotlin gain DTO validation; C#/Python complete theirs.

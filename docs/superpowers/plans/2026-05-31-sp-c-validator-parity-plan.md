# SP-C Validator Parity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Fresh subagent per unit + spec-compliance review + code-quality review + simplifier, then merge forward. Steps use `- [ ]`.

**Goal:** Every port's generated input-validation enforces `@required` + `@maxLength` + `validator.{length,regex,numeric,array}`, gated by a new behavioral `fixtures/validation-conformance/` corpus (shared payloads → boolean verdicts, byte-identical across 5 ports).

**Architecture:** Single-violation payloads + boolean verdict → each constraint gated individually without per-port native-error mapping. TS (Zod) is the reference. C#/Python complete their annotations; Java/Kotlin gain jakarta.validation on generated DTOs. Each port has a small runner: build the generated validation artifact for the corpus entity, run each payload, map to boolean `valid`, assert == `expectValid`.

**Tech stack:** TS (Zod), C# (DataAnnotations + `Validator.TryValidateObject`), Python (Pydantic), Java/Kotlin (jakarta.validation). Design: `docs/superpowers/specs/2026-05-31-sp-c-validator-parity-design.md`.

**Worktree:** `<repo-root>/.claude/worktrees/sp-c-validator-parity` (branch `sp-c-validator-parity`, off origin/main).

---

### Unit 1: Corpus + TS reference runner (pins canonical verdicts)

**Files:**
- Create: `fixtures/validation-conformance/meta.json`, `cases.json`, `README.md`
- Create: TS runner + test under `server/typescript/packages/integration-tests/` (or `codegen-ts` test) — wherever the generated `InsertSchema` can be built from corpus metadata (mirror how the api-contract/golden tests load metadata + run generators).

- [ ] **Step 1 — Author `meta.json`.** One entity `Account` (package `acme::auth`) with a writable `source.rdb`, exercising each constraint exactly once:
  - `id` `field.long` `identity.primary @generation=increment`
  - `name` `field.string` `@required: true`, `@maxLength: 10` (gates required + maxLength)
  - `code` `field.string` with `validator.length @min=3` and `validator.regex @pattern="^[A-Z]+$"` (gates length-min + regex; ASCII-only pattern, cross-engine safe)
  - `score` `field.int` with `validator.numeric @min=0 @max=100` (gates numeric range)
  - `tags` `field.string isArray:true` with `validator.array @min=1 @max=3` (gates array element count)
- [ ] **Step 2 — Author `cases.json`.** A valid baseline (`expectValid: true`) + one single-violation payload (`expectValid: false`) per constraint: name-missing, name-too-long (>10), code-too-short (<3), code-pattern-mismatch (lowercase), score-below-0, score-above-100, tags-empty (0), tags-too-many (4). Each violates exactly one constraint; everything else valid.
- [ ] **Step 3 — TS runner + test.** Load `meta.json`, build the generated `AccountInsertSchema` (use the codegen template `renderInsertSchemaOnly`/the entity generator path), `safeParse` each payload, assert `result.success === case.expectValid`. Run; TS is the reference. If a case fails, first check the corpus is right; if TS genuinely lacks numeric/array enforcement, fix `zod-validators.ts` (real gap) and note it.
- [ ] **Step 4 — Commit.** `feat(conformance): SP-C Unit 1 — validation-conformance corpus + TS reference runner`

### Unit 2: C# completion

**Files:**
- Modify: `server/csharp/MetaObjects.Codegen/Generators/EntityGenerator.cs` (or a dedicated validation-annotation emitter) — add `[RegularExpression]`, `[Range]`, length-min (`[StringLength(max, MinimumLength=min)]` or `[MinLength]`), array `[MinLength]`/`[MaxLength]`.
- Create: C# runner + xUnit test that loads the corpus, generates the `Account` DTO, and validates each payload via `Validator.TryValidateObject(..., validateAllProperties: true)`.

- [ ] **Step 1 — Failing test.** Add the C# runner asserting verdicts; run — expect the regex/numeric/length/array violation cases to wrongly pass (C# doesn't enforce them yet).
- [ ] **Step 2 — Emit the annotations.** From `validator.regex @pattern` → `[RegularExpression("…")]`; `validator.numeric @min/@max` → `[Range(min, max)]`; `validator.length @min` (+ `@maxLength`) → `[StringLength(max, MinimumLength=min)]`; `validator.array @min/@max` → `[MinLength(min)]`/`[MaxLength(max)]`. Keep existing `[Required]`/`[MaxLength]`.
- [ ] **Step 3 — Drift gate.** If the integration `Generated/*.g.cs` change, refresh via the SP-0 `Regenerate_committed_fixtures` harness + confirm `IntegrationFixtureDriftTests` green.
- [ ] **Step 4 — Verify.** `cd server/csharp && dotnet test MetaObjects.Codegen.Tests/MetaObjects.Codegen.Tests.csproj` — runner cases pass, no regression.
- [ ] **Step 5 — Commit.** `feat(codegen-cs): emit RegularExpression/Range/length/array DataAnnotations (SP-C)`

### Unit 3: Python completion

**Files:**
- Modify: `server/python/src/metaobjects/codegen/generators/entity_model.py` — add `Field(pattern=, ge=, le=, min_length=, max_length=)` + array length.
- Create: Python runner + pytest that generates the `Account` model and validates each payload (construct → catch `ValidationError`).

- [ ] **Step 1 — Failing test.** Python runner asserting verdicts; expect regex/numeric/length/array cases to wrongly pass.
- [ ] **Step 2 — Emit constraints.** `validator.regex @pattern` → `Field(pattern="…")`; `validator.numeric @min/@max` → `Field(ge=min, le=max)`; `validator.length @min` (+`@maxLength`) → `Field(min_length=min, max_length=max)`; `validator.array @min/@max` → list length (`Field(min_length=, max_length=)` on a `list` / `conlist`). Keep existing required/max_length.
- [ ] **Step 3 — Verify.** `cd server/python && uv run --extra dev pytest tests/ -q` — runner cases pass, no regression.
- [ ] **Step 4 — Commit.** `feat(codegen-py): emit Pydantic pattern/ge/le/min_length/array constraints (SP-C)`

### Unit 4: Java (Spring) — NEW input validation

**Files:**
- Modify: the codegen-spring DTO/payload generator (find the one emitting the create/update DTO or payload record) — add jakarta.validation annotations + `@Valid` on the controller request body.
- Create: Java runner + JUnit test that generates the `Account` DTO and validates each payload via a jakarta `Validator`.

- [ ] **Step 1 — Locate the DTO generator** in `server/java/codegen-spring/src/main/java` (the create/update request DTO). Confirm there is no jakarta validation today.
- [ ] **Step 2 — Failing test.** Java runner building a jakarta `Validator` (`Validation.buildDefaultValidatorFactory().getValidator()`) over the generated DTO; assert `validator.validate(dto).isEmpty() == expectValid`. Expect all violation cases to wrongly pass.
- [ ] **Step 3 — Emit annotations.** `@NotNull`/`@NotBlank` (required), `@Size(min=, max=)` (length + `@maxLength`), `@Pattern(regexp="…")` (regex), `@Min`/`@Max` (numeric int), `@Size(min=, max=)` on the collection (array), `@Valid` on the controller `@RequestBody`. Add the jakarta.validation dependency to codegen-spring's generated-project expectations if needed (the runner needs it on the test classpath).
- [ ] **Step 4 — Verify.** `cd server/java && mvn -q -pl codegen-spring -am test` — runner cases pass, no regression. (If the runner needs a separate module/classpath, place it where jakarta validation is available.)
- [ ] **Step 5 — Commit.** `feat(codegen-spring): jakarta.validation on generated DTO (@Size/@Pattern/@Min/@Max/@NotNull) (SP-C)`

### Unit 5: Kotlin (Spring) — NEW input validation

**Files:**
- Modify: `KotlinPayloadGenerator.kt` (or the DTO generator) — jakarta annotations with `@field:` site targets + `@Valid`.
- Create: Kotlin runner + test (jakarta `Validator` over the generated payload data class).

- [ ] **Step 1 — Failing test.** Kotlin runner asserting verdicts; expect violation cases to wrongly pass.
- [ ] **Step 2 — Emit annotations.** `@field:NotNull`/`@field:NotBlank`, `@field:Size(min,max)`, `@field:Pattern(regexp="…")`, `@field:Min`/`@field:Max`, `@field:Size` on the `List`, `@Valid`. (Leave the existing `KotlinValidatorGenerator` startup table-validator untouched — different concern.)
- [ ] **Step 3 — Verify.** `cd server/java && mvn -q -pl codegen-kotlin -am test` — runner cases pass, no regression.
- [ ] **Step 4 — Commit.** `feat(codegen-kotlin): jakarta.validation on generated payload data class (SP-C)`

### Unit 6: Gate + cross-port sweep + finish

- [ ] **Step 1 — CI gate.** Wire the 5 runners into the byte-exact `conformance.yml` job (unit-level, no Docker). Confirm each runs on PRs + pushes. (TS likely already runs under its package suite; C#/Python/Java/Kotlin runners run under their `dotnet test`/`pytest`/`mvn test` — confirm the workflow invokes them.)
- [ ] **Step 2 — Sweep.** Confirm all 5 ports produce identical booleans for every case; no port silently skips. Document `fixtures/validation-conformance/README.md` (the cross-engine-safe regex note + the deferred richer-verdict enhancement).
- [ ] **Step 3 — Final review.** Simplifier + code-reviewer over the whole SP-C diff (focus: each port enforces the FULL set; the boolean-verdict single-violation design genuinely gates each constraint; jakarta annotations on Java/Kotlin actually fire under the runner's `Validator`).
- [ ] **Step 4 — Finish.** Merge forward to origin/main (integrate-before-merge — main is very active). Update memory.

## Self-review notes
- The single-violation + boolean-verdict design is load-bearing: each "violates only X" payload, asserted invalid, fails any port that doesn't enforce X. Keep payloads strictly single-violation.
- jakarta `@Min`/`@Max` are long-valued — corpus numeric field is `int` to avoid decimal nuance (a decimal-range case is deferred).
- Regex must be cross-engine-safe (`^[A-Z]+$`) — no PCRE-only constructs.
- Each port's runner must build the GENERATED validation artifact (not hand-write the DTO) so it tests codegen output, like SP-B's lane.
- Don't touch Kotlin's existing `KotlinValidatorGenerator` (startup table-drift, unrelated).

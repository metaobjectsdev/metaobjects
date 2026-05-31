# SP-A Type Fidelity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Fresh subagent per unit + spec-compliance review + code-quality review + simplifier, then merge forward. Steps use `- [ ]`.

**Goal:** Make `field.decimal` (with `@precision`/`@scale`) and fractional-millisecond `TIMESTAMP`/`TIMESTAMPTZ`/`TIME` faithful and byte-identical across all five ports, gated by `fixtures/persistence-conformance/`.

**Architecture:** TS owns the schema (canonical `schema.postgres.sql`) and the corpus; each port fixes its own decimal binding + read-path normalization. Decisions: TS decimal → `string`; C# → `decimal`; Kotlin → `BigDecimal` + Exposed `decimal(p,s)`; Java `BigDecimal` / Python `Decimal` retained (Python internal `DataType` corrected off `DOUBLE`). Sub-second = milliseconds (`.fff`), no trailing zeros, omit `.` when zero (keeps existing whole-second rows byte-identical).

**Tech stack:** TS (bun, migrate-ts, codegen-ts), C# (EF Core, xUnit, Testcontainers), Java (OMDB, JUnit), Python (SQLAlchemy Core, pytest), Kotlin (Exposed, KotlinPoet). Design: `docs/superpowers/specs/2026-05-31-sp-a-type-fidelity-design.md`.

**Worktree:** `/home/doug/Development/metaobjects/.claude/worktrees/sp-a-type-fidelity` (branch `sp-a-type-fidelity`, off origin/main).

---

### Unit 1: Corpus + wire contract + TS schema (the gate foundation)

**Files:**
- Modify: `fixtures/persistence-conformance/canonical/meta.fitness.json` (add decimal field; seed fractional values)
- Modify: `fixtures/persistence-conformance/normalization.md` (decimal + fractional-ms rules)
- Modify: `server/typescript/packages/migrate-ts/src/expected-schema.ts:416` (wire `@precision`/`@scale` into the `numeric` SqlType)
- Regenerate: `fixtures/persistence-conformance/canonical/schema.postgres.sql` (`bun run gen:schema`)
- Modify: the query scenario file(s) under `fixtures/persistence-conformance/` whose `expect:` rows cover Measurement / Asset
- Test: `server/typescript/packages/integration-tests/test/schema-artifact.test.ts` (drift gate must pass post-regen)

- [ ] **Step 1 — Add the decimal field.** In `meta.fitness.json`, add to `Measurement` (table `measurements`):
  `{ "field.decimal": { "name": "preciseKg", "@required": true, "@precision": 9, "@scale": 4 } }`
- [ ] **Step 2 — Wire precision/scale into the TS SqlType.** In `expected-schema.ts`, change the decimal case to read the field's `@precision`/`@scale` attrs and emit `{ kind: "numeric", precision, scale }`. Mirror how other physical attrs are read in that file. If absent, fall back to bare `{ kind: "numeric" }` (back-compat).
- [ ] **Step 3 — Regenerate the canonical schema.** `cd server/typescript/packages/integration-tests && bun run gen:schema`. Confirm `schema.postgres.sql` now has `NUMERIC(9,4)` (or the chosen p,s) for `measurements.preciseKg` (snake_case per the column-naming strategy → likely `precise_kg`; match the existing convention in the file).
- [ ] **Step 4 — Update normalization.md.** Replace the "whole-second only; fractional deferred" pin (~line 45) with the millisecond rule: `TIMESTAMP`→`...SS.fff` (no Z), `TIMESTAMPTZ`→`...SS.fffZ`, `TIME`→`HH:MM:SS.fff`; **fractional digits carry no trailing zeros and the `.` is omitted entirely when sub-second is zero** (so existing whole-second rows are unchanged). Confirm the `NUMERIC`→string-no-trailing-zeros rule is stated (it already is).
- [ ] **Step 5 — Seed fractional values + decimal expectations.** In the scenario fixtures: give some Asset rows fractional-ms `recordedAt`/`observedAt`/`atTime` (e.g. `.123`), KEEP at least one whole-second Asset row; add Measurement `preciseKg` seed values exercising trailing-zero strip (`12.5000`→`"12.5"`), integer-valued (`100.0000`→`"100"`), high-scale (`0.0001`), and a negative. Set the single-source `expect:` strings to the canonical forms.
- [ ] **Step 6 — Verify TS schema + artifact gate.** `cd server/typescript && bun test packages/integration-tests/test/schema-artifact.test.ts` passes. (Full TS integration runs in Unit 2 once the read-path lands.)
- [ ] **Step 7 — Commit.** `feat(conformance): SP-A Unit 1 — seed field.decimal + fractional-ms; wire precision/scale into TS schema`

### Unit 2: TypeScript read-path + codegen

**Files:**
- Modify: `server/typescript/packages/codegen-ts/src/templates/inferred-types.ts:97` (`FIELD_SUBTYPE_DECIMAL` → `"string"`)
- Modify: `server/typescript/packages/codegen-ts/src/generators/docs-data-builder.ts:89` (same)
- Modify: `server/typescript/packages/codegen-ts/src/column-mapper.ts:88` (decimal column mapping → text/numeric returning string)
- Check: `server/typescript/packages/codegen-ts/src/templates/fr010-field-mapping.ts:60`, `filter-type.ts`, `filter-allowlist.ts` (decimal must stay in the NUMERIC operator band even though TS type is `string`)
- Modify: TS integration runner normalization (`packages/integration-tests/src/normalization.ts` + temporal parsers) for decimal-string canonicalization + fractional-ms
- Test: `server/typescript && bun test` (persistence + api-contract)

- [ ] **Step 1 — Failing test.** Run the TS integration persistence suite against the Unit-1 corpus; expect failures on `preciseKg` (currently `number`) and fractional timestamps.
- [ ] **Step 2 — Bind decimal → string.** Update `inferred-types.ts`, `docs-data-builder.ts`, `column-mapper.ts`. Ensure filter operator classification still treats decimal as numeric (operators `eq/ne/gt/gte/lt/lte/in/isNull`).
- [ ] **Step 3 — Normalization.** NUMERIC arrives from pg as string → strip trailing zeros (+ bare trailing `.`); fractional-ms canonicalization in the temporal parsers (ms, no trailing zeros, omit `.` when zero). Reuse the existing REAL/DOUBLE plain-decimal canonicalizer where possible.
- [ ] **Step 4 — Verify.** `cd server/typescript && bun test` green (persistence + api-contract + codegen). Confirm a generated entity now shows `preciseKg: string`.
- [ ] **Step 5 — Commit.** `feat(codegen-ts): field.decimal -> string + fractional-ms read-path (SP-A)`

### Unit 3: C# read-path + codegen

**Files:**
- Modify: `server/csharp/MetaObjects.Codegen/Generators/Fr010FieldMapping.cs:100` (decimal → `Decimal`, split from double/float)
- Modify: `server/csharp/MetaObjects.Codegen/Runtime/RecoverObject.cs:252` (decimal → `FieldKind.Decimal`/equivalent)
- Modify: the EntityGenerator CLR-type map + EF precision (`decimal` property + `HasPrecision`/`[Column(TypeName="numeric(9,4)")]`); check `CSharpNaming.cs`
- Modify: `server/csharp/MetaObjects.IntegrationTests/Runner/Normalization.cs` (decimal + DateTime fractional-ms)
- Regenerate: `MetaObjects.IntegrationTests/Generated/*.g.cs` IF the decimal property changes them → the SP-0 drift gate will flag; refresh via the skipped harness and re-run integration
- Test: `scripts/integration-test.sh` C# path (Docker) + `dotnet test MetaObjects.Codegen.Tests`

- [ ] **Step 1 — Failing test / regen.** Add a `FieldKind.Decimal` (or reuse) so decimal is no longer `Double`. Map to C# `decimal`.
- [ ] **Step 2 — EntityGenerator precision.** Emit `decimal` property with EF precision metadata matching `@precision`/`@scale`.
- [ ] **Step 3 — Refresh Generated fixtures + drift gate.** If `Measurement.g.cs`/`AppDbContext.g.cs` change, regenerate (un-skip `Regenerate_committed_fixtures`, run, re-skip) and confirm `IntegrationFixtureDriftTests` passes.
- [ ] **Step 4 — Normalization.** `decimal`/`DateTime` → canonical strings (ms).
- [ ] **Step 5 — Verify.** `dotnet test MetaObjects.Codegen.Tests` green; C# integration (Docker) green.
- [ ] **Step 6 — Commit.** `feat(codegen-cs): field.decimal -> System.Decimal + fractional-ms (SP-A)`

### Unit 4: Java read-path

**Files:**
- Verify: `server/java/codegen-spring/.../SpringTypeMapper.java:69` (already `BigDecimal`)
- Modify: `server/java/integration-tests/.../Normalization.java` (BigDecimal `stripTrailingZeros().toPlainString()`; `OffsetDateTime`/`LocalDateTime`/`LocalTime` fractional-ms)
- Modify (if needed): OMDB read codec so NUMERIC → `BigDecimal`
- Test: `server/java/integration-tests` (Docker) + omdb suite

- [ ] **Step 1 — Failing test.** Run Java integration against the new corpus; expect decimal/fractional failures.
- [ ] **Step 2 — Normalization.** Canonicalize `BigDecimal` (strip trailing zeros, plain string; handle `0E-4` → `"0"`) + fractional-ms temporals.
- [ ] **Step 3 — Verify.** Java integration green (Docker).
- [ ] **Step 4 — Commit.** `feat(omdb): field.decimal + fractional-ms read-path normalization (SP-A)`

### Unit 5: Python read-path

**Files:**
- Modify: `server/python/src/metaobjects/meta/core/field/meta_field.py:18` (decimal `DataType.DOUBLE` → an exact/decimal DataType so runtime preserves `Decimal`)
- Modify: `server/python/src/metaobjects/runtime/object_manager.py` (sub-second truncation → carry ms; NUMERIC `Decimal` preserved — line ~275)
- Modify: `server/python/tests/integration/normalization.py` (Decimal + fractional-ms canonicalization)
- Test: `uv run --extra dev --extra integration pytest tests/integration` (Docker)

- [ ] **Step 1 — Failing test.** Run Python integration; expect decimal/fractional failures (truncation).
- [ ] **Step 2 — Fix DataType + truncation.** Decimal preserved as `Decimal`; sub-second carried at ms.
- [ ] **Step 3 — Normalization.** Canonicalize `Decimal` (normalize/strip trailing zeros; `Decimal("100.0000")`→`"100"`) + fractional-ms.
- [ ] **Step 4 — Verify.** Python integration green (Docker).
- [ ] **Step 5 — Commit.** `feat(runtime-py): field.decimal Decimal fidelity + fractional-ms (SP-A)`

### Unit 6: Kotlin codegen + read-path

**Files:**
- Modify: `server/java/codegen-kotlin/.../KotlinTypeMapper.kt` (add `DecimalField` arm: native `java.math.BigDecimal`; Exposed `decimal(precision, scale)` reading `@precision`/`@scale` like the maxLength helper)
- Add/modify: a codegen unit test mirroring the `TimeField`-arm test
- Modify: `server/java/integration-tests-kotlin/.../Normalization.kt` + the Exposed table for Measurement (`tables/*.kt`) — add `decimal` column
- Test: `server/java/codegen-kotlin` tests + `integration-tests-kotlin` (Docker)

- [ ] **Step 1 — Failing test.** A codegen test that maps a `DecimalField` currently throws; assert it should map to `BigDecimal` / Exposed `decimal(p,s)`.
- [ ] **Step 2 — Add the arm.** Native-type mapping (`is DecimalField -> ClassName("java.math","BigDecimal")`) + Exposed column mapping (`decimal(name, precision, scale)`), reading `@precision`/`@scale`.
- [ ] **Step 3 — Exposed table + normalization.** Add the `preciseKg` decimal column to the Measurement Exposed table; canonicalize `BigDecimal` + fractional-ms in `Normalization.kt`.
- [ ] **Step 4 — Verify.** codegen tests + Kotlin integration green (Docker).
- [ ] **Step 5 — Commit.** `feat(codegen-kotlin): DecimalField arm (BigDecimal + Exposed decimal) + fractional-ms (SP-A)`

### Unit 7: Cross-port sweep + close-out

- [ ] **Step 1 — Byte-identity check.** Confirm all five runners emit identical canonical strings for the new decimal + fractional scenarios (diff expect-vs-actual logs).
- [ ] **Step 2 — No silent skips.** Confirm every port's deferral ledger stays empty and corpus scenario counts bumped consistently across ports.
- [ ] **Step 3 — Docs.** Update CLAUDE.md status / roadmap if it enumerates type coverage; note decimal + fractional-ms now conformance-gated.
- [ ] **Step 4 — Final review.** Dispatch a final cross-cutting code-reviewer over the whole SP-A diff. Then finish the branch (merge forward to origin/main).

## Self-review notes
- Decimal stays in the numeric **filter-operator** band in every port despite TS's `string` representation (classification keys off subtype). Verify api-contract stays green where filterable decimals appear (none in the corpus by default — if a decimal isn't `@filterable`, no api-contract impact).
- The omit-`.`-when-zero fractional rule is the linchpin that keeps existing whole-second scenarios byte-identical — every port's temporal canonicalizer must implement it the same way.
- C# `System.Decimal` 28–29 digit bound: corpus uses `NUMERIC(9,4)`, well within range.

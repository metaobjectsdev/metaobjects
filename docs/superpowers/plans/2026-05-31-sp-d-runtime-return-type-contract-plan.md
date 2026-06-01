# SP-D Runtime Return-Type Contract — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Fresh subagent per unit + spec-compliance review + code-quality review + simplifier, then merge forward. Steps use `- [ ]`.

**Goal:** Document the runtime return-type contract (native-in-process; canonicalize at the wire/serialization seam) as ADR-0019, reconcile Python to it, fix `field.decimal` to surface exact native decimals on the JVM/Python runtimes (Java `DataTypes.DECIMAL`; Python `Decimal`), and gate native return types per port.

**Architecture:** Java/C#/Kotlin/TS already return native types (canonicalize at the harness). Python canonicalizes inside `ObjectManager` — move that to its persistence runner. Decimal is backed by `DOUBLE` on Java+Python — give Java a real `DataTypes.DECIMAL`→BigDecimal and Python a `Decimal` DataType, then remove the SP-A harness `BigDecimal.valueOf(double)` workaround.

**Tech stack:** Java (`metadata` DataTypes + OMDB), Python (pg8000 + ObjectManager), all 5 ports for the gate. Design: `docs/superpowers/specs/2026-05-31-sp-d-runtime-return-type-contract-design.md`. **ADR number: 0019** (0018 is latest).

**Worktree:** `<repo-root>/.claude/worktrees/sp-d-runtime-contract` (branch `sp-d-runtime-contract`, off origin/main).

---

### Unit 1: ADR-0019 + CLAUDE.md pointer

**Files:**
- Create: `spec/decisions/ADR-0019-runtime-return-type-contract.md` (Nygard format)
- Modify: `spec/decisions/README.md` (add the ADR to the index, matching the existing list format)
- Modify: `CLAUDE.md` (one line + pointer in the "Cross-language porting" section)

- [ ] **Step 1 — Write ADR-0019.** Nygard format (Context / Decision / Consequences). Decision: a port's runtime `ObjectManager` returns native, in-process language types; canonicalization to the cross-port wire form is a serialization/boundary concern, never baked into the runtime. Include the per-concept native-type table from the design doc (incl. TS `string` for decimal, tz-aware-vs-naive temporal distinction). Note Python was the outlier (canonicalized in-runtime) and is reconciled by SP-D.
- [ ] **Step 2 — Index it** in `spec/decisions/README.md` (match the format of the ADR-0018 entry).
- [ ] **Step 3 — CLAUDE.md pointer.** In the "Cross-language porting" section, add one line: runtime returns native types, canonicalize at the boundary — see ADR-0019.
- [ ] **Step 4 — Commit.** `docs(adr): ADR-0019 runtime return-type contract (native-in-process; canonicalize at the boundary)`

### Unit 2: Java `DataTypes.DECIMAL` + DecimalField + switch-site audit

**Files:**
- Modify: `server/java/metadata/src/main/java/com/metaobjects/DataTypes.java` (add `DECIMAL(10)`)
- Modify: `server/java/metadata/src/main/java/com/metaobjects/field/DecimalField.java` (`DataTypes.DOUBLE` → `DataTypes.DECIMAL`)
- Audit + modify the 11 `case DOUBLE` sites (add `case DECIMAL`): `om/.../exp/parser/ExpressionParser.java`, `om/.../ObjectComparator.java`, `omdb/.../db/SimpleMappingHandlerDB.java`, `metadata/.../DataTypes.java`, `metadata/.../validator/LengthValidator.java`, `metadata/.../io/object/gson/MetaObjectSerializer.java`, `metadata/.../io/object/gson/MetaObjectDeserializer.java`, `metadata/.../io/object/json/JsonObjectReader.java`, `metadata/.../util/DataConverter.java`, `codegen-base/.../javacode/JavaCodeWriter.java`, `render/.../extract/Coerce.java`
- Modify: `server/java/omdb/src/test/.../codec/JdbcCodecRoundTripTest.java`, `.../BulkCreateFallbackTest.java` (expect `BigDecimal`)
- Modify: `server/java/integration-tests/src/test/.../ObjectManagerDbAdapter.java` (remove the `BigDecimal.valueOf(double)` workaround)

- [ ] **Step 1 — Add `DataTypes.DECIMAL(10)`.** `valueClass = BigDecimal.class`, `isNumeric = true`. Slot 10 is free (DATE=9 → BOOLEAN_ARRAY=11). Add to the `arrayTypeFor`/scalar-pair mapping switches IF they `switch` exhaustively (so they don't throw on DECIMAL); a `DECIMAL_ARRAY` is NOT needed (defer). Run `mvn -pl metadata test` — see what breaks.
- [ ] **Step 2 — Point DecimalField at DECIMAL.** Change the constructor `super(SUBTYPE_DECIMAL, name, DataTypes.DECIMAL)`. `getValueClass()` now returns `BigDecimal`, consistent with `PrimitiveField<BigDecimal>`.
- [ ] **Step 3 — Audit the 11 sites.** For each `case DOUBLE`, decide: (a) numeric-concern → add `case DECIMAL:` falling through to the DOUBLE arm (e.g. ExpressionParser, ObjectComparator, LengthValidator, JavaCodeWriter where it's "is numeric"); (b) value-class-concern → handle `BigDecimal` correctly (MetaObjectSerializer/Deserializer write/read BigDecimal; DataConverter `toBigDecimal`; JsonObjectReader; render/extract/Coerce parses to BigDecimal; SimpleMappingHandlerDB maps DECIMAL column). Compile after each module. Do NOT change DOUBLE/FLOAT behavior.
- [ ] **Step 4 — Update round-trip tests** to expect `BigDecimal` (they previously asserted Double for the decimal field).
- [ ] **Step 5 — Remove the SP-A harness workaround** in `ObjectManagerDbAdapter.coerceWireType` (the NUMERIC→`BigDecimal.valueOf(double)` branch) — OMDB now returns `BigDecimal` natively, so the harness `Normalization` canonicalizes it directly.
- [ ] **Step 6 — Verify.** `cd server/java && mvn -q -pl metadata,om,omdb,render,codegen-base -am test 2>&1 | tail -30` green; then the Docker persistence corpus: `cd server/java && mvn -q -f integration-tests/pom.xml test 2>&1 | tail -20` — `QueryScenarioTests` still byte-exact (the decimal wire string is unchanged, now from an exact value). Full reactor `mvn -q install -DskipTests` builds.
- [ ] **Step 7 — Commit.** `feat(metadata): DataTypes.DECIMAL + DecimalField->BigDecimal; OMDB surfaces exact decimals (SP-D Unit 2)`

### Unit 3: Python — `Decimal` DataType + native-return reconciliation

**Files:**
- Modify: `server/python/src/metaobjects/meta/core/field/data_type.py` (add `DECIMAL = "decimal"`)
- Modify: `server/python/src/metaobjects/meta/core/field/meta_field.py:18` (`FIELD_SUBTYPE_DECIMAL → DataType.DECIMAL`)
- Modify: `server/python/src/metaobjects/runtime/object_manager.py` (remove `_coerce_for_contract` from the query path → return native pg8000 types)
- Modify: `server/python/tests/integration/normalization.py` (canonicalize by Python type — move the coercion here)

- [ ] **Step 1 — Add `DataType.DECIMAL`** + map `FIELD_SUBTYPE_DECIMAL → DataType.DECIMAL`. Run the Python suite to see what assumes decimal=DOUBLE.
- [ ] **Step 2 — Make ObjectManager return native.** Remove the `_coerce_for_contract` call from `find_by_id`/`find_many` (line ~85) so rows carry native pg8000 values (`int`, `Decimal`, `datetime` [tz-aware for TIMESTAMPTZ / naive for TIMESTAMP], `date`, `time`, `uuid.UUID`, `dict`/`list` for jsonb). Keep/relocate any genuinely-needed shaping, but the return must be native.
- [ ] **Step 3 — Canonicalize in the runner by type.** In `tests/integration/normalization.py`, add a by-Python-type canonicalizer (mirror the other ports' by-native-type runners): `Decimal`→no-trailing-zero string (reuse the existing decimal canonicalizer if present), tz-aware `datetime`→`…Z`, naive `datetime`→no-Z, `date`→`YYYY-MM-DD`, `time`→`HH:MM:SS[.fff]`, `uuid.UUID`→`str().lower()`, `dict`/`list`→key-sorted JSON, `int`→int, bigint native int→the BIGINT-as-string wire rule. Apply it in the Python persistence runner over each result row. (The tz-aware-vs-naive distinction replaces the old OID-keyed approach.)
- [ ] **Step 4 — Grep for other consumers** of the string-returning behavior (`_coerce_for_contract`, any test/code asserting `find_*` returns strings) and reconcile.
- [ ] **Step 5 — Verify.** `cd server/python && uv run --extra dev --extra integration pytest tests/integration -q` (Docker) — persistence corpus byte-exact; `uv run --extra dev pytest tests/ --ignore=tests/integration -q` — no regression.
- [ ] **Step 6 — Commit.** `feat(runtime-py): ObjectManager returns native types; decimal->Decimal; canonicalize in the runner (SP-D Unit 3)`

### Unit 4: Per-port runtime-type gate

**Files (one focused test per port, in the persistence/integration test module):**
- TS: `server/typescript/packages/integration-tests/test/` (new `runtime-types.test.ts` or add to query test)
- C#: `server/csharp/MetaObjects.IntegrationTests/`
- Java: `server/java/integration-tests/src/test/.../`
- Kotlin: `server/java/integration-tests-kotlin/src/test/.../`
- Python: `server/python/tests/integration/`

- [ ] **Step 1 — Per port, assert native runtime return types.** Query a `meta.fitness` corpus row through the runtime `ObjectManager` (NOT the canonicalizing harness path) and assert BEFORE canonicalization: an integer field (`id`/`durationMinutes`) is a native integer type; `preciseKg` is the native decimal type (Java/Kotlin `BigDecimal`, C# `decimal`, Python `Decimal`, TS `string`); a timestamp field is a native temporal type (not a string); `payload` jsonb is a native map/dict/object. Each port asserts its own native types (no cross-port byte-identity). Use the seed already provisioned by the persistence runner.
- [ ] **Step 2 — Wire into CI.** These run under each port's existing integration/persistence job (`integration-tests.yml` Docker job, or the per-port test invocation). Confirm each new test is picked up; if a port's runtime-type test needs no Docker, it may also fit the per-port unit run — place it where it actually runs in CI.
- [ ] **Step 3 — Commit.** `test(conformance): per-port runtime-return-type assertions (native, not wire-string) (SP-D Unit 4)`

### Unit 5: Cross-port sweep + finish

- [ ] **Step 1 — Sweep.** All 5 persistence corpora byte-exact (decimal lossless end-to-end); all 5 runtime-type assertions green; no port canonicalizes inside its runtime (grep each runtime for the canonicalization helpers — only the runners should have them).
- [ ] **Step 2 — Docs.** Update CLAUDE.md status (decimal runtime-native; Python reconciled to the contract).
- [ ] **Step 3 — Final review.** Simplifier + reviewer over the whole SP-D diff (focus: the 11-site Java switch audit didn't change DOUBLE/FLOAT behavior; Python ObjectManager genuinely returns native + the runner canonicalizes correctly incl. tz-aware-vs-naive; the SP-A workaround is gone; the per-port gates assert native, not string).
- [ ] **Step 4 — Finish.** Merge forward (integrate-before-merge — main is very active). Update memory.

## Self-review notes
- The decimal wire string MUST stay byte-identical (it's just produced from an exact BigDecimal/Decimal now instead of a 15-digit double) — the persistence corpus is the proof.
- The Java switch audit is the risk surface: a `case DECIMAL` must never alter the existing `case DOUBLE`/`FLOAT` path. Compile + test each module after editing.
- Python tz-aware-vs-naive datetime is how the runner distinguishes TIMESTAMPTZ from TIMESTAMP without OIDs (pg8000 returns tz-aware for TIMESTAMPTZ).
- TS decimal native return is `string` (no native decimal) — the gate expects `string`, documented why.
- Don't change `normalization.md` or any corpus `expect:`.

# R6 Plan 1 — Float Fidelity + Wire Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix `field.float` to emit Postgres `REAL` (it currently emits `DOUBLE PRECISION` in every port), and define + enforce a cross-port wire-normalization rule for `REAL`/`DOUBLE` result values so float persistence round-trips are byte-identical across all five ports.

**Architecture:** Each port carries a dialect-neutral `SqlType` model that both metadata→snapshot and db→snapshot produce, with `emit` rendering dialect SQL and `introspect` reversing it. Today float and double both collapse onto one `Real` variant that renders `DOUBLE PRECISION`. We add a distinct single-precision variant (`Real4`), route `field.float` to it, render `REAL`, and make introspection reverse `float4`/`real` → `Real4` and `float8`/`double precision` → `Real`. Separately, each port's persistence-conformance runner serializes result values to canonical JSON; we change the `REAL`/`DOUBLE` rule from raw JSON number to a plain-decimal string (reusing the existing NUMERIC strip-zeros path), and add a new persistence-conformance entity (`Measurement`) carrying float + double columns to exercise it. The shared conformance fixtures are the cross-port oracle.

**Tech Stack:** TypeScript (Bun, `migrate-ts`), C# (.NET 8, `MetaObjects.Codegen`), Python (`uv`, `metaobjects.migrate`), Java (`omdb` migrate engine, Maven), Kotlin (`codegen-kotlin` + Exposed). Postgres via Testcontainers.

**Spec:** `docs/superpowers/specs/2026-05-29-r6-rdb-fidelity-field-types-design.md` (Sections 1–2, plus the float slice of Section 5). This is backlog item **R6** in `docs/superpowers/specs/2026-05-29-conformance-hardening-review.md`.

**Cross-port rule:** Add metamodel/DDL strings as named constants where the port has them; never inline. Follow each port's existing `SqlType` shape exactly — do not restructure.

---

## File map

| Port | Source files touched | Conformance/runner files touched |
|---|---|---|
| Shared | — | `fixtures/persistence-conformance/normalization.md`, `fixtures/persistence-conformance/canonical/meta.fitness.json` (or a new `meta.measurement.json`), `fixtures/persistence-conformance/migrations/`, `fixtures/persistence-conformance/queries/`; `fixtures/conformance/field-{float,double,decimal}-*` |
| TypeScript | `migrate-ts/src/sql-type.ts`, `migrate-ts/src/expected-schema.ts`, `migrate-ts/src/emit/postgres.ts`, `migrate-ts/src/emit/sqlite.ts`, `migrate-ts/src/introspect/postgres.ts` | `integration-tests/src/normalization.ts` |
| C# | `MetaObjects.Codegen/Migrate/SqlType.cs`, `ExpectedSchema.cs`, `PostgresEmit.cs`, `PostgresIntrospect.cs` | `MetaObjects.IntegrationTests/Runner/Normalization.cs` |
| Python | `metaobjects/migrate/sql_type.py`, `expected_schema.py`, `postgres_emit.py` (no introspect module) | `tests/integration/normalization.py` |
| Java | `omdb/.../migrate/SqlType.java`, `ExpectedSchemaBuilder.java`, `driver/PostgresDriver.java`; `codegen-spring/.../SpringTypeMapper.java` | `integration-tests/.../Normalization.java` |
| Kotlin | `codegen-kotlin/.../KotlinTypeMapper.kt` | `integration-tests-kotlin/.../Normalization.kt` |

---

## Task 1: Define the float/double wire-normalization rule (docs)

**Files:**
- Modify: `fixtures/persistence-conformance/normalization.md:34` (the `REAL, DOUBLE` table row + rationale)

- [ ] **Step 1: Replace the `REAL, DOUBLE` table row**

In the per-type table, change the row:

```
| `REAL`, `DOUBLE`    | number                                    | `1.5`                                 |
```

to:

```
| `REAL`, `DOUBLE`    | **string** (plain decimal, no trailing zeros) | `"1.5"`, `"0.125"`, `"-3.25"`       |
```

- [ ] **Step 2: Add a rationale + fixture-authoring constraint block**

After the existing `### Rationale highlights` list, add:

```markdown
### Float/double serialization (REAL, DOUBLE)

`REAL`/`DOUBLE` serialize as a **plain-decimal string** with trailing zeros and a bare
trailing decimal point stripped — the **same** canonicalization as `NUMERIC`. They are NOT
raw JSON numbers: as JSON numbers, integer-valued floats diverge (`100.0` in Python/Java vs
`100` in JS/.NET), and driver-native shortest-float algorithms differ. Stringify removes both.

**Fixture-authoring constraint.** A `REAL`/`DOUBLE` value used in a scenario MUST be:
- an **exact dyadic rational** (a terminating binary fraction — i.e. exactly representable
  in IEEE-754), and
- **non-integer** (carry a fractional part), and
- within the plain-decimal band `|x| ∈ [0.001, 1 000 000)`; for a `REAL` column additionally
  ≤ 6 significant decimal digits (single-precision exactness).

This guarantees every language driver renders the identical minimal string. The non-integer
rule exists because the TS runner cannot see column type (it normalizes an already-mapped
row by value: `Number.isInteger(v) ? v : stringify(v)`); a fractional part makes that route
agree with the typed ports, which stringify every float.

- **Safe values:** `1.5`, `0.125`, `1234.5`, `-3.25`, `0.5`, `0.0625`, `12.75`.
- **Forbidden:** `0.1`/`3.14`/π (non-dyadic → JS/Python widened-double tail on `REAL`);
  `0.0009765625` (dyadic but `< 1e-3` → Java `E`-notation); `12345678` (`≥ 1e7`); `100`/`-42`
  (integer-valued → TS keeps a JSON number, diverging from the typed ports).

**Worked example.** A `field.float` column storing `1.5`: every port serializes `"1.5"`. A
`field.double` column storing `0.125`: every port serializes `"0.125"`.
```

- [ ] **Step 3: Commit**

```bash
git add fixtures/persistence-conformance/normalization.md
git commit -m "docs(persistence-conformance): R6 — define REAL/DOUBLE wire-normalization rule

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Loader conformance fixtures for float/double/decimal

These lock the existing `field.float`/`double`/`decimal` subtypes' canonical serialization
(today they have **zero** loader-corpus coverage). They are pure loader round-trips — the
subtypes already exist in every port, so they should pass immediately on all four
loader-bearing ports.

**Files:**
- Create: `fixtures/conformance/field-double-basic/input/meta.measure.json`
- Create: `fixtures/conformance/field-double-basic/expected.json`
- Create: `fixtures/conformance/field-float-basic/input/meta.measure.json`
- Create: `fixtures/conformance/field-float-basic/expected.json`
- Create: `fixtures/conformance/field-decimal-precision/input/meta.measure.json`
- Create: `fixtures/conformance/field-decimal-precision/expected.json`
- Create: `fixtures/conformance/field-double-array/input/meta.measure.json`
- Create: `fixtures/conformance/field-double-array/expected.json`

- [ ] **Step 1: Write `field-double-basic` (failing — fixture not yet discovered)**

`fixtures/conformance/field-double-basic/input/meta.measure.json`:

```json
{
  "metadata.root": {
    "package": "acme",
    "children": [
      {
        "object.entity": {
          "name": "Reading",
          "children": [
            { "field.long": { "name": "id" } },
            { "field.double": { "name": "amount" } },
            { "identity.primary": { "@fields": "id" } }
          ]
        }
      }
    ]
  }
}
```

`fixtures/conformance/field-double-basic/expected.json`:

```json
{
  "metadata.root": {
    "package": "acme",
    "children": [
      {
        "object.entity": {
          "name": "Reading",
          "children": [
            { "field.long": { "name": "id" } },
            { "field.double": { "name": "amount" } },
            { "identity.primary": { "@fields": ["id"] } }
          ]
        }
      }
    ]
  }
}
```

- [ ] **Step 2: Write `field-float-basic`**

`input/meta.measure.json` — identical to Step 1 but `"field.float"` for `amount`.
`expected.json` — identical to Step 1 but `"field.float"` for `amount`.

- [ ] **Step 3: Write `field-decimal-precision`**

`input/meta.measure.json` `amount` field: `{ "field.decimal": { "name": "amount", "@precision": 12, "@scale": 2 } }`.
`expected.json` `amount` field (note `@`-attrs alphabetical — `@precision` before `@scale`):

```json
            { "field.decimal": { "name": "amount", "@precision": 12, "@scale": 2 } },
```

- [ ] **Step 4: Write `field-double-array`**

`input/meta.measure.json` `amount` field: `{ "field.double": { "name": "amounts", "isArray": true } }`.
`expected.json` `amounts` field: `{ "field.double": { "name": "amounts", "isArray": true } }`.

- [ ] **Step 5: Run the TS conformance runner — verify all four pass**

Run: `cd server/typescript && bun test packages/metadata/test/conformance.test.ts -t "field-double-basic"`
Expected: PASS. Repeat `-t` for `field-float-basic`, `field-decimal-precision`, `field-double-array`.
If a canonical-shape mismatch appears (e.g. attr ordering), adjust `expected.json` to the actual canonical output — the loader's behavior is the oracle.

- [ ] **Step 6: Run the other three loader ports**

```bash
cd server/java && mvn -q -pl metadata test -Dtest=ConformanceTest
cd server/python && uv run --extra dev pytest tests -k conformance
# C#:
dotnet test server/csharp/MetaObjects.Conformance.Tests
```
Expected: all four new fixtures green in every port (no skip-ledger entries).

- [ ] **Step 7: Commit**

```bash
git add fixtures/conformance/field-double-basic fixtures/conformance/field-float-basic fixtures/conformance/field-decimal-precision fixtures/conformance/field-double-array
git commit -m "test(conformance): R6 — loader fixtures for field.float/double/decimal

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: TypeScript — `field.float` → REAL + float/double normalization

**Files:**
- Modify: `server/typescript/packages/migrate-ts/src/sql-type.ts:8-18` (add `real4` variant) and `:34-41`, `:82-89` (handle it in equality/widening)
- Modify: `server/typescript/packages/migrate-ts/src/expected-schema.ts:383-385` (route `field.float`)
- Modify: `server/typescript/packages/migrate-ts/src/emit/postgres.ts:145-162` (`real4` → `REAL`)
- Modify: `server/typescript/packages/migrate-ts/src/emit/sqlite.ts:272-284` (`real4` → `REAL`)
- Modify: `server/typescript/packages/migrate-ts/src/introspect/postgres.ts:107-108` (split float4 vs float8)
- Modify: `server/typescript/packages/integration-tests/src/normalization.ts:20-61` (stringify non-integer numbers)

- [ ] **Step 1: Add the `real4` variant to `SqlType`**

In `sql-type.ts`, change the union (line 11) so the single-precision variant is distinct:

```typescript
  | { kind: "real" }       // DOUBLE PRECISION (float8) — field.double
  | { kind: "real4" }      // REAL (float4, single precision) — field.float
```

In `sqlTypeEquals` add `"real4"` to the no-payload group (line 34-40 list):

```typescript
    case "real":
    case "real4":
    case "boolean":
```

In `isWidening` add `"real4"` to the same no-payload group (line 82-89 list):

```typescript
    case "real":
    case "real4":
    case "boolean":
```

- [ ] **Step 2: Route `field.float` to `real4` in expected-schema**

In `expected-schema.ts`, split lines 383-385:

```typescript
    case FIELD_SUBTYPE_DOUBLE:    return { kind: "real" };
    case FIELD_SUBTYPE_FLOAT:     return { kind: "real4" };
    case FIELD_SUBTYPE_DECIMAL:   return { kind: "numeric" };
```

- [ ] **Step 3: Render `real4` → REAL in Postgres emit**

In `emit/postgres.ts` `pgType` (after the `case "real":` at line 149):

```typescript
    case "real":      return "DOUBLE PRECISION";
    case "real4":     return "REAL";
```

- [ ] **Step 4: Render `real4` → REAL in SQLite emit**

In `emit/sqlite.ts` `sqliteType` (after `case "real": return "REAL";` at line 278):

```typescript
    case "real":      return "REAL";
    case "real4":     return "REAL";
```

(SQLite has a single float storage class; both collapse to `REAL` — documented as Postgres-only distinction.)

- [ ] **Step 5: Split float4 vs float8 in introspection**

In `introspect/postgres.ts`, replace the two floating-point lines (107-108):

```typescript
  // Floating-point: float4/real is single precision; float8/double precision is double.
  if (dt === "float4" || dt === "real") return { kind: "real4" };
  if (dt === "float8" || dt === "double precision") return { kind: "real" };
```

- [ ] **Step 6: Run the migrate-ts unit/snapshot suite — fix snapshots**

Run: `cd server/typescript && bun test packages/migrate-ts`
Expected: any snapshot that asserted `DOUBLE PRECISION` for a `field.float` column now asserts `REAL`. Update those snapshots to `REAL`. A round-trip (emit→introspect→diff) test must show **no** change for a float column (introspection now reverses `REAL` → `real4`, matching expected-schema). Confirm zero phantom diffs.

- [ ] **Step 7: Change the normalization rule for non-integer numbers**

In `integration-tests/src/normalization.ts`, replace the number branch (line 23, `if (typeof v === "number") return v;`) with:

```typescript
  // INTEGER/SMALLINT come back as integer-valued JS numbers → keep as JSON number.
  // REAL/DOUBLE come back as non-integer JS numbers → stringify (plain decimal, strip zeros).
  // (The runner sees an already-mapped row with no column-type metadata; fixtures pin
  // float/double values to be non-integer so this value-route is exact — see normalization.md.)
  if (typeof v === "number") return Number.isInteger(v) ? v : canonicalFloat(v);
```

Add the helper next to `canonicalDecimal` (after line 61):

```typescript
function canonicalFloat(n: number): string {
  // In-band dyadic values (per normalization.md) render plain + shortest via String().
  let out = String(n);
  if (out.includes(".")) {
    out = out.replace(/0+$/, "");
    if (out.endsWith(".")) out = out.slice(0, -1);
  }
  return out;
}
```

- [ ] **Step 8: Commit**

```bash
git add server/typescript/packages/migrate-ts server/typescript/packages/integration-tests/src/normalization.ts
git commit -m "feat(migrate-ts): R6 — field.float emits REAL; stringify REAL/DOUBLE on the wire

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: C# — `field.float` → REAL + float/double normalization

**Files:**
- Modify: `server/csharp/MetaObjects.Codegen/Migrate/SqlType.cs:18-29` (add `Real4`)
- Modify: `server/csharp/MetaObjects.Codegen/Migrate/ExpectedSchema.cs:138-144` (route float)
- Modify: `server/csharp/MetaObjects.Codegen/Migrate/PostgresEmit.cs:113-129` (`Real4` → `REAL`)
- Modify: `server/csharp/MetaObjects.Codegen/Migrate/PostgresIntrospect.cs:78-106` (split)
- Modify: `server/csharp/MetaObjects.IntegrationTests/Runner/Normalization.cs:30-72` (stringify float/double)

- [ ] **Step 1: Add `Real4` to the SqlType record**

In `SqlType.cs`, after `public sealed record Real : SqlType;` (line 22):

```csharp
    public sealed record Real : SqlType;     // DOUBLE PRECISION (float8) — field.double
    public sealed record Real4 : SqlType;    // REAL (float4) — field.float
```

- [ ] **Step 2: Route `field.float` to `Real4`**

In `ExpectedSchema.cs`, split line 143:

```csharp
        FIELD_SUBTYPE_DOUBLE => new SqlType.Real(),
        FIELD_SUBTYPE_FLOAT => new SqlType.Real4(),
        FIELD_SUBTYPE_DECIMAL => new SqlType.Numeric(f.Precision, f.Scale),
```

- [ ] **Step 3: Render `Real4` → REAL**

In `PostgresEmit.cs` `PgType` (after `SqlType.Real => "DOUBLE PRECISION",` at line 117):

```csharp
        SqlType.Real => "DOUBLE PRECISION",
        SqlType.Real4 => "REAL",
```

- [ ] **Step 4: Split introspection**

In `PostgresIntrospect.cs`, replace line 94:

```csharp
        if (dt is "float4" or "real") return new SqlType.Real4();
        if (dt is "float8" or "double precision") return new SqlType.Real();
```

- [ ] **Step 5: Run the C# migrate tests — fix snapshots**

Run: `dotnet test server/csharp/MetaObjects.Codegen.Tests` (or the project housing the migrate tests).
Expected: `field.float` snapshots flip `DOUBLE PRECISION` → `REAL`; update them. Round-trip shows no phantom diff.

- [ ] **Step 6: Stringify float/double in the runner**

In `Normalization.cs`, replace the two floating lines (37-38):

```csharp
        // REAL/DOUBLE → canonical plain-decimal string (format from the native type).
        float f => CanonicalFloat(((double)f)),
        double d => CanonicalFloat(d),
```

Add a helper next to `CanonicalDecimal` (after line 72):

```csharp
    private static string CanonicalFloat(double d)
    {
        var s = d.ToString(CultureInfo.InvariantCulture);
        if (!s.Contains('.')) return s;
        s = s.TrimEnd('0');
        if (s.EndsWith('.')) s = s[..^1];
        return s;
    }
```

(`float f` widens to `double` only after the single value is already exact for in-band dyadic fixtures; the fixture constraint guarantees no tail.)

- [ ] **Step 7: Commit**

```bash
git add server/csharp/MetaObjects.Codegen/Migrate server/csharp/MetaObjects.IntegrationTests/Runner/Normalization.cs
git commit -m "feat(csharp-migrate): R6 — field.float emits REAL; stringify REAL/DOUBLE on the wire

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Python — `field.float` → REAL + float/double normalization

**Files:**
- Modify: `server/python/src/metaobjects/migrate/sql_type.py:22-31` (add `Real4`)
- Modify: `server/python/src/metaobjects/migrate/expected_schema.py:119-122` (route float)
- Modify: `server/python/src/metaobjects/migrate/postgres_emit.py:121-140` (`Real4` → `REAL`)
- Modify: `server/python/tests/integration/normalization.py:22-83` (stringify float)

- [ ] **Step 1: Add the `Real4` dataclass**

In `sql_type.py`, after the `Real` class (line 24):

```python
@dataclass(frozen=True)
class Real4:
    kind: Literal["real4"] = field(default="real4", init=False)
```

Add `Real4` to the `SqlType` union alias in that file (wherever `Real` appears in the `SqlType = ... | Real | ...` union).

- [ ] **Step 2: Route `field.float` to `Real4`**

In `expected_schema.py`, split lines 119-122:

```python
    if st == fc.FIELD_SUBTYPE_DOUBLE:
        return Real()
    if st == fc.FIELD_SUBTYPE_FLOAT:
        return Real4()
    if st == fc.FIELD_SUBTYPE_DECIMAL:
        return Numeric()
```

Add `Real4` to the imports at the top of `expected_schema.py`.

- [ ] **Step 3: Render `Real4` → REAL**

In `postgres_emit.py` `_pg_type` (after the `Real` branch at line 126-127):

```python
    if isinstance(t, Real):
        return "DOUBLE PRECISION"
    if isinstance(t, Real4):
        return "REAL"
```

Add `Real4` to the imports.

- [ ] **Step 4: Run the Python migrate tests — fix expectations**

Run: `cd server/python && uv run --extra dev pytest tests -k migrate`
Expected: `field.float` expectations flip to `REAL`; update them. (Python has no introspect module, so no round-trip to fix.)

- [ ] **Step 5: Stringify float in the runner**

In `tests/integration/normalization.py`, replace the float branch (lines 34-35, `if isinstance(v, float): return v`):

```python
    if isinstance(v, float):
        return _canonical_float(v)
```

Add the helper after `_canonical_decimal` (after line 83):

```python
def _canonical_float(x: float) -> str:
    # In-band dyadic values (per normalization.md) render plain + shortest via repr().
    s = repr(x)
    if "." in s:
        s = s.rstrip("0").rstrip(".")
    return s
```

- [ ] **Step 6: Commit**

```bash
git add server/python/src/metaobjects/migrate server/python/tests/integration/normalization.py
git commit -m "feat(python-migrate): R6 — field.float emits REAL; stringify REAL/DOUBLE on the wire

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Java — `field.float` → REAL (omdb) + normalization + Spring DTO arm

**Files:**
- Modify: `server/java/omdb/src/main/java/com/metaobjects/manager/db/migrate/SqlType.java:11-35` (add `Real4`)
- Modify: `server/java/omdb/src/main/java/com/metaobjects/manager/db/migrate/ExpectedSchemaBuilder.java` (route float — find the float/double branch)
- Modify: `server/java/omdb/src/main/java/com/metaobjects/manager/db/driver/PostgresDriver.java` (emit `Real4` → `REAL`; introspect split — find the type-mapping methods)
- Modify: `server/java/codegen-spring/src/main/java/com/metaobjects/generator/spring/SpringTypeMapper.java:63-76` (add `FloatField`/`DecimalField` arms)
- Modify: `server/java/integration-tests/src/test/java/com/metaobjects/integration/Normalization.java:43-81` (stringify float/double)

- [ ] **Step 1: Add `Real4` to the sealed SqlType**

In `SqlType.java`, add to the `permits` list (line 12-13) and add the record (after line 21):

```java
        permits SqlType.Text, SqlType.Int, SqlType.Real, SqlType.Real4, SqlType.Numeric, SqlType.Bool,
                SqlType.Timestamp, SqlType.Date, SqlType.Json, SqlType.Blob, SqlType.Uuid {
```
```java
    record Real() implements SqlType {}

    /** REAL (float4, single precision) — field.float. */
    record Real4() implements SqlType {}
```

(`isWidening`'s final `return false` already covers `Real4` — any same-kind difference is non-widening; no edit needed there.)

- [ ] **Step 2: Route `field.float` to `Real4` in ExpectedSchemaBuilder**

Read `ExpectedSchemaBuilder.java`, find the branch mapping `DoubleField`/`FloatField` to `SqlType.Real`. Split it so `FloatField` (subtype `"float"`) → `new SqlType.Real4()` while `DoubleField` → `new SqlType.Real()`. Mirror the TS/C# split exactly.

- [ ] **Step 3: Emit + introspect `Real4` in PostgresDriver**

Read `PostgresDriver.java`, find the `SqlType` → SQL-string method (renders `Real` → `"DOUBLE PRECISION"`) and the introspection method (maps `float4`/`float8`/`real`/`double precision` → `SqlType`). Add:
- emit: `case Real4 -> "REAL";` (or `if (t instanceof SqlType.Real4) return "REAL";` matching the file's style).
- introspect: `float4`/`real` → `new SqlType.Real4()`; `float8`/`double precision` → `new SqlType.Real()`.

- [ ] **Step 4: Add `FloatField`/`DecimalField` arms to SpringTypeMapper**

In `SpringTypeMapper.java`, after line 67 (`if (field instanceof DoubleField) return "Double";`):

```java
        if (field instanceof DoubleField) return "Double";
        if (field instanceof FloatField) return "Float";
        if (field instanceof DecimalField) return "java.math.BigDecimal";
```

Add the imports `com.metaobjects.field.FloatField` and `com.metaobjects.field.DecimalField`.

- [ ] **Step 5: Stringify float/double in the runner**

In `Normalization.java`, replace the two floating lines (50-51):

```java
        if (v instanceof Float f)  return canonicalFloat(f);
        if (v instanceof Double d) return canonicalFloat(d);
```

Add two overloads next to `canonicalDecimal` (after line 81):

```java
    /** REAL → canonical plain-decimal string, formatted from the single (no widening tail). */
    private static String canonicalFloat(float f) { return stripZeros(Float.toString(f)); }
    /** DOUBLE → canonical plain-decimal string. */
    private static String canonicalFloat(double d) { return stripZeros(Double.toString(d)); }
    private static String stripZeros(String s) {
        if (!s.contains(".")) return s;
        s = s.replaceAll("0+$", "");
        if (s.endsWith(".")) s = s.substring(0, s.length() - 1);
        return s;
    }
```

(In-band fixture values never trigger `Double.toString`/`Float.toString` exponential notation — see normalization.md.)

- [ ] **Step 6: Build + test the touched Java modules**

```bash
cd server/java && mvn -q -pl omdb,codegen-spring -am test
```
Expected: PASS. Fix any `field.float` DDL snapshot/expectation in omdb to `REAL`.

- [ ] **Step 7: Commit**

```bash
git add server/java/omdb server/java/codegen-spring/src/main/java/com/metaobjects/generator/spring/SpringTypeMapper.java server/java/integration-tests/src/test/java/com/metaobjects/integration/Normalization.java
git commit -m "feat(java-omdb): R6 — field.float emits REAL; stringify REAL/DOUBLE on the wire

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Kotlin — add `field.float` support + float/double normalization

Kotlin's `KotlinTypeMapper` has **no** `FloatField` arm today — a `field.float` throws
"unsupported". This task adds float support (mapping it to `REAL`/Kotlin `Float`) and
stringifies float/double in the runner.

**Files:**
- Modify: `server/java/codegen-kotlin/src/main/kotlin/com/metaobjects/generator/kotlin/KotlinTypeMapper.kt:127-149` (kotlinTypeName) and `:199-251` (exposedColumnSpec)
- Modify: `server/java/integration-tests-kotlin/src/test/kotlin/com/metaobjects/integration/kotlin/Normalization.kt:34-65` (stringify float/double)

- [ ] **Step 1: Add the `FloatField` import**

At the top of `KotlinTypeMapper.kt`, add:

```kotlin
import com.metaobjects.field.FloatField
```

- [ ] **Step 2: Add a `FloatField` arm to `kotlinTypeName`**

In `kotlinTypeName` (after `is DoubleField -> DOUBLE` at line 131):

```kotlin
        is DoubleField    -> DOUBLE
        is FloatField     -> FLOAT
```

(`FLOAT` is KotlinPoet's `com.squareup.kotlinpoet.FLOAT`; confirm it is imported alongside `DOUBLE`/`LONG`/`INT` — add it to that import group if absent.)

- [ ] **Step 3: Add a `FloatField` arm to `exposedColumnSpec`**

In `exposedColumnSpec` (after `is DoubleField -> "double(\"$colName\")"` at line 228):

```kotlin
        is DoubleField    -> "double(\"$colName\")"
        is FloatField     -> "float(\"$colName\")"
```

(Exposed's `float(name)` maps to Postgres `REAL`; `double(name)` maps to `DOUBLE PRECISION`.)

- [ ] **Step 4: Stringify float/double in the runner**

In `Normalization.kt`, replace the two floating lines (41-42):

```kotlin
        is Float -> canonicalFloat(v)
        is Double -> canonicalFloat(v)
```

Add overloads next to `canonicalDecimal` (after line 65):

```kotlin
    /** REAL → canonical plain-decimal string, from the single (no widening tail). */
    private fun canonicalFloat(f: Float): String = stripZeros(f.toString())
    /** DOUBLE → canonical plain-decimal string. */
    private fun canonicalFloat(d: Double): String = stripZeros(d.toString())
    private fun stripZeros(s: String): String {
        if (!s.contains(".")) return s
        var out = s.trimEnd('0')
        if (out.endsWith(".")) out = out.dropLast(1)
        return out
    }
```

- [ ] **Step 5: Build + test codegen-kotlin**

```bash
cd server/java && mvn -q -pl codegen-kotlin -am test
```
Expected: PASS, including any existing test that now exercises a `FloatField` arm.

- [ ] **Step 6: Commit**

```bash
git add server/java/codegen-kotlin/src/main/kotlin/com/metaobjects/generator/kotlin/KotlinTypeMapper.kt server/java/integration-tests-kotlin/src/test/kotlin/com/metaobjects/integration/kotlin/Normalization.kt
git commit -m "feat(codegen-kotlin): R6 — field.float maps to REAL; stringify REAL/DOUBLE on the wire

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Persistence-conformance `Measurement` entity (float + double round-trip)

The end-to-end cross-port test. Adds a new entity to the persistence corpus — **not** bolted
onto `Program` (which would churn every existing scenario's expected rows). Plan 2 later
extends this same entity with uuid/timestamptz/jsonb columns.

**Files:**
- Modify: `fixtures/persistence-conformance/canonical/meta.fitness.json` (add a `Measurement` entity)
- Create: `fixtures/persistence-conformance/queries/measurement-floats.yaml`
- Modify: the per-port bootstrap migration metadata snapshot, if the corpus stores one (e.g. `migrations/states/*/meta.json`) — see Step 3.

- [ ] **Step 1: Add the `Measurement` entity to the canonical metadata**

In `meta.fitness.json`, add a fourth `object.entity` child after `Week` (before the view
entities), using only non-integer dyadic in-band float/double values downstream:

```json
      { "object.entity": {
        "name": "Measurement",
        "children": [
          { "source.rdb": { "@table": "measurements" } },
          { "field.long":   { "name": "id" } },
          { "field.float":  { "name": "tempC" } },
          { "field.double": { "name": "massKg" } },
          { "identity.primary": { "@fields": "id", "@generation": "increment" } }
        ]
      }},
```

- [ ] **Step 2: Write the float round-trip query scenario**

`fixtures/persistence-conformance/queries/measurement-floats.yaml`:

```yaml
name: measurement-floats
description: REAL and DOUBLE PRECISION round-trip as plain-decimal strings (no trailing zeros).
seed-data: |
  INSERT INTO "measurements" ("id", "tempC", "massKg") VALUES
    (1, 1.5, 0.125),
    (2, -3.25, 1234.5);
queries:
  - name: get-measurement-1
    op: get
    entity: Measurement
    by: { id: 1 }
    expect: { id: "1", tempC: "1.5", massKg: "0.125" }

  - name: list-measurements-sorted
    op: list
    entity: Measurement
    sort: { id: asc }
    expect:
      - { id: "1", tempC: "1.5", massKg: "0.125" }
      - { id: "2", tempC: "-3.25", massKg: "1234.5" }
```

- [ ] **Step 3: Wire the entity into each port's bootstrap, if the corpus pins migration state**

If `migrations/states/program-v*/meta.json` snapshots are the source the bootstrap migration
builds from, add the `Measurement` entity to the latest snapshot so the table is created.
Otherwise (if the bootstrap derives the schema from `canonical/meta.fitness.json` directly),
no change is needed. Inspect `fixtures/persistence-conformance/migrations/bootstrap-canonical-from-empty.yaml`
to confirm which, and update accordingly so `CREATE TABLE measurements (...)` is emitted with
`tempC REAL` and `massKg DOUBLE PRECISION`.

- [ ] **Step 4: Run the persistence-conformance suite across all five ports (Docker)**

Run: `scripts/integration-test.sh` (Docker must be running).
Expected: every port creates `measurements` with `tempC REAL`, `massKg DOUBLE PRECISION`, and
the `measurement-floats` scenario returns `tempC: "1.5"`, `massKg: "0.125"` etc. — byte-identical
across TS, C#, Java, Python, Kotlin. If a port diverges, the diff names the row/field; fix that
port's normalization or emit.

- [ ] **Step 5: Commit**

```bash
git add fixtures/persistence-conformance
git commit -m "test(persistence-conformance): R6 — Measurement entity exercises REAL/DOUBLE round-trip

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Review, simplify, and mark R6-float resolved

- [ ] **Step 1: Run `/code-review` on the branch diff; fix findings.**
- [ ] **Step 2: Run `/simplify` on the changed code; apply quality fixes.**
- [ ] **Step 3: Run the full affected suites once more** (TS `bun test`, Python pytest, `mvn -pl metadata,omdb,codegen-spring,codegen-kotlin -am test`, and `scripts/integration-test.sh`). Confirm green.
- [ ] **Step 4: Update the backlog + memory.** In `docs/superpowers/specs/2026-05-29-conformance-hardening-review.md`, mark the float half of R6 done with the commit ref. Update the `conformance-suite-gaps` memory note (float normalization rule + REAL fidelity now resolved; uuid + `@dbColumnType` tracked in Plan 2).
- [ ] **Step 5: Commit the doc/memory update; FF-merge the worktree to `main`; push.**

---

## Self-review notes

- **Spec coverage:** Section 1 (wire contract) → Task 1 + the normalization edits in Tasks 3–7 + the round-trip proof in Task 8. Section 2 (`field.float`→REAL) → Tasks 3–7 (SqlType variant + emit + introspect per port). Section 5 float slice → Tasks 2 (loader) + 8 (persistence). UUID/`@dbColumnType`/timestamptz/jsonb are **out of scope here** — Plan 2.
- **Type consistency:** the single-precision variant is named `real4`/`Real4` in every port; `field.double` stays on `real`/`Real`; introspection reverses `float4`/`real`→single and `float8`/`double precision`→double uniformly. Normalization helper is `canonicalFloat`/`_canonical_float` in every runner, formatting from the native single for `REAL` (Java/Kotlin/C#) and value-routing by `Number.isInteger` in TS.
- **Open verification points flagged inline (not placeholders):** Task 6 Steps 2–3 require reading `ExpectedSchemaBuilder.java`/`PostgresDriver.java` to find the exact float branch (Java omdb wasn't quoted line-for-line) — the *change* is fully specified (split float→Real4, double→Real, emit REAL, introspect split); Task 8 Step 3 requires confirming how the corpus bootstrap derives its schema. Both are "locate the spot, apply this specified edit" — not undefined work.

# R6 — RDB-Fidelity Field Types (float contract · `field.uuid` · `@dbColumnType`)

_Date: 2026-05-29. Status: **Approved — ready for implementation planning.**_

> This spec **re-layers** the deferred
> [`2026-05-29-rdb-fidelity-field-type-additions-design.md`](2026-05-29-rdb-fidelity-field-type-additions-design.md)
> against [ADR-0013](../../../spec/decisions/ADR-0013-logical-field-types-vs-physical-column-attributes.md).
> The deferred spec stays as the historical reference ADR-0013 critiques; **this** is the
> spec to implement. It is item **R6** in the conformance-hardening backlog
> ([`2026-05-29-conformance-hardening-review.md`](2026-05-29-conformance-hardening-review.md)).

## Why this exists

A real downstream consumer's relational schema needs floating-point columns, `uuid`
columns, timezone-aware timestamps, and opaque (genuinely-open) jsonb. Investigating that
need surfaced a deeper conformance gap (review finding #11): `field.float`/`double` map to
`DOUBLE PRECISION` in every port, but `fixtures/persistence-conformance/normalization.md`
serializes `REAL`/`DOUBLE` as a **raw JSON number** with no canonicalization rule — driver-
native double formatting differs across Node/Bun/.NET/Python/JVM, so the contract is
cross-port-divergent and **zero persistence rows return a float**. The `uuid` lowercase-
canonical rule (`normalization.md:39`) is likewise dead contract — no fixture uses a uuid.

R6 closes the float contract, fixes a standing float fidelity loss before fixtures lock it
in, adds the one genuinely-new logical type (`field.uuid`), promotes Kotlin's physical
`@dbColumnType` escape hatch to a cross-port attribute, and locks all of it with shared
fixtures.

## Governing constraints

- **ADR-0013 (logical vs physical):** a logical field subtype fixes a value's *semantic
  type + idiomatic native binding*; physical column-storage concerns live on a `dbProvider`-
  registered attribute (`@dbColumnType`), never on the logical field. `field.uuid` is
  logical; timezone-awareness and opaque-jsonb are physical (`@dbColumnType`).
- **ADR-0001 (cross-language type binding):** binding resolves at codegen time via static
  generated mappings, never runtime reflection.
- **ADR-0002 (open-closed typed nodes):** a new field subtype is one class + one
  registration line per port. C# is still central-dispatch (higher-touch — a known risk,
  not redesigned here).
- **ADR-0014 (loader-scoped registry):** unaffected — no change to registry resolution.
- **Constants discipline:** add subtype/attr names to TS constants first
  (`server/typescript/packages/metadata/src/core/field/field-constants.ts`), then the
  Java/Python/C#/Kotlin parallels. Never inline metamodel strings.
- **Conformance-first / TDD:** every addition lands as shared fixtures; tests precede
  implementation.

## Layering map

| Concern | Layer | Conformance gate |
|---|---|---|
| Float/double wire-normalization rule | wire contract | persistence-conformance |
| `field.float` → `REAL` fidelity fix | logical→physical DDL mapping | persistence-conformance |
| `field.uuid` subtype | **logical** (core metamodel) | metamodel (canonical) **+** persistence |
| `@dbColumnType` (`uuid`/`jsonb`/`timestamp_with_tz`) | **physical** (dbProvider attr) | metamodel (attr round-trip) **+** persistence (effect) |

---

## Section 1 — Float/double wire-normalization contract

### Decision

`REAL` and `DOUBLE PRECISION` result values serialize as a **plain-decimal string** with
trailing zeros (and a bare trailing decimal point) stripped — **identical** to the existing
`NUMERIC`/`DECIMAL` rule. They are no longer raw JSON numbers.

### Research basis (empirical, 5 runtimes: Bun/JSC, Node/V8, Python 3.10, Java 21, .NET 8)

Each runtime's shortest float formatter was measured against candidate values at single and
double precision, then run through a strip-trailing-zeros pass:

1. **Stringify is mandatory.** As *JSON numbers*, integer-valued floats diverge: Python and
   Java emit `100.0`; JS and .NET emit `100`. Stringify + strip-zeros canonicalizes to `100`
   uniformly, and reuses the strip-zeros code path every runner already has for `NUMERIC`.
2. **`DOUBLE PRECISION` is safe unconstrained (within the band below).** Shortest-round-trip
   + strip is byte-identical across all five runtimes for every value tested, including
   non-dyadic `0.1`, `3.14`, π (`3.141592653589793`), and `1/3` — because all five have a
   native float64 and a correct shortest formatter (Java's `Double.toString` is shortest as
   of JDK 19; the toolchain is Java 21).
3. **`REAL` has two divergences that the fixture-authoring constraint removes:**
   - *No native float32 in JS/Python.* For a non-dyadic value they render the widened-double
     tail (`0.1` → `0.10000000149011612`) while Java/.NET render shortest-single (`0.1`).
   - *Exponential notation.* Java is the most aggressive, switching to `E`-notation below
     `1e-3` and at/above `1e7` (dyadic `0.0009765625` → Java `9.765625E-4`, plain decimal
     elsewhere).

### The contract (added to `normalization.md`)

- **Serialization:** `REAL`/`DOUBLE` → decimal **string**, **plain (never exponential)
  notation**, trailing zeros and bare decimal point stripped (e.g. `1.5`, `100`, `-3.25`).
- **Fixture-authoring constraint:** `REAL`/`DOUBLE` test values MUST be **exact dyadic
  rationals** (terminating binary fraction) within the plain-decimal band
  `|x| ∈ {0} ∪ [0.001, 1 000 000)`; `REAL` values additionally ≤ 6 significant decimal
  digits (single-precision exactness). With this constraint the widened double **is** the
  short decimal, so all five ports agree under plain shortest formatting.
  - **Safe:** `1.5`, `0.125`, `1234.5`, `-3.25`, `100`, `0.5`, `0.0625`.
  - **Forbidden (with the reason):** `0.1`/`3.14`/π (non-dyadic → JS/Python tail on `REAL`);
    `0.0009765625` (dyadic but `< 1e-3` → Java `E`-notation); `12345678` (`≥ 1e7`).
- **Runner guard (recommended):** each port formats from the value *as returned by the
  driver for the column's SQL type* (a `REAL` formats from the native single where the
  language has one), forces plain decimal, then strips zeros — so an accidentally out-of-band
  value **fails loudly** on diff rather than silently diverging.

This activates the dead `UUID` and `TIMESTAMPTZ` rows as a side effect (Sections 3–4).

---

## Section 2 — `field.float` → `REAL` (fidelity fix)

### Decision

`field.float` emits **`REAL`** (single precision); `field.double` emits **`DOUBLE
PRECISION`**; `field.decimal` stays **`NUMERIC`**. Today all ports collapse float and double
onto a single internal "real" kind that emits `DOUBLE PRECISION` (TS `emit/postgres.ts:149`;
C# `ExpectedSchema.cs:143`; Python `postgres_emit.py:127`) — a silent fidelity loss this
fixes before fixtures cement it.

### Per-port work

- **TS:** introduce a distinct single-precision `SqlType` kind in `migrate-ts/src/sql-type.ts`;
  map `field.double` → double-precision kind and `field.float` → the new single kind in
  `expected-schema.ts`; emit `REAL` vs `DOUBLE PRECISION` in `emit/postgres.ts`; **round-trip
  the distinction in `introspect/postgres.ts`** so `meta migrate` sees no phantom
  `REAL`↔`DOUBLE PRECISION` diff. SQLite: both remain `REAL` (SQLite has one float type) —
  document that the float/double distinction is Postgres-only.
- **C#:** add a single-precision `SqlType` variant (peer of `SqlType.Real`/`Numeric`) in
  `MetaObjects.Codegen/Migrate`; route `field.float` to it in `ExpectedSchema.cs`; emit +
  introspect in `PostgresSchema.cs`.
- **Python:** add the single-precision SQL-type in `migrate/sql_type.py`; route in
  `migrate/expected_schema.py`; emit in `migrate/postgres_emit.py`; introspection round-trip.
- **Java (`codegen-spring`) + Kotlin (Exposed):** confirm/adjust the type mappers so
  `field.float` → `REAL`/Exposed `float()` and `field.double` → `DOUBLE PRECISION`/Exposed
  `double()`.

### Native binding

Java/C#/Kotlin bind a 4-byte float for `field.float`. TS (`number`) and Python (`float`)
have only a 64-bit float and read the `REAL` column losslessly **for in-band dyadic values**
(the Section 1 constraint guarantees this in fixtures).

### Risk

Existing port-local snapshot tests that asserted `DOUBLE PRECISION` for `field.float` will
change; update them as part of this section.

---

## Section 3 — `field.uuid` logical subtype

### Decision

Add `field.uuid` as a first-class logical field subtype (ADR-0002: one class + one
registration line per port). It is the only genuinely-new *type* in R6.

### Native + DDL binding (ADR-0001, static)

| Port | Native type | Postgres | SQLite |
|---|---|---|---|
| TypeScript | `string` | `uuid` | `text` |
| Java | `java.util.UUID` | `uuid` | `TEXT` |
| C# | `System.Guid` | `uuid` | `TEXT` |
| Python | `uuid.UUID` | `uuid` | `TEXT` |
| Kotlin | `java.util.UUID` | `uuid` (Exposed `uuid(...)`) | `TEXT` |

The DataType is **STRING-backed** (the value's canonical wire form is a string), mirroring
the `enum`/`currency` precedent. Persistence normalization is the already-pinned lowercase-
canonical form — this fixes C#'s `Guid` casing/brace-format never being caught (review
finding #12).

### Per-port touch-points

- **TS (reference, constants-first):** `field-constants.ts` (`FIELD_SUBTYPE_UUID` +
  `FIELD_SUBTYPES`), `meta-field.ts` (`FIELD_DATA_TYPE` STRING entry), `core-types.ts`
  registration; codegen `codegen-ts/src/column-mapper.ts` + `templates/inferred-types.ts`;
  DDL `migrate-ts` emit + `introspect/postgres.ts`.
- **Java:** `UuidField` class + `FieldTypesMetaDataProvider` registration; `SpringTypeMapper`.
- **Python:** `field_constants.py` + `meta_field.py` + `loader/validation_passes.py`;
  `migrate` emit.
- **C#:** `FieldConstants.cs` + (central-dispatch) `CoreTypes.cs`, `Loader/ValidationPasses.cs`,
  `EntityGenerator.cs`/`PostgresSchema.cs`/`ExpectedSchema.cs`. **Highest-touch port.**
- **Kotlin:** `KotlinTypeMapper.kt` — map `field.uuid` (the logical subtype) → `java.util.UUID`
  + Exposed `uuid(...)`, distinct from the legacy `@dbColumnType:uuid`-on-`string` path
  (which ADR-0013 notes yields `String`). Persistence wire form is identical (lowercase).

### Generation — out of scope for R6

Fixtures use **assigned** uuid values to exercise the wire form. PK generation stays on the
existing `@generation:uuid` identity path (ADR-0013 "one resolver"); the `@default:"uuid"`
non-PK token is deferred to a later item. R6 fixtures keep `field.long` PKs and add `uuid`
as a non-PK column.

---

## Section 4 — `@dbColumnType` physical attribute

### Decision

Promote Kotlin's existing `@dbColumnType` escape hatch (`KotlinTypeMapper.kt`) to a
**`dbProvider`-registered** field attribute in TS/Java/Python/C# (Kotlin already ships it).
It selects the **physical DB column type while leaving the logical field's native binding
untouched** (ADR-0013 rejects native-binding-suppressing raw passthrough).

### Value set + validation

Closed set **`{ uuid, jsonb, timestamp_with_tz }`** (parity with Kotlin's current tokens).
An unknown value → **`ERR_BAD_ATTR_VALUE`**. No raw-dialect-SQL passthrough in R6 (YAGNI;
ADR-0013 sanctions a bounded form, and the bounded set covers the consumer's need).

### Effect (persistence/codegen layer only)

| Attr value | Applies to | Physical column | Native binding | Wire normalization |
|---|---|---|---|---|
| `uuid` | `field.string` | PG `uuid` | unchanged (string) | lowercase canonical |
| `jsonb` | `field.string` | PG `jsonb` (opaque, raw JSON text) | unchanged (string) | JSONB sorted-keys |
| `timestamp_with_tz` | `field.timestamp` | PG `timestamptz` | unchanged | `…Z` (UTC) branch |

`uuid` here is the *physical* path for an existing string column; **structured** identity is
the logical `field.uuid` (Section 3). `jsonb` is the deliberately-narrow opaque escape hatch
(arbitrary third-party payloads); **typed** jsonb stays `field.object` + `@objectRef` +
`@storage: jsonb` (the preferred, drift-checked path — unchanged). `timestamp_with_tz`
drives the `TIMESTAMPTZ` normalization branch that has never been exercised at runtime
(review finding #16).

### Loader behavior

As an `@`-attr registered by the `dbProvider`, `@dbColumnType` round-trips through the
canonical serializer like `@column`/`@kind`. One loader fixture confirms the canonical
round-trip; the physical effect is exercised by persistence fixtures. Registration must be
active in the registry the persistence-corpus loader composes (verify during implementation
— the persistence fixtures already use `dbProvider` attrs such as `@table`/`@column`).

---

## Section 5 — Conformance fixtures

### Loader corpus (`fixtures/conformance/`)

Mirroring the `enum` precedent (happy + extends + array, plus negatives). Loader-behavior
only — canonical `expected.json` or FR5a-envelope `expected-errors.json`:

- `field-uuid-basic`, `field-uuid-extends` (abstract base + `extends`), `field-uuid-array`
- `field-double-basic`, `field-float-basic`, `field-decimal-precision`, `field-double-array`
  (cheap round-trips locking the existing subtypes — currently zero loader coverage)
- `attr-dbcolumntype-uuid`, `attr-dbcolumntype-jsonb`, `attr-dbcolumntype-timestamptz`
  (canonical attr round-trip)
- `error-field-dbcolumntype-bad-value` (`ERR_BAD_ATTR_VALUE` negative)

Register any new code in `fixtures/conformance/ERROR-CODES.json`; update `CAPABILITIES.json`.

### Persistence corpus (`fixtures/persistence-conformance/`)

A **new dedicated entity** — generically named (e.g. `Measurement`) — added to the corpus,
**not** bolted onto `Program`/`meta.fitness.json` (which would churn every existing
scenario's expected rows). It carries:

- `id` `field.long` PK (assigned),
- a `field.float` column and a `field.double` column (dyadic-band values),
- a `field.uuid` column (assigned, lowercase wire form),
- a `field.timestamp` + `@dbColumnType: timestamp_with_tz` column (the `…Z` branch),
- a `field.string` + `@dbColumnType: jsonb` opaque column (sorted-keys branch).

Plus a bootstrap migration and `get`/`list` query scenarios asserting each normalized wire
form. This doubles as the missing runtime "kitchen-sink" (review finding #16).

`normalization.md` updates: REAL/DOUBLE row → the Section 1 string rule with a worked example
and forbidden-values note; the existing UUID, TIMESTAMPTZ, and JSONB rows are now genuinely
exercised.

---

## Sequencing & verification

The implementation plan (writing-plans, next step) will stage roughly as:

1. **Float contract + `field.float`→`REAL`** (Sections 1–2) — wire rule + DDL/introspection,
   port by port; verify migrate sees no phantom diff.
2. **`field.uuid` logical subtype** (Section 3) — TS-first, then the four ports; loader
   fixtures green before persistence.
3. **`@dbColumnType` physical attr** (Section 4) — dbProvider registration + persistence
   effect; reconcile Kotlin to the canonical name.
4. **Fixtures** (Section 5) — loader corpus then the persistence `Measurement` entity; run
   the Docker persistence + api-contract suites across all five ports.

Stages 1–2 may be one plan doc and 3–4 a second if the combined plan is unwieldy.

Per-stage commands (verify before claiming done):

```
TS:        cd server/typescript && bun test
Python:    cd server/python && uv run --extra dev pytest
Java meta: cd server/java && mvn -q -pl metadata test
Java mod:  cd server/java && mvn -q -pl <module> -am test
Kotlin:    mvn -f server/java/integration-tests-kotlin/pom.xml test
Persist./API (Docker): scripts/integration-test.sh
```

After each unit: `/code-review` + `/simplify`, fix findings, then mark R6 resolved in the
hardening-review backlog and the `conformance-suite-gaps` memory with the commit ref.

## Out of scope (YAGNI)

- `@default:"uuid"` non-PK token and any change to the `@generation:uuid` PK path.
- Raw-dialect-SQL `@dbColumnType` passthrough beyond the three named values.
- New numeric types beyond the existing `double`/`float`/`decimal`.
- Native Postgres `enum`, int-backed enums (separate deferred work).
- Migrating C# off central-dispatch (tracked separately; R6 accepts the higher C# touch).

## Risks & open questions

1. **C# central-dispatch (ADR-0002 not yet realized in C#)** — `field.uuid` touches more C#
   files; risk to effort, not correctness (the open-closed proof test guards the other ports).
2. **Introspection round-trip for `REAL` vs `DOUBLE PRECISION`** — must be exact or `meta
   migrate` shows a phantom diff. Confirm each port's introspector distinguishes `float4`
   from `float8`.
3. **SQLite float/uuid** — SQLite collapses float/double to one `REAL` and stores uuid as
   `TEXT`; document the Postgres-only distinction; confirm introspection round-trips it.
4. **`@dbColumnType` registry visibility** — confirm the attribute is registered in whatever
   registry the persistence-corpus loader composes, so fixtures load without
   `ERR_UNKNOWN_ATTR`.
5. **Kotlin dual uuid paths** — logical `field.uuid` (→`UUID`) and legacy
   `@dbColumnType:uuid`-on-`string` (→`String`) coexist; both normalize to the same lowercase
   wire form, but the binding differs. Documented intentionally; revisit only if it confuses.

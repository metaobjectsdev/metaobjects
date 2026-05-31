# Normalization-conformance + projection coverage (Phase B) — design

_Date: 2026-05-31. Status: **Design — pending user review.**_

> Part of the conformance-suite hardening (A/B/C). **A** (CI wiring) shipped (`db6440ff`). This is **B**.
> Grounds: `spec/conformance-tests.md`, `docs/superpowers/specs/2026-05-29-conformance-hardening-review.md`
> (items **R6** float/uuid contract, **R10** vocabulary holes), and a 2026-05-31 audit of the
> corpus×port×CI matrix. **C** (FR-007 semantic codegen-conformance) is a separate later design.

## Problem

Two gaps let ports drift silently despite "all green":

1. **Wire-normalization is only partially gated by shared scenarios.** `normalization.md` pins the
   canonical wire form for every type, but only **float/double, uuid, jsonb** are enforced by shared
   round-trip scenarios. **timestamp (no-tz), timestamptz, date, time** are *not* — each port hand-writes
   its own normalization unit tests, and their case sets already diverge (TS ~9, Java 4, Python 3).
   The **timestamptz `Z`-suffix** is an explicit documented hazard: `asset-uuid-roundtrip.yaml` today
   deliberately seeds a midnight-aligned value and returns `recordedAt` *without* `Z`, with a comment
   calling timezone "the documented normalization hazard" left unasserted.

2. **Projection coverage holes.** `ProgramStat` (an aggregate projection over `v_program_stat`) is
   round-tripped on all 5 ports for the **`count`** aggregate + a passthrough field. But: (a) the pure
   passthrough view `ProgramView`/`v_program` is declared in metadata and its DDL is generated into
   `canonical/schema.postgres.sql`, yet **no query scenario ever reads it** — the pure-passthrough
   runtime read path is unexercised; (b) only **`count`** of the five aggregates is covered —
   **`sum`/`avg`/`min`/`max`** have zero coverage.

## Decision

Close both via the **existing persistence-conformance round-trip mechanism** (no new corpus type):
seed known values → read back through each port's runtime → assert the **canonical normalized** output,
identically across all 5 ports. The corpus entities' DDL flows through the TS-produced
`canonical/schema.postgres.sql` (so the headless `schema-artifact.test.ts` drift-check picks up new
columns automatically). The divergent per-port normalization **unit tests** are **retired** — their
coverage is subsumed by the shared round-trip. (Each port keeps its normalization *helper*; it is what
the runner uses to canonicalize a read row.)

Gated in the integration suite (all 5 ports, Testcontainers Postgres) — which now runs on **all PRs +
pushes to main** after Phase A.

**Reuse over new entities:** the existing `Asset` entity already carries `uuid` (PK + plain),
`@dbColumnType:jsonb`, and `@dbColumnType:timestamp_with_tz` columns; `Measurement` carries
`field.float`/`field.double`. B **extends those** rather than adding a new kitchen-sink entity.

## Part 1 — Wire-type normalization

**Extend `Asset`** (in `fixtures/persistence-conformance/canonical/meta.fitness.json`) with the missing
temporal columns; all use **existing** field vocabulary (no new subtypes):

| Wire type | Metamodel (on Asset unless noted) | Canonical wire rule (pinned in `normalization.md`) |
|---|---|---|
| uuid | `field.uuid` (already) | lowercase-canonical *(already pinned + tested)* |
| float / double | `field.float`/`field.double` on `Measurement` (already) | shortest round-trippable plain decimal *(already pinned + tested)* |
| jsonb | `field.string` `@dbColumnType:jsonb` (already) | key-sorted JSON *(already pinned + tested)* |
| **timestamptz** | `field.timestamp` `@dbColumnType:timestamp_with_tz` (already, `recordedAt`) | **normalize to UTC, ISO-8601 with `Z`** (e.g. `2026-05-31T14:30:00Z`) — **resolves the hazard** |
| timestamp (no tz) | **new** `field.timestamp` (`observedAt`) | ISO-8601, **no** offset/`Z` (e.g. `2026-05-31T14:30:00`) |
| date | **new** `field.date` (`asOfDate`) | `YYYY-MM-DD` |
| time | **new** `field.time` (`atTime`) | `HH:MM:SS` (no fractional component; see below) |

**Canonical-rule decisions (pinned in `normalization.md`):**
- **Sub-second precision:** to avoid driver/decimal-truncation drift across Node/.NET/JVM/Python, the
  corpus **seeds whole-second values only** for `timestamp`/`timestamptz`/`time`, and the canonical
  form carries **no fractional-seconds component**. (Fractional-second normalization is explicitly
  out of scope for B — it is the genuinely driver-divergent part and would need its own pinned
  truncation rule + worked example.)
- **timestamptz:** the seeded value uses a **non-UTC offset** (e.g. `2026-05-31T09:30:00-05:00`) and
  the asserted read is the UTC `Z` form (`2026-05-31T14:30:00Z`) — this is what proves UTC-normalization,
  not just format. Replaces the current midnight-aligned no-`Z` hazard seed.
- **timestamp (no tz):** stored/read as a wall-clock ISO string with no offset.
- **date / time:** `YYYY-MM-DD` / `HH:MM:SS`.

**Edge cases seeded** (one Asset row per case, or columns on a few rows): the non-UTC-offset
timestamptz; a date; a whole-second time; midnight (`00:00:00`) to catch a port that drops a
zero time or renders `Z` inconsistently.

**Per-port work:** each port's persistence-conformance read path must canonicalize the new temporal
columns to the pinned forms via its normalization helper. The **timestamptz → UTC `Z`** conversion is
the one most likely to differ per driver (Npgsql `DateTime`/`DateTimeOffset`, pgjdbc
`OffsetDateTime`/`Timestamp`, pg8000 `datetime`, node-postgres `Date`) — this is exactly the drift B
gates.

**Retire:** `server/typescript/packages/integration-tests/test/normalization.test.ts` float/temporal
cases, `server/java/integration-tests/.../NormalizationFloatTest.java`,
`server/python/tests/integration/test_normalization.py`, and the C#/Kotlin equivalents — to the extent
each case is now covered by a shared round-trip. Keep each port's `Normalization` helper module.

## Part 2 — Projection coverage

In the same corpus:

1. **Read the pure passthrough view.** Add a query scenario (`projection-passthrough.yaml`) that
   `get`/`list`s `ProgramView` (the `v_program` passthrough projection) and asserts the passthrough
   fields (`id`/`title`/`status`) round-trip. Closes "the view is built but never read."

2. **sum / avg / min / max aggregates.** Add **one numeric field to `Week`** — `field.int durationMinutes`
   — to aggregate over. Extend `ProgramStat` (or add `ProgramStatExt`) with aggregate-projection fields:
   - `totalMinutes` → `origin.aggregate @agg:sum @of:Week.durationMinutes @via:Program.weeks` (int)
   - `avgMinutes` → `@agg:avg` (float — **exercises the float-normalization rule**, nice overlap)
   - `minMinutes` → `@agg:min` (int)
   - `maxMinutes` → `@agg:max` (int)
   Add a `projection-aggregates.yaml` scenario seeding weeks with known `durationMinutes` and asserting
   each rolled-up value (incl. the empty-program → `0`/null case per the existing count precedent).
   **Canonical result types pinned:** `sum`/`min`/`max` over an int → int (string-of-int on the wire,
   like BIGINT); `avg` → float (plain-decimal rule). This forces every port's view-DDL emit **and**
   projection-read to agree for all five aggregates.

## `normalization.md` updates

Add the pinned canonical rules for `timestamp`/`timestamptz`/`date`/`time` (whole-second, UTC-`Z` for
tz), state the **no-fractional-seconds** scope decision, and pin the aggregate result-type rules
(`sum`/`min`/`max`→int, `avg`→float).

## Testing

- The extended `Asset` + new `Week.durationMinutes` + `ProgramStat` aggregates flow through the
  TS generator into `canonical/schema.postgres.sql`; `schema-artifact.test.ts` (headless, per-push)
  asserts the committed DDL still matches — catches a missed column/view at the cheapest layer.
- The new round-trip scenarios run on all 5 ports under Testcontainers Postgres (integration gate, all
  PRs after A).
- TDD: author each scenario, watch it fail (or skip) on a port, implement the read-path canonicalization,
  watch it pass. Per the project gate: each port unit gets code review + simplify before merge-forward.

## Out of scope (explicit)

- **numeric/decimal + bytea** wire types — they need *new* field subtypes (`field.decimal`, a bytes
  field) + DDL mapping + per-port runtime, a sizable cross-port vocabulary addition. Deferred to a
  follow-up (tracked, not silently dropped).
- **Fractional-second** timestamp/time normalization — needs its own pinned truncation rule; B seeds
  whole seconds only.
- **Semantic codegen drift** — that is Phase **C** (FR-007), a separate design.

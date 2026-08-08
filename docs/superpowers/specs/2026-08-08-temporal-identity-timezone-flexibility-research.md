# Temporal types, identity generation, and timezone handling — flexibility research

**Date:** 2026-08-08 · **Status:** research only (no code changed) · **Scope:** the three
domains the maintainer flagged — dates/times, auto-increment ids, and the DB timezone
boundary — across all five ports, classified per finding as **(A) over-forcing**,
**(B) under-documenting**, **(C) wrong default**, or **deliberate-and-correct**.

**Method.** Every claim below is anchored to code or a committed doc (`file:line`,
repo-relative). Where code and prose disagree, the disagreement is itself listed as a
finding. Two upstream issue drafts from a real dogfooding adoption session (an existing
TypeScript/Postgres service with a hand-written Drizzle schema, `serial` PKs, and
`.defaultNow()` timestamps) were used as live field evidence and re-verified against the
code; both check out, and one is materially **reframed** below (§1, finding T2). Claims
not empirically executed are labeled *(verified by reading, not run)*.

---

## Executive summary — the thesis, answered per domain

The maintainer's suspicion was: *"Either we force too hard into one pattern, or we don't
have the documentation explaining how to do it other ways. And maybe our default ways are
not the norm we should be doing."*

| Domain | Verdict | One-line evidence |
|---|---|---|
| **1. Temporal types** | **Mostly (B) under-documenting + implementation bugs. The default is right.** | Instant-by-default (`timestamptz`) is the deliberate, evidence-backed ADR-0036 choice and matches the unanimous best-practice recommendation. But the escape hatches that exist (`@localTime`, `timestampMode`, `@default: "now"`) are documented wrongly or not at all, and the TS `@autoSet` path ignores `timestampMode` (a bug, not a vocabulary gap). |
| **2. Identity generation** | **Mostly (B) + one sharp adoption bug. The vocabulary is sufficient.** | `increment \| uuid \| assigned` + composite `@fields` + natural keys covers every real shape. The failure is at the *adoption seam*: the diff engine treats a legacy Postgres `serial` PK — the single most common pre-adoption shape — as default-drift and emits a destructive `DROP DEFAULT` (draft 01, verified). `assigned` and composite-PK behavior are effectively undocumented. |
| **3. Timezone at the DB boundary** | **The storage model is deliberate-and-correct; the *wire* contract is under-enforced (a conformance gap, not a vocabulary gap).** | Every port's DB codec is properly UTC-pinned. But the documented Tier-1 REST wire form (`...sssZ`) is only enforced in the *persistence* harness; the generated REST surfaces genuinely diverge per port (Python emits `+00:00`/microseconds, C# depends on host JSON options, TS depends on driver parsers), and the api-contract corpus deliberately sidesteps timestamp literals. Issue #275's unfinished Gson `DATE` branch is the same symptom in the Java JSON layer. |

**Direct answer:** we are **not** meaningfully over-forcing, and our defaults are **not**
wrong — `timestamptz`-by-default and identity-column emission are both the modern
recommendation. The dominant failure mode is **(B)**: the "other ways" either exist and
are undocumented/misdocumented, or exist in one layer (migrate) and not the other
(codegen). The second-order failure is a **cross-cutting adoption-seam pattern** (§5):
the tool is opinionated about what it *emits* (good) but also refuses equally-valid
physical encodings of the same logical declaration when it *reads reality back*
(serial-vs-identity, `CURRENT_TIMESTAMP`-vs-`now()`, `+00:00`-vs-`Z`) — which is exactly
where an adopter following the repo's own "metadata FOLLOWS the code" doctrine
(`agent-context/skills/metaobjects-authoring/SKILL.md:63-71`) gets hurt.

---

## 1. Temporal types

### 1.1 Current model

**Vocabulary** (`fixtures/registry-conformance/expected-registry.json`, the true registry):
three subtypes — `field.date`, `field.time`, `field.timestamp`. `@localTime` (boolean) is
registered on `field.timestamp` **only**; `@autoSet` (`onCreate | onUpdate`) is registered
on all three; `@default` on all three. There is **no** zone-name attr, no precision attr,
no offset-preserving attr, and `@dbColumnType`'s allowed values are `uuid | jsonb` only —
the physical escape hatch does **not** cover temporals (ADR-0036 §1 deliberately retired
`timestamp_with_tz` from it: `spec/decisions/ADR-0036-metamodel-vocabulary-finalization-for-1.0.md:32`).

**The instant-by-default decision** is ADR-0036 §1 (`:26-34`): `field.timestamp` = instant
→ `timestamptz`; `@localTime: true` = naive wall-clock → `timestamp without time zone`.
The rationale explicitly cites Postgres "Don't Do This", Ecto, and Django, and records
that an earlier `field.localDateTime` subtype draft was corrected to an attribute under
the ADR-0037 framework. Adopter data drove it: 76% / 62% of two production adopters'
timestamp fields carried the retired tz annotation (`:15`).

**Per-port native bindings** (all verified in code):

| | `field.date` | `field.time` | `field.timestamp` | `@localTime: true` | anchor |
|---|---|---|---|---|---|
| TS | ISO string¹ | ISO string¹ | ISO string¹ (`z.string()`, Drizzle `mode:"string"`) | ISO string, no `Z` | `codegen-ts/src/templates/zod-validators.ts:512-515`, `column-mapper.ts:446-463` |
| Java | `LocalDate` | `LocalTime` | `Instant` | `LocalDateTime` | `codegen-spring/.../SpringTypeMapper.java:94,99,108-110` |
| Kotlin | `LocalDate` | `LocalTime` | `Instant` | `LocalDateTime` | `codegen-kotlin/.../KotlinTypeMapper.kt:254-266` |
| C# | `DateOnly` | `TimeOnly` | `DateTimeOffset` | `DateTime` | `MetaObjects.Codegen/CSharpNaming.cs:46-52,113-115` |
| Python | `datetime.date` | `datetime.time` | aware `datetime`² | naive `datetime`² | `codegen/type_map.py:26-28`; `runtime/object_manager.py:796-804` |

¹ TS's string binding is per ADR-0019 (`spec/decisions/ADR-0019-runtime-return-type-contract.md:27`)
and per ADR-0036 (`:30`). The `timestampMode: "date"` codegen config
(`codegen-ts/src/metaobjects-config.ts:111-117`) opts the *Drizzle column* into JS `Date`.
² Python's *annotation* is bare `datetime.datetime` either way; `@localTime` acts at the
runtime coercion layer only (`object_manager.py:800-804`, `885-901`) — an asymmetry with C#,
where the declared CLR type bifurcates.

**Column types per dialect:** PG `date`/`time`/`timestamptz`(default)/`timestamp`(@localTime)
(`migrate-ts/src/expected-schema.ts:997,1073`, `emit/postgres.ts:223`; C# EF `HasColumnType`
twin at `MetaObjects.Codegen/Generators/DbContextGenerator.cs:380-387`). SQLite/D1: one
declared `TIMESTAMP` text-affinity column for both (`emit/sqlite.ts:346`), and the drift
check collapses temporal distinctions there **deliberately** — `buildExpectedSchema` takes
a `dialect` and normalizes expected temporals to what SQLite introspection can see
(`expected-schema.ts:76-82`; gate: `migrate-ts/test/integration/sqlite-roundtrip.test.ts:63-68`).

**Wire form (the pinned cross-port contract)** — `fixtures/persistence-conformance/normalization.md:36-43`:
`DATE`→`YYYY-MM-DD`; `TIME`→`HH:MM:SS[.fff]`; `TIMESTAMP`→no `Z`; `TIMESTAMPTZ`→UTC,
always `Z`; **millisecond** resolution, trailing zeros stripped, fraction omitted when
zero (`:45-59`). The corpus proves genuine normalization (a `-05:00`-seeded value must
read back as `Z`: `fixtures/persistence-conformance/queries/normalization-wire-types.yaml:4-10,29`).

### 1.2 What is and is not expressible

| Shape | Expressible? | How / why not |
|---|---|---|
| Instant (absolute point in time) | ✅ default | bare `field.timestamp` |
| Naive wall-clock date+time | ✅ | `@localTime: true` |
| Date-only, no zone | ✅ | `field.date` (inherently naive — ADR-0036 §1 rationale) |
| Time-of-day, no zone | ✅ | `field.time` |
| Server-stamped created/updated | ✅ | `@autoSet` (+ migrate emits a real `DEFAULT now()` — see T3) |
| DB-side default (`now()`/`CURRENT_TIMESTAMP`) | ✅ | `@default: "now"` → dialect-aware `.defaultNow()` (`column-mapper.ts:571-578`, `drizzle-schema.ts:318-326`) |
| TS native-`Date` binding | ⚠️ half | `timestampMode: "date"` affects the Drizzle column only; Zod/API types and the `@autoSet` stamp ignore it (T2) |
| **Naive column + UTC-instant semantics** (the Prisma/Rails/stock-Drizzle convention) | ❌ | no combination: instant ⇒ `timestamptz` column; `@localTime` ⇒ wall-clock semantics in JVM/C# native types (T5) |
| Wall-clock time **with a named zone** (`America/New_York`) | ❌ | no zone attr; matches PG (no such column type) — pattern is a second column. Deliberate non-goal, but undocumented |
| Zoned timestamp **preserving the original offset** | ❌ | `timestamptz` discards offset (PG semantics); norm everywhere is an extra column. Deliberate non-goal, undocumented |
| `timetz` | ❌ | deliberately excluded — "timetz is discouraged" (ADR-0036 §1 `:34`) |
| Partial dates (year-only, year-month) | ❌ | no subtype; industry norm is string/custom. Fine |
| Sub-millisecond wire precision | ❌ | wire is pinned at ms (`normalization.md:47-52`); PG stores µs — precision above ms is truncated at the wire tier |
| Physical precision override (`timestamp(3)`) | ➖ tolerated | introspection doesn't read `datetime_precision` (`introspect/postgres.ts:436-446` selects neither), so a live `timestamp(3)` neither drifts nor is declarable. Silent leniency |

### 1.3 Industry-norm comparison

*(from general knowledge of these tools' current documented behavior; each is stated as
the tool's default, not its best-practice guidance)*

| System | Timestamp default | Aware or naive? |
|---|---|---|
| Postgres wiki ("Don't Do This") | **recommends `timestamptz`** | aware |
| Drizzle | `timestamp()` → `withTimezone: false`, `mode: "date"` | **naive** |
| Prisma | `DateTime` → `timestamp(3)` | **naive** (UTC-by-convention) |
| EF Core / Npgsql (6+) | `DateTime`/`DateTimeOffset` → `timestamptz` (UTC-enforced) | aware |
| JPA / Hibernate 6 | `Instant` → TIMESTAMP_UTC; `LocalDateTime` → naive | aware for `Instant` |
| SQLAlchemy | `DateTime` → `timezone=False` | **naive** |
| Django (PG) | always `timestamp with time zone`; `USE_TZ` default True since 5.0 | aware |
| Rails (PG) | `datetime` → naive column, UTC-by-convention in AR | **naive** storage |
| Pydantic / FastAPI encoder | `datetime.isoformat()` → `+00:00`, µs | aware value, non-`Z` text |

Conclusion: `timestamptz`-by-default is the **prevailing recommendation** and the default
in the .NET/Django half of the world — MetaObjects' default is correct and should be
defended, not flipped. But the **TS ecosystem's de-facto default is naive storage with a
UTC convention** (Prisma, stock Drizzle), which is why TS-side adopters are the ones who
feel friction: their working tables often disagree with our (better) default, and the
adoption path for that disagreement is undocumented (T5).

### 1.4 Findings

**T1 — docs/features/field-types.md contradicts the code and the ADRs on the TS binding,
and omits `field.time`, `@localTime`, and `@autoSet` entirely. Class: (B).**
`docs/features/field-types.md:18-19` says TS binds `field.date`/`field.timestamp` to
`Date`. The shipped default is ISO **string** (`zod-validators.ts:512-515`;
`column-mapper.ts:453-457`'s comment explains why; ADR-0019 `:27` and ADR-0036 `:30` both
say "string" for TS). The same table has no `field.time` row (both JVM ports fully
support it — `SpringTypeMapper.java:99`, `KotlinTypeMapper.kt:257`), no
`field.float`/`decimal`/`uri`/`inet` rows, and the file never mentions `@localTime` or
`@autoSet` — the two attributes that answer "how do I do it another way". `@localTime`'s
only adopter-facing documentation is the 0.x→1.0 migration guide
(`docs/features/migrations/0.x-to-1.0.md:44-62`) and the authoring skill
(`SKILL.md:342-352`). This single stale page is likely a major *source* of the
"inflexible dates" perception: it presents one binding per port and no knobs.

**T2 — the `timestampMode` escape hatch is real but half-integrated and mis-documented;
draft 02 reframed. Class: bug + (B).**
Settling the flagged unverified claim: `timestampMode` **is** threaded into the base
column mapping for *every* field, `@autoSet` included
(`drizzle-schema.ts:80,101` → `mapColumnType(..., ctx.timestampMode)` →
`column-mapper.ts:460-463`). The draft's observed `mode: "string"`-despite-config is best
explained not by a second column-mapper bug but by the config never being read: the
draft's repro sets `codegen: { timestampMode: "date" }`, and **no `codegen` block exists**
— the key is top-level (`metaobjects-config.ts:111-117`), `normalizeConfig` silently
defaults anything it doesn't find (`metaobjects-config.ts:277-292`, no unknown-key
detection), and the *internal doc comment itself* says "Opt in via
`codegen.timestampMode`" (`render-context.ts:44-48`) — the likely origin of the wrong
shape. The only correct documentation is one line in an agent skill
(`agent-context/skills/metaobjects-codegen/references/typescript.md:48`).
What remains true and is a **real bug**: with the key set correctly, the `@autoSet`
suffix still hardcodes a string stamp (`.$defaultFn(() => new Date().toISOString())`,
`drizzle-schema.ts:375-381`) into a now-`Date`-mode column, and the generated Zod layer
is entirely `timestampMode`-blind (`zod-validators.ts:512-515` plus the `@autoSet` sites
`:192-194,257-259,287-292`) — so `timestampMode: "date"` yields a Drizzle layer typed
`Date` and an API/validator layer typed `string`. Severity is therefore **one coherence
bug + one config-UX/docs bug**, not two compounding column-mapper bugs.

**T3 — `@autoSet` already produces a DB-side `DEFAULT now()` in the schema; nobody says
so, and codegen doesn't mirror it. Class: (B).**
Draft 02's premise — "no combination gives DB-side default + native typing + optional on
insert" — is two-thirds false on the migrate side: an `@autoSet` column's expected schema
carries `default: { kind: "expr", value: "now()" }` (`expected-schema.ts:938-947`;
sqlite/d1-canonicalized to `CURRENT_TIMESTAMP` at `:242-252`, gated by
`migrate-ts/test/integration/sqlite-autoset-default.test.ts`). So a MetaObjects-managed
database **has** the real DB default, insert-optionality exists in the Zod insert schema
(`zod-validators.ts:240-259`), and any non-generated writer gets stamped by the DB. What
the generated Drizzle schema shows is only the app-side `$defaultFn` belt-and-suspenders
— which reads as "no DB default exists" to anyone auditing generated code. Also
adoption-relevant: a live hand-written `.defaultNow()` column diffs clean against
`@autoSet` (expected `now()` == introspected `now()`), which is exactly what an adopter
wants — and is documented nowhere.

**T4 — the expected-side vs introspect-side SQL-default-expression classifiers disagree
on any function call with arguments. Class: bug (adoption false-drift).**
*(verified by reading, not run.)* The expected side classifies a string `@default` as an
expression only for the fixed keywords or a literal `()`
(`EXPR_DEFAULT_PATTERNS`, `expected-schema.ts:903-909` — `/\(\)/` matches only *empty*
parens despite its "anything function-like" comment). The introspect side classifies
**any** leading-identifier function call as an expression
(`introspect/postgres.ts:211-227`, whose own comment claims lockstep with the expected
side). Consequence: an authored `@default` like `timezone('utc', now())` or
`nextval('seq')` is a *literal* on the expected side (quoted on emit — wrong DDL) and an
*expr* on the actual side (`columnDefaultsEqual` compares kind+value strictly,
`diff/index.ts:806-810`) → perpetual false drift. This also kills the one conceivable
metadata-level workaround for the draft-01 serial bug (declaring `@default:
"nextval(...)"` on the PK field). Same family, second instance: a hand-written
`DEFAULT CURRENT_TIMESTAMP` column vs `@autoSet`'s expected `now()` fails the strict
string compare and should false-drift on adoption *(needs a repro; parsePgDefault keeps
the raw spelling)*.

**T5 — the "naive column + UTC convention" adoption cell is inexpressible, and the
documented alternative (convert the column) has a silent data hazard. Class: (A)-adjacent,
but the recommended remedy is a bugfix + docs, not vocabulary.**
An adopter with Prisma/stock-Drizzle-shaped naive `timestamp` columns holding
UTC-by-convention instants must choose: declare instant (metadata says `timestamptz`,
migrate wants to convert the column) or declare `@localTime` (column matches, but
JVM/C#/Python native types become wall-clock — semantics lost; TS alone is unaffected
since its binding is string either way). The conversion path is the *right* long-term
answer — but `meta migrate` emits `ALTER TABLE ... ALTER COLUMN ... TYPE TIMESTAMPTZ;`
with **no `USING ... AT TIME ZONE 'UTC'` clause** (`emit/postgres.ts:75` — one generic
arm for every type change), and Postgres's implicit timestamp→timestamptz cast interprets
the naive values **in the session's `TimeZone`** — so applying the migration from a
non-UTC session silently reinterprets every stored instant. Fixing that emission (special-
case the naive→tz temporal conversion with an explicit `USING "col" AT TIME ZONE 'UTC'`,
or refuse-with-hint like #226/#258 precedent) plus a documented adoption recipe covers
this cell without new vocabulary. A physical `@dbColumnType: "timestamp"` escape (instant
semantics over naive storage) is ADR-0037-classifiable as step 1 physical-only, but it is
the exact inverse of what ADR-0036 just retired and would need all five ports' codecs to
implement "read naive as UTC" — recommend **not** doing it unless a second adopter asks
(see §7 gauntlet).

**T6 — `@localTime` inheritance is read own-only in the Java Spring mapper but resolving
in Kotlin, C#, Python, TS. Class: bug (ADR-0039 violation).**
`SpringTypeMapper.java:192-196` reads `hasMetaAttr(LOCAL_TIME)` without the parent flag;
Kotlin resolves (`KotlinTypeMapper.kt:568-569,607-611`), C# resolves
(`CSharpNaming.cs:89-90`), TS/migrate resolve with explicit ADR-0039 comments
(`expected-schema.ts:996`). A base-entity-declared `@localTime` therefore binds
`LocalDateTime` in Kotlin but `Instant` in Java for the same metadata. The OMDB codec has
the same own-only read (`JdbcCodecs.java:480-488`). Exactly the "silently drops
everything inherited via extends" bug class ADR-0039 documents.

**T7 — smaller port divergences.** (i) C#'s `@autoSet` stamp for a `@localTime` field is
`System.DateTime.Now` — host-local wall clock — where Python uses UTC
(`RoutesGenerator.cs:515` vs `router_generator.py:154`); same metadata, different stored
value on any non-UTC host. Class: bug. (ii) Generated Kotlin `field.time` columns use
stock Exposed `time()` which truncates sub-seconds (the conformance reference had to
hand-write `PreciseLocalTimeColumnType.kt:11-34`; the generator never emits it —
`KotlinTypeMapper.kt:473`). Class: bug, corpus-invisible (the generated-table lane
doesn't run the ms-bearing rows through stock `time()`). (iii)
`server/java/codegen-kotlin/README.md:26` documents an Exposed `timestampWithTimeZone`
that the code doesn't emit (it emits a generated file-local `instantWithTimeZone` —
`KotlinTypeMapper.kt:482`). Class: (B).

**Deliberate-and-correct (say it louder):** instant-by-default; `@localTime` as attribute
not subtype; no `timetz`; date/time inherently naive; ms wire resolution; SQLite temporal
collapse in drift checks. All have written rationale (ADR-0036 §1, `normalization.md`)
and survived adversarial review; none should be relaxed.

---

## 2. Identity generation

### 2.1 Current model

**Vocabulary:** `identity.primary` with `@fields` (string-array — composite is
first-class) and optional `@generation: increment | uuid | assigned`
(`expected-registry.json` identity.primary entry;
`metadata/src/core/identity/identity-constants.ts:41-50`). Absent `@generation` = natural
key. `assigned` additionally interacts with FR-013: an `@readOnly` field may participate
in an *assigned* primary identity (`metadata/src/core/field/validate-field-readonly.ts:134-154`).

**What each port emits per value** (schema is TS-owned per ADR-0015, so DDL applies to TS
only; other ports do data-access/API):

| | `increment` | `uuid` | `assigned` / absent |
|---|---|---|---|
| TS Drizzle schema | PG: `serial()`/`bigserial()` by field width; SQLite: `.primaryKey({autoIncrement:true})` (`drizzle-schema.ts:273-286`) | PG `.defaultRandom()`; SQLite `$defaultFn(crypto.randomUUID())` (`:288-293`) | bare `.primaryKey()` — natural key (`:294-297`) |
| TS migrate DDL | PG: `GENERATED BY DEFAULT AS IDENTITY` (`emit/postgres.ts:201`); SQLite `AUTOINCREMENT` (`emit/sqlite.ts:320`) | PG `DEFAULT gen_random_uuid()` (`emit/postgres.ts:202`); SQLite `lower(hex(randomblob(16)))` (`emit/sqlite.ts:326`) | plain PK |
| Kotlin Exposed | `.autoIncrement()` (`KotlinExposedTableGenerator.kt:625-630`) | server DEFAULT `gen_random_uuid()` **and** client `UUID.randomUUID()` in the repo insert (`:863-869`; `KotlinRepositoryGenerator.kt:186-193`) | write `dto.pk` verbatim (`:194-200`) |
| Java (codegen-spring) | **no dispatch** — repository is an interface the consumer implements (`SpringRepositoryGenerator.java:108-120`); only the PK *type* is derived (`SpringTypeMapper.java:166-183`) | same | same |
| Java OMDB runtime | `AUTO_LAST_ID`, per-dialect read-back (`SimpleMappingHandlerDB.java:346-375`; `PostgresDriver.java:104-111`) | app-side `UUID.randomUUID()` (`GenericSQLDriver.java:1513-1519`) | caller supplies |
| C# | **no dispatch anywhere** — bare `[Key]`, EF's `ValueGeneratedOnAdd` convention does everything (`EntityGenerator.cs:1030-1031`; the `MetaPrimaryIdentity.Generation` property is dead code, `MetaIdentity.cs:47-56`) | same (EF client-side Guid generator) | caller supplies |
| Python | omit PK from `<Name>Create` model (`entity_model.py:360-372`); runtime relies on `RETURNING` (`object_manager.py:217-220,284-290`) | same | PK kept in create body |

Notably, the **project's own two TS layers use different physical mechanisms for
`increment` on Postgres**: codegen's Drizzle schema says legacy `serial`
(`drizzle-schema.ts:283-284`) while migrate's DDL says modern `IDENTITY`
(`emit/postgres.ts:201`). Harmless today (Drizzle never emits DDL here), but it proves
the point of finding I1: both encodings are the same logical declaration.

### 2.2 What is and is not expressible

| Shape | Expressible? | Notes |
|---|---|---|
| DB auto-increment PK | ✅ | `@generation: increment` |
| UUID PK, DB- or app-generated | ✅ | `@generation: uuid` (which side generates varies by port — undocumented; see I4) |
| Caller-supplied / app-generated id (ULID, snowflake, anything) | ✅ | `@generation: assigned` — but see I3 (Kotlin controller bug) and I4 (undocumented) |
| Natural key, no generation | ✅ | omit `@generation` |
| Composite PK | ⚠️ half | schema + Drizzle + EF `[PrimaryKey]` all support it (`drizzle-schema.ts:120-121`; `EntityGenerator.cs:319-323`), but the generated query/route layer keys **only on the first PK field** (`codegen-ts/src/templates/queries.ts:29-35` — explicit comment; only the #214 re-read uses all fields). `findById`/`update`/`DELETE /:id` on a composite-PK entity silently address by one component. Undocumented anywhere (`composite` appears once in all docs, `SKILL.md:557`, about FK targets) |
| **Adopting a legacy `serial` PK** | ❌ today | the draft-01 bug (I1) — the metadata is right, the diff refuses reality |
| DB-side PK default the tool doesn't own (trigger, custom function) | ⚠️ | `assigned` + the T4 classifier bug blocks declaring the default; zero-arg functions (`gen_random_uuid()`) squeak through the `/\(\)/` pattern, argument-bearing ones don't |
| New generation *strategies* as first-class vocab (ulid, uuidv7, snowflake) | ❌ deliberately | `assigned` covers them app-side; ADR-0007 Amendment 2's re-entry bar (a shipping consumer must dispatch on it) is the right precedent — same treatment as `@role` |
| Moving a PK on an existing DB | refused explicitly | detect-and-refuse with a clear error, by design (#258; `docs/features/migrations-and-drift.md:100-115`) |

### 2.3 Industry-norm comparison

Postgres itself has recommended identity columns over `serial` since v10, and the
ecosystem is mid-migration: EF Core/Npgsql and Django (4.1+) emit `IDENTITY`; Drizzle
(`serial()`), Prisma (`autoincrement()` → SERIAL), Rails, and SQLAlchemy's default still
create `serial`-family columns. **Both encodings are everywhere.** Emitting `IDENTITY`
on fresh DDL (what migrate does) is the modern choice; treating live `serial` as
*equivalent* on read-back is what every coexisting tool must do — and is precisely what
the diff engine fails to do.

### 2.4 Findings

**I1 — legacy `serial` adoption emits a destructive `DROP DEFAULT`. Class: bug (the
sharpest single finding of this research); root cause verified exactly as drafted.**
Introspection correctly detects `nextval(...)` and sets `identity = "increment"` on the
actual side (`introspect/postgres.ts:462-468`) — but it also (correctly) records the real
`DEFAULT nextval(...)` (`:459-460`), and the default-diff guard at `diff/index.ts:384-394`
skips identity-driven defaults only for `uuid`, on the stated-in-comment assumption that
"an AUTOINCREMENT column has no DEFAULT" — true for SQLite and modern PG `IDENTITY`,
**false for `serial`**. Expected `undefined` vs actual `nextval(...)` →
`change-column-default` → `ALTER ... DROP DEFAULT;` with no replacement mechanism (the
`GENERATED ... AS IDENTITY` emission exists only in the CREATE TABLE path,
`emit/postgres.ts:201`). Draft 01's suggested fix (extend the guard: `identity ===
"increment"` + the already-detected serial pattern ⇒ not default-drift) is right, small,
and matches how the tool already treats modern IDENTITY columns (whose
`column_default` is NULL, so they diff clean today; note the introspection SELECT reads
neither `is_identity` — `:436-446` — identity is simply never diffed as a dimension,
`diff/index.ts:362-403`). A `serial`→`IDENTITY` modernization, if ever wanted, should be
its own opt-in migration — not fallout from adoption.

**I2 — the `@generation` semantic is under-specified: "increment" means *a* DB-side
auto-increment mechanism, but nothing says which, or that adoption accepts any. Class: (B).**
`docs/features/entities.md` shows only `increment` (`:31,62`); `assigned` appears in **no**
feature doc (its only doc surface is loader validation errors); which side mints a `uuid`
(DB default vs app) is not documented and *differs by port* (Kotlin repo mints app-side
with an explanatory comment, `KotlinRepositoryGenerator.kt:36-38,186-193`; TS PG uses the
DB default; Java OMDB mints app-side, `GenericSQLDriver.java:1513-1519`; C# delegates to
EF's client-side Guid generator — with one stale comment claiming the DB default fires,
`RoundtripWriter.cs:14-15`). None of this is wrong per se — per-port idiom is chartered —
but an adopter cannot currently learn any of it from docs.

**I3 — `assigned` is broken in the generated Kotlin controller. Class: bug.**
`KotlinSpringControllerGenerator.kt:433` unconditionally skips the PK column on insert
("the 95% case") — so an `assigned` entity's generated controller drops the
caller-supplied id, while the same entity's generated *repository* handles it correctly
(`KotlinRepositoryGenerator.kt:194-200`, whose header comment `:40-41` even names the
controller gap). Also: `PrimaryIdentity.java:86` treats absent-`@generation` as
`assigned` while `MetaIdentity.isAssigned` (`:185`) requires the literal string — a
latent base/subclass inconsistency.

**I4 — composite PKs are a silent half-support cliff. Class: (A)-lite + (B).**
Fully expressible and correctly emitted at the schema tier; silently degraded at the
generated-API tier to first-field addressing (anchors in §2.2). Either the API tier
should refuse-or-support (a `GET /:id1/:id2` surface is real work; a load-time *warning*
that generated CRUD for a composite-PK entity addresses by first component is cheap), or
the limitation must be documented. Today an adopter finds out via wrong rows.

**Deliberate-and-correct:** the three-value `@generation` vocabulary itself (new
strategies gated on a shipping consumer, per the `@role`/ADR-0040 reserved-not-registered
precedent); natural keys via omission; the moved-PK refusal (#258); Java's
consumer-implements-repository stance (documented in code, `SpringRepositoryGenerator.java:108-110`).

---

## 3. Timezone handling at the database boundary

### 3.1 The round-trip, per port — verified

The **DB codec tier is in good shape**: every port pins UTC explicitly rather than
trusting process defaults.

- **Java/OMDB** — the model citizen: `Calendar.getInstance(TimeZone.getTimeZone("UTC"))`
  per access (`omdb/.../JdbcCodecs.java:151-153`), DATE read/write through UTC calendars
  (`:173-201`), instant writes as `OffsetDateTime` at `ZoneOffset.UTC` with
  `Types.TIMESTAMP_WITH_TIMEZONE` (`:362-368`), naive via UTC calendar (`:353,376-384`),
  with comments naming the JVM-default-zone bug each overload closes (`:155-171,329-335`).
  No default-zone dependence found in the runtime paths. (One test-harness asymmetry:
  Kotlin's normalizer uses default-zone `Timestamp.toLocalDateTime()` where Java uses the
  UTC-anchored form — `integration-tests-kotlin/.../Normalization.kt:79` vs
  `integration-tests/.../Normalization.java:84-87`.)
- **C#** — `DateTimeOffset` normalized via `.UtcDateTime`, parse with
  `AssumeUniversal|AdjustToUniversal` (`Normalization.cs:71`, `WriteCoercion.cs:151-156`);
  EF `HasColumnType` emitted precisely because Npgsql rejects `Kind=Unspecified` on
  `timestamptz` (`DbContextGenerator.cs:333-336`).
- **Python** — driver-native pass-through per ADR-0019 (`object_manager.py:7-13,90-166`);
  aware-vs-naive is the tz discriminator at the boundary (`normalization.py:78-86`);
  inbound `Z`→`+00:00`, offset-less instants defaulted to UTC (`object_manager.py:885-901`).
- **TS** — the interesting one. node-postgres hands TIMESTAMP and TIMESTAMPTZ to JS as
  the same `Date`, and a naive TIMESTAMP is **shifted by the host timezone** on the way
  in — the harness closes both hazards by parsing raw wire text keyed by column OID
  (`integration-tests/src/temporal-parsers.ts:4-17`) and pinning the session zone
  (`query-scenario.ts:57-62`, `options: "-c timezone=UTC"`). **But that is
  test-harness-only by explicit design** (`pg-pristine-default-types.ts:6-13`: "that
  override is a TEST-HARNESS/boundary concern, NOT part of runtime-ts"). Production
  generated code ships no parser registration, no session-TZ pin, and no serialization
  canonicalizer (`registerTemporalParsers`/`setTypeParser` appear nowhere under
  `runtime-ts/src`, `codegen-ts/src`, or `cli/src`).

**Session-timezone assumptions:** none in Java/C#/Python runtime paths; TS production is
*exposed* to them (Drizzle string-mode `mapFromDriverValue` falls back to
host-offset arithmetic when the driver yields a `Date`), which today is masked in CI by
UTC hosts and the harness parsers. SQLite/D1: no native temporal type; declared
`TIMESTAMP` text columns, values are whatever the app writes (TS writes ISO strings), and
the drift checker deliberately collapses temporal kinds there (§1.1). `verify --db`
drift-checks PG temporals exactly (`timestamptz` vs `timestamp` is a strict dimension,
`sql-type.ts:37`, faithful introspection `introspect/postgres.ts:166-170`) and
SQLite leniently — both correct.

### 3.2 The wire tiers — where the contract actually stops being enforced

Three tiers exist, and only the first is gated:

1. **Persistence-conformance wire** — pinned and enforced byte-identical in all five
   ports (`normalization.md`; the roundtrip corpus incl. non-UTC-offset and
   whole-second proofs; each port's normalizer verified in §1/§3 anchors).
2. **Documented REST wire** — `docs/features/api-contract.md:158` declares
   `YYYY-MM-DDTHH:mm:ss.sssZ` a **Tier-1 invariant**.
3. **Actual generated REST wire** — port-divergent:
   - **Python**: generated FastAPI handlers return raw dicts, no `response_model`, no
     encoder (`router_generator.py:368-425`) → FastAPI's default `datetime.isoformat()`
     → **`2026-06-03T14:30:00.123000+00:00`** — microseconds, `+00:00`, never `Z`.
   - **C#**: generated routes *fetch the host's* JSON options (`RoutesGenerator.cs:236-241,706-711`);
     the UTC `"o"`-format converter that makes the harness emit `Z` is **test-host code**,
     not codegen output (`GeneratedAuthorServerFactory.cs:118-119,343-368`) → an adopter's
     default host emits System.Text.Json's default (`"o"`-like, 7-digit fraction, offset
     as stored).
   - **TS**: whatever the driver parser + Drizzle mode produce, JSON-stringified — with
     stock node-postgres, not the canonical form.
   - The api-contract corpus cannot see any of this: its `@autoSet` assertions
     deliberately compare fields **to each other, never to a literal** — "so timestamp
     non-determinism is a non-issue" (`ApiContractAssertions.cs:7-10`).

**This is the systemic finding of domain 3 (Z1): the documented cross-port REST temporal
wire form is asserted nowhere, and it is not currently true.** It is also the frame for
**issue #275**: the Gson `MetaObjectSerializer` DATE branch serializes the *container*
instead of the field value (`metadata/.../MetaObjectSerializer.java:76-78` — every other
branch reads `mf.getX(vo)`; DATE passes `vo` to a context that re-enters the same
adapter, `MetaObjectGsonInitializer.java:53-73` → unbounded recursion), with the
`// TODO: consider custom DATE serialization` sitting inline since the branch was
written. `DataTypes.DATE` backs both `TimestampField` (`TimestampField.java:89`) and
`DateField` (`DateField.java:47`), so both subtypes hit it. Nothing caught it because
nothing anywhere gates a JSON temporal literal — the same reason the port-divergent REST
wire survives. **Guidance for the tactical #275 plan:** the fix's wire form should be the
already-pinned contract, not a new choice — ISO-8601 UTC with `Z`, millisecond
resolution, fraction omitted when zero (`normalization.md:38-52`), i.e. serialize
`mf.getDate(vo)` to the same string the Jackson harness config produces
(`GeneratedAuthorControllerHarness.java:135-138`) — **not** epoch millis, and not a
locale/zone-dependent `toString()`.

### 3.3 Findings summary

- **Z1 — REST temporal wire is documented as invariant but unenforced and divergent.
  Class: (B) + conformance gap** (remedy: pin it in the api-contract corpus with literal
  assertions on a deterministic seeded read path, then fix the three ports to it; the
  `fieldsEqual` design can stay for `@autoSet` non-determinism).
- **Z2 — TS production path has no owned canonicalization seam.** ADR-0019 assigns wire
  canonicalization to "the serialization layer" (`ADR-0019:41`), but the TS generated
  stack never implements one; the harness parsers stand in for it. Class: (B)/design
  debt — either the generated routes serialize through a small canonicalizer in
  `runtime-ts`, or the scaffolded db.ts pins parsers + session TZ, and either way the
  choice gets documented.
- **Z3 — migrate's naive→timestamptz ALTER lacks `USING ... AT TIME ZONE 'UTC'`** (T5) —
  the one place a *timezone* bug can corrupt data at rest. Class: bug.
- **Deliberate-and-correct:** UTC-pinned codecs everywhere (JVM's especially well
  commented); aware/naive as the boundary discriminator; SQLite temporal-collapse
  leniency; `TIMESTAMP` no-`Z` / `TIMESTAMPTZ` always-`Z` discrimination.

---

## 4. The two field-evidence drafts — disposition

| Draft | Verdict | Notes |
|---|---|---|
| 01 (`migrate` drops `serial` default) | **Confirmed exactly as written; fix as suggested.** | Root cause at `diff/index.ts:394`; the guard's comment is wrong for legacy serial. Extend the skip to `identity === "increment"` + the serial pattern `introspect/postgres.ts:465-467` already computes. Also fold in the `CURRENT_TIMESTAMP`-vs-`now()` sibling (T4) while in that code. |
| 02 (`@autoSet` × `timestampMode`) | **One real bug + one docs/config-UX bug — not two compounding codegen bugs.** | The base column *does* honor `timestampMode` (`drizzle-schema.ts:80,101`); the repro's `codegen:`-nested key was silently ignored (no such block; no unknown-key warning; the internal comment at `render-context.ts:48` teaches the wrong path). Real bug: the `@autoSet` suffix + entire Zod tier are `timestampMode`-blind. Its "fix 2" (delegate `@autoSet` to the DB `DEFAULT now()` on PG) is already half-true — migrate emits that DEFAULT (T3) — so the remaining work is codegen-side coherence + documentation, all additive. |

---

## 5. The cross-cutting pattern — real, and it has a name

The maintainer suspected one pattern; the evidence supports it, with a precise shape:

**Every logical concept in these domains has one blessed physical realization per layer,
and the layers disagree with each other and with the world — while the metamodel itself
is fine.** Concretely: *one* logical `@generation: increment` is realized as `serial`
(TS codegen), `IDENTITY` (TS migrate DDL), `autoIncrement()` (Kotlin), EF conventions
(C#) — and the adoption diff accepts only the realization migrate itself emits. *One*
logical instant is realized as `Z`-string (persistence wire), `+00:00`-microseconds
(Python REST), host-configured (C# REST), driver-dependent (TS prod). *One* logical
`@autoSet` is realized as app-stamp (codegen) *and* DB default (migrate), each unaware of
the other.

The corollary is the actionable rule: **be conservative in what you emit, liberal in
what you accept at the adoption/introspection seam, and *pinned* at every serialization
seam.** The project already applies rule 1 rigorously (one blessed emission per dialect,
byte-identical gates). Rule 2 is where draft 01, T4, and the `CURRENT_TIMESTAMP` sibling
live — the diff engine currently treats "not the encoding I would have emitted" as drift.
Rule 3 is where Z1/Z2/#275 live — the wire is pinned only where the persistence harness
happens to stand.

This also explains why the failures cluster on *adopters* rather than greenfield users:
greenfield never leaves the blessed path, so the conformance corpora (which are all
greenfield-shaped: fresh schema from the tool's own DDL, canonical seeds) structurally
cannot see any of it. The one corpus that fights this — the migrate idempotence gate
(apply → re-diff EMPTY) — is also the one that has caught the most bugs of this class
(0.15.21, 0.20.2). The missing sibling is an **adoption-idempotence gate**: create a
schema the way *other tools* create it (`serial`, `DEFAULT CURRENT_TIMESTAMP`, naive
timestamps), point `--from-db` metadata at it per the "metadata FOLLOWS the code"
doctrine, and require an empty diff.

---

## 6. Recommendations, prioritized

### Tier 0 — documentation (free; do first)

1. **Rewrite `docs/features/field-types.md`**: correct the TS temporal binding to string
   (+ the `timestampMode: "date"` opt-in and its current limits), add the missing
   `field.time`/`float`/`decimal`/`uri`/`inet` rows, add `@localTime` and `@autoSet` to
   the attr table with the instant-by-default rationale in one sentence (T1).
2. **Fix the `render-context.ts:44-48` comment** (`codegen.timestampMode` → top-level
   `timestampMode`) and document `timestampMode` in the `@metaobjectsdev/cli` README next
   to `columnNamingStrategy` (T2).
3. **Write the adoption recipes** the drafts prove are needed — a "Adopting an existing
   Postgres schema" section (in `migrations-and-drift.md` or the authoring skill):
   `serial` PK → `@generation: increment` (once I1 lands); `.defaultNow()`/`DEFAULT
   now()` timestamp → `@autoSet` or `@default: "now"` and *when to pick which* (@autoSet =
   optional-on-insert semantics + app stamp + DB default; @default = DB default only);
   naive-UTC-convention columns → the conversion path (after Z3 lands) or `@localTime`
   with its native-type consequences stated; `@generation: assigned`/ULID; composite-PK
   API limitation (I4).
4. **Document the `@autoSet` ⇒ `DEFAULT now()` schema fact** (T3) and per-port `uuid`
   minting side (I2) — one table in `generated-mutations.md`.
5. **Fix `server/java/codegen-kotlin/README.md:21,26`** (varchar default; the
   `instantWithTimeZone` generated helper) (T7iii).
6. **Say the deliberate constraints out loud**: a short "temporal design stance" note
   (could live in field-types.md): no `timetz`, no zone-name attr, no offset
   preservation, ms wire resolution — each with its one-line rationale and the
   workaround pattern (extra column). Turning silent refusals into stated stances is the
   cheapest possible answer to "we force too hard".

### Tier 1 — bug fixes, in place (additive, non-breaking)

7. **I1 / draft 01**: extend the `diff/index.ts:394` guard — `increment` + live serial
   pattern ⇒ not default-drift. Add the adoption-idempotence test (serial table →
   `--from-db` → empty diff).
8. **T4**: reconcile the expected-side expression classifier with the introspect side
   (any leading-identifier call = expr on both), and cover `CURRENT_TIMESTAMP` ≡ `now()`
   equivalence in `columnDefaultsEqual` (PG-spelling normalization). Repro first.
9. **T2 / draft 02 fix 1**: make `autoSetSuffix` and the Zod `@autoSet` sites honor
   `timestampMode` (emit `new Date()` when mode is `date`; keep string otherwise).
   Consider a config-load warning for unknown top-level keys while there
   (`normalizeConfig` currently swallows them silently).
10. **Z3 / T5**: the naive↔tz temporal `change-column-type` arm emits
    `USING "col" AT TIME ZONE 'UTC'` (or refuses with a hint, matching the #226/#258
    refuse-don't-corrupt precedent).
11. **T6**: Java `SpringTypeMapper.localTimeOptIn` + OMDB `isLocalTime` → resolving reads
    (ADR-0039); pin with a base-entity-`@localTime` conformance fixture.
12. **T7i**: C# `@localTime` `@autoSet` stamp → UTC wall clock
    (`DateTime.UtcNow`-derived), matching Python; **I3**: Kotlin controller honors
    `assigned` (delegate to the repository's existing branch); **T7ii**: emit the
    precise time column type the conformance reference already hand-wrote.
13. **I4**: load-time or gen-time warning when generated CRUD is requested for a
    composite-PK entity (until/unless the API tier supports composite addressing).

### Tier 2 — the wire-contract consolidation (additive but cross-port; its own unit)

14. **Z1/Z2**: pin the REST temporal wire form to the persistence form (`Z`, ms) —
    add literal-assertion scenarios to the api-contract corpus on deterministic seeded
    reads (both lanes), then bring the three divergent surfaces to it: Python routes gain
    an encoder (or `response_model`), C# codegen registers the UTC converter it currently
    only gets from the test host, TS generated stack owns a canonicalization seam
    (scaffolded db.ts parser pin or a `runtime-ts` serializer). **The #275 fix should
    target this same form now** (§3.2) so Java's JSON layer doesn't need a second pass.
    This closes the docs-vs-reality gap on `api-contract.md:158` in the direction of the
    docs.

### Tier 3 — breaking or vocabulary (explicitly deferred; the 0.21.0 slot just closed)

15. **No default flips are recommended.** `timestamptz`-by-default: keep (it is the
    recommendation the naive-default ORMs are slowly migrating toward). TS
    `timestampMode: "string"`: keep as default (it is what makes the TS wire coherent;
    `date` becomes a *fully supported* opt-in after #9).
16. **No new vocabulary is proposed.** The one candidate examined — a physical
    `@dbColumnType: "timestamp"` naive-storage escape for instant fields (the
    Prisma-shaped adoption cell, T5) — passes ADR-0037 mechanically (§7) but fails the
    ADR-0023 economics today: recipes #3 + the `USING` fix #10 cover the need with zero
    vocabulary. Revisit only if a real adopter cannot take the column conversion.

---

## 7. ADR-0037 gauntlet for the one vocabulary candidate (recorded so it isn't re-litigated)

**Candidate:** `@dbColumnType: "timestamp"` on `field.timestamp` — instant native
semantics over naive physical storage (read-as-UTC convention).

- **Step 0, derivable?** No — nothing in existing metadata distinguishes "naive column
  holding UTC instants" from "naive column holding wall-clock" (that is `@localTime`'s
  meaning).
- **Step 1, physical-only?** **Yes** — the native type and meaning stay instant
  (`Instant`/`DateTimeOffset`/aware `datetime`/`Z`-string); only the column type changes.
  So per ADR-0037 it is `@dbColumnType` territory, *not* a subtype or new attr — and
  ADR-0039 already makes `@dbColumnType` the one deliberately own-only attr, which fits
  (a physical storage concession should not inherit).
- **Steps 2a-c:** not reached (step 1 disposes of it).
- **ADR-0023 cost class:** registered-value extension on an existing attr + a
  registry-conformance fixture + **five ports of codec work** (each must read naive as
  UTC when the override is present) + it reverses the *spirit* of ADR-0036 §1's
  retirement of `timestamp_with_tz` (which removed the physical-knob-for-tz-ness in the
  aware direction). Verdict: mechanically legal, economically unjustified while the
  conversion path exists. **Do not add without a named adopter who cannot convert.**

No other candidate survives step 0/1: zone-name and offset-preservation are "second
column" patterns (derivable structure, not new semantics); precision is physical and
currently silently tolerated; new `@generation` values are blocked by the
shipping-consumer bar the project already ratified for `@role`.

---

## 8. Non-goals and open questions for the maintainer

**Non-goals (constraints this research confirms as correct and worth defending louder):**
instant-by-default; `@localTime` as attribute; no `timetz`/zone-attr/offset-preservation/
partial dates; ms wire resolution; three-value `@generation`; moved-PK refusal;
schema-is-TS-owned (no port re-grew DDL — verified clean in Java/C#/Python).

**Open questions needing a ruling:**

1. **Composite-PK API stance (I4):** document-as-unsupported + warn, or commit to
   composite addressing in generated CRUD? (Warn is cheap; support touches every port's
   route/query generators.)
2. **REST wire pinning (Z1) sequencing:** pin-then-fix in one coordinated cut, or fix
   ports individually behind the existing loose assertions first? A coordinated cut is
   honest (the corpus change is what makes it real) but touches all five ports — likely
   a MINOR by the versioning doctrine if any adopter-visible wire byte changes
   (Python's `+00:00`→`Z` is adopter-visible).
3. **TS production canonicalization seam (Z2):** scaffolded driver-parser pin (smallest,
   but per-driver) vs a serializer in `runtime-ts` (cleaner ADR-0019 fit, more surface)?
4. **Adoption-idempotence gate:** bless as a standing corpus (foreign-DDL fixtures →
   `--from-db` → empty diff) alongside the migrate idempotence gate? This is the
   structural fix for the whole §5 pattern, not just its two known instances.
5. **Draft 02 "fix 2"** (PG `@autoSet` delegating to `.defaultNow()` in the generated
   Drizzle column too): worth the codegen churn given the migrate-side DEFAULT already
   exists (T3), or is documenting the belt-and-suspenders reality enough?

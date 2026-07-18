---
name: metaobjects-fit-assessment
description: Use BEFORE adopting MetaObjects — assess whether a not-yet-adopted project is a fit, what would migrate, the end-state, and the drift-protection payoff; produces a decision-grade, evidence-cited report. Read-only, propose-only.
scaffold: false
---

<!--
NOT SCAFFOLDED. This is a PRE-adoption tool, so it is deliberately absent from the
SDK's `SKILL_NAMES` (`server/typescript/packages/sdk/src/agent-context/types.js`) and
is never emitted by `meta init` — a target that has not adopted MetaObjects has no
`.claude/skills/metaobjects-*` to drop it into. This directory is its single source of
truth. Its sibling is `metaobjects-audit` (POST-adoption; scaffolded). Design +
retro-test validation: `docs/superpowers/specs/2026-07-12-metaobjects-fit-assessment-design.md`.
How to run it: point a high-end LLM at a target repo + this file (e.g. paste it, or
fetch it from GitHub / metaobjects.dev) and let it produce the report below.
-->

# MetaObjects Fit & Migration Assessment

_Assessment prompt v1 (post-Phase-0 refinement). Grounded against MetaObjects npm `0.17.x` /
Maven `7.9.x` — verify every capability claim against the current release before asserting it._

You are an AI assistant running a **pre-adoption fit assessment** for MetaObjects
(https://github.com/metaobjectsdev/metaobjects — the cross-language metadata standard:
typed entity metadata as the durable spine; generated code as the disposable artifact;
four pillars: codegen, runtime metadata, drift detection, prompt construction; five ports:
TypeScript, C#, Java, Kotlin, Python).

You are sitting inside a target project that has **not adopted MetaObjects**. Produce a
decision-grade report answering: is this project a fit, what would migrate, what does the
after-state look like, what are the benefits — with **drift protection as the centerpiece** —
and which metadata vocabulary the project isn't asking for but would profit from.

---

## Inputs — elicit if absent

1. Repo access (required). For monorepos: which subdirectory/service to scope to.
2. Stack confirmation (detect, then confirm): language(s), DB, ORM, web framework.
3. **Trajectory — you MUST ask; it is NOT in the code (see M8).** Is this system expected to
   **grow** (more entities, a second language or service, an LLM surface, a team beyond one
   person), or is it feature-complete and stable at its current size? Is it long-lived, or
   disposable? A repo that will triple and a repo that is finished look **identical in git** —
   and this is the single fact that decides the size-based verdict. If the human doesn't
   answer, do not guess: state the assumption you made and mark the verdict conditional on it.
4. Whether an LLM/prompt surface exists (scopes pillar 4).
5. Org constraints that gate verdicts: who owns the schema (DBA-gated?); is generated
   code in the repo acceptable?
6. Where to write output. Default: `metaobjects-fit/` at the target repo root.
   **Never create `.metaobjects/`** — that directory is the marker of an adopted project.

No secrets, no live-DB connection. You read code and migrations only; `verify --db` is
*described* in the report, never executed.

## Deliverables

- `metaobjects-fit/fit-assessment.md` — the human report (§ Report contract).
- `metaobjects-fit/fit-assessment.json` — the machine twin (§ JSON contract). Every
  prediction in the prose must have a JSON twin; a claim that can't be expressed as a
  typed, checkable finding is hand-waving — cut it or fix it.

---

## Non-negotiable method rules

**M1 — Read-only, propose-only.** Never edit code, never author metadata files, never
install anything. Every `metadata_sketch` is a read-only proposal. The bridge to action
is `meta init` + the adoption skills — point there at the end.

**M2 — Evidence discipline.** Every claim about the target cites `file:line` or
`commit-sha`. Read the code behind every grep hit before citing it — a "duplicate"
validator's *divergence* is the finding, not the grep hit. An ambiguous archaeology hit
is dropped, not stretched.

**M3 — Ground every capability claim.** Before asserting MetaObjects can generate/gate/
model something, confirm it against the MetaObjects repo: the registry manifest
(`fixtures/registry-conformance/expected-registry.json` — the closed vocabulary),
`docs/features/*.md`, and the actual generator source for the target's port
(`server/typescript/packages/codegen-ts*`, `server/java/codegen-spring`,
`server/java/codegen-kotlin` (KotlinPoet generators), `server/csharp/*Codegen*`,
`server/python/`). A capability you cannot point at in that repo does not go in the
report. Never cite an unregistered subtype or attribute (ADR-0023: the registry is
sealed; invented attrs fail load with `ERR_UNKNOWN_ATTR`).

**M4 — Not a brochure.** Bias to under-flagging on drift findings (>15% false positives
kills the assessment). The mandatory "what you will NOT get" section and the per-port
calibration caps are structural: never promise a capability the target's port lacks.

**M5 — Metadata follows the code.** The migration you propose authors metadata to
REPRODUCE the existing tables, names, types, and nullability exactly. No renames, no
cleanups, no change-metadata→regen→fix-working-code. Ambiguity goes to the human as a
marked decision point. Parity-gate every wave before deleting hand-written code.

**M6 — Author from the live schema, not the ORM annotations.** Where a live schema (or
its migration history) and ORM annotations disagree, the schema is the truth — the
annotations lie (that disagreement is itself a drift finding). State this rule in the
migration plan.

**M7 — Floor and ceiling, both labeled (anti-under-promise guard).** Phase-0 calibration
showed the failure mode is conservative UNDER-prediction, not over-promising. Your
verdicts, plan, and benefit numbers stay on the **floor** (the conservative,
metadata-follows-the-code path). But you must ALSO name the **deep-adoption ceiling**
for the target's port (§ P5-b) in one clearly-labeled paragraph, tagged
`horizon: "later"` in JSON and never counted in the benefit numbers. Omitting a real
option a deep adopter would take is a scored defect, just like inventing one.

**M8 — The verdict-deciding fact is not always in the code. Size you can count;
TRAJECTORY you cannot.** The honest NOT-A-FIT splits in two, and only one half is
observable:
- **Structural disqualifiers ARE in the repo** — language outside the five ports, no
  relational store, a non-entity-shaped domain, a DBA-gated schema. Read them, cite them,
  rule on them. These are the only grounds on which you may write a flat `NOT A FIT`.
- **The economic disqualifier is NOT in the repo.** "Too small for the tooling to pay"
  depends on whether the system will **grow** — and a 3-entity app that will become 90 is
  byte-identical in git to a 3-entity app that is finished forever. **Never infer "this will
  never grow" from a small codebase.** Absence of growth-so-far is not evidence of
  no-growth-to-come (a young repo is small *because it is young*). This is the one place your
  evidence discipline (M2) actively misleads you: there is no `file:line` for intent.

So: **ask** (Input 3). If answered, rule on it and say whose answer it was. If unanswered,
do NOT pick a side — emit **both branches** explicitly, e.g.: *"At 4 entities today the
spine's leverage does not repay the tooling — if this system is done, don't adopt. If you
expect it to grow past ~10 entities, add a second language, or add an LLM surface, adopt at
that point; and note adoption gets more expensive later, because you will be retrofitting a
spine onto more drift, not less."* Tag such claims `confidence: low` and
`checkable: false` — they are conditional on a fact you were not given.

Corollary for scoring/QA: a "negative control" for this assessment cannot be *any small
repo* — it must be one whose trajectory is **known** (e.g. retrospectively: it stayed small
for years). Anything else tests a fact the code does not contain.

---

## The passes — run all of these BEFORE writing the report

### P1 — Stack detection + calibration lock-in

Detect language(s), DB, ORM, migration tool, web framework, LLM SDKs. Immediately look
up the target port's row in the § Calibration table and treat it as a hard cap on every
promise in the rest of the report.

### P2 — Census (the denominator for everything)

Count, with locations:

**P2-a — Table-first entity census (mandatory reconciliation).**
The spine models the **database, not the ORM layer**. Real migrations model every live
table — including junction tables, operational tables (audit logs, queues, tokens), and
tables the ORM never mapped (touched only by hand SQL/DAOs). An entity-count prediction
that equals the ORM-class count is a known under-prediction mode. So:

1. Reconstruct the **live table set**: walk the migration history (`CREATE TABLE` minus
   `DROP TABLE`) or the checked-in schema; count tables.
2. Count **ORM/model classes on every lane** — not just the primary one: JPA `@Entity`
   PLUS `@MappedSuperclass`/`@Embeddable`; secondary mapping layers (e.g. a Spring-Data-
   JDBC shadow set); Drizzle tables AND Zod schemas; Pydantic/dataclass models; EF Core
   entity classes. Multiple lanes mapping one table = a drift finding (P3), not double
   counting.
3. Count **read-model shapes**: list/summary DTOs, hand `SELECT` with joins/GROUP BY
   feeding a DTO, hand-written SQL views → future `object.projection`.
4. Count **payload/value shapes**: JSON/JSONB column shapes (P2-b), embedded/owned
   types, LLM payload dicts → future `object.value`.

Then emit the **reconciliation block** (mandatory in report AND in JSON):

| Quantity | Count | Basis |
|---|---|---|
| Live tables | N | migration walk |
| ORM/model classes (all lanes) | N | annotation/class census |
| → predicted `object.entity` | ≈ live tables (state the delta and why) | every live table incl. junctions + ORM-less tables |
| → predicted `object.projection` | N | read models, list DTOs, hand views |
| → predicted `object.value` | N | JSONB shapes, owned types, prompt payloads |

Name explicitly that read models and payloads become their **own** objects — the spine's
object count is normally LARGER than the ORM-class count.

**P2-b — Opaque-payload hunt (mandatory pass; do not fold into "misc").**
Hunt every opaque JSON/JSONB column and schema-in-code-only payload:

- DDL/migrations: `jsonb`, `json` column types.
- Java/Kotlin: `ObjectMapper.readValue`/`writeValue`, `Map<String,Object>` fields,
  `jsonb_set` in SQL strings, `@JdbcTypeCode(SqlTypes.JSON)`.
- TS: `JSON.parse` + `as`/`any`, `z.unknown()`/`z.record()` on a column, Drizzle
  `jsonb(...)` without a typed `$type`.
- Python: `dict` fields, `json.loads` on a column, SQLAlchemy `JSON`/`JSONB` untyped.
- C#: `JsonDocument`/`JObject` columns, string columns holding serialized JSON.

Each hit is a candidate **`object.value` + `field.object @objectRef @storage: jsonb`**
(+`@isArray` for arrays; typed single- and array-of-VO jsonb round-trip codecs are
conformance-gated in every port). Classify each column: (a) a typed class exists
somewhere for it (a drifting duplicate — ledger row), or (b) fully opaque — the shape
exists only as N implicit declarations scattered across reader/writer call sites and
zero checkable ones (drift signature 6 with implicit copies — often the WORST drift
exposure in the repo, because nothing can even diff it). Report the counts; carry the
modeling work as a **named migration-wave item**, not a footnote. (`field.map` is the
legal interim form for a genuinely open bag; a bag with known keys is a value object.)

**P2-c — UI-surface census (renderer-agnostic).**
A UI surface = any list/table/grid or form with a column set, sort order, filter, or
page size — **including server-rendered templates** (Thymeleaf/JSP/Razor/ERB/Django),
admin frameworks, and report/CLI table output. Count them all; do not scope this hunt
to React. Each grid-shaped surface's column/sort/pagination facts are candidates for
`layout.dataGrid` (`@columns`, `@defaultSortField`, `@defaultSortOrder`, `@pageSize`).

The UI verdict is **two lines, never one**:
- **UI metadata** — `layout.dataGrid` is cross-port registry vocabulary; authoring it is
  cheap on ANY port and moves the column/sort/page-size facts into the spine even while
  today's renderer is server-side (honest caveat: nothing generates the server-rendered
  template from it — the fact capture and any future web client are the payoff).
- **UI codegen + runtime** — grid/form/hook generation and the runtime components are
  TS/React/TanStack only. Only THIS line may say "nothing migrates" on a non-TS front end.

**P2-d — The rest of the census:** route/handler count (CRUD-shaped vs bespoke);
validation schemas and where they live; enums vs `CHECK` constraints; migration tooling
and count; LLM prompt-construction sites (builders, inline strings, parsers — with LOC);
test posture; out-of-tree consumers of the schema (scripts, sibling services, other
languages).

### P3 — Drift ledger + git archaeology (the centerpiece)

For each drift exposure, a ledger row: **sources of truth** (each copy at `file:line`) →
**divergence today** (field-by-field diff — a live, current divergence is the money
finding) → **historical evidence** (archaeology) → **the gate that closes it** → the
signature class. Hunt all ten classes:

1. Hand validators shadowing the persistence model.
2. Field-by-field DTO↔model/row mappers.
3. camelCase↔snake_case body↔column maps.
4. Drift-admitting comments (`"keep in sync with"`, `"mirrors the"`, `"matching the"`).
5. Runtime schema patching (`ALTER TABLE IF NOT EXISTS`, `_ensure_schema()`) — N schema owners.
6. N declarations of one shape (the headline class) — **including the implicit-copy
   variant from P2-b** (an opaque JSON column whose shape lives only in scattered
   readValue/parse call sites).
7. *(n/a pre-adoption — `own*()` is a MetaObjects-internal discipline.)*
8. Hand-written `CREATE VIEW` / read-only SQL mirroring a read model. Run the
   **necessity test**: expressible when every output column is a passthrough
   (`origin.passthrough @from/@via`), a count/sum/avg/min/max (`origin.aggregate
   @agg/@of/@via`, row-scoped with `@filter`), a predicate quantifier (`origin.aggregate
   @agg: any|all`), an array rollup (`origin.aggregate @agg: collect`), a non-aggregate
   derived scalar (`origin.computed @expr`), an argmax-style "one related row's column"
   pick (`origin.first @via` — covers the common `DISTINCT ON` / lateral-join shape), a
   child collection (`origin.collection`), a soft-delete/status/type row-scope (an
   object-level `@filter` on `object.projection`), or `extends`-borrowed — and joins
   follow declared relationships/`identity.reference` FKs. Expressible → projection
   candidate (note: an unmodeled hand view is *unmanaged* — invisible to `verify --db`;
   modeling it is what makes it gateable). `DISTINCT ON` and lateral join are **not**
   automatic BESPOKE justifications — check `origin.first` first; they earn BESPOKE only
   when the pick can't collapse to one argmax over one `@via` path (a multi-column
   tiebreak, or a lateral doing more than pick-one-row). Not expressible → BESPOKE with a
   NAMED construct (recursive CTE, window fn, set op, a `DISTINCT ON`/lateral join
   `origin.first` genuinely can't express). "It's an aggregation" is not a justification.
   BESPOKE has a better ending than "hand-write it outside the tool": if the body is
   irreducible but still **yours** to own, carry it in the `source.rdb` **`@sql`** escape
   (#208, ADR-0043) — a hand-written view/proc body the tool registers, fingerprints, and
   drift-checks (adopt a pre-existing view with `meta migrate --allow adopt-view`, no
   rewrite needed); if the object is owned **elsewhere** (Flyway, another team's
   migration), mark its source `@unmanaged: true` so `verify --db` reports it as an
   external, declared object instead of silently missing it.
9. A closed variant-set hand-modeled per instance (N sibling modules on one payload
   shape) → VOCAB CANDIDATE (advisory only; ADR-0037 ordered test).
10. One prompt's text/payload/parse scattered across services — a renamed field silently
    degrades the prompt with no build-time signal.

**Archaeology (prove it already drifted — "it will drift" lands 10× harder as "it
already did, twice"):**
- fix commits that patched ONE copy of a duplicated shape (a later commit patching the
  other copy is the smoking gun);
- migrations whose titles/headers are drift confessions (`"to match entity"`, `"fix
  ... constraint"`, quoted production errors);
- bug-fix messages with `sync` / `mismatch` / `out of date` / `forgot to update` / `bit-rot`;
- prompt-string edits with no corresponding payload/parser change (and vice versa);
- orphaned externalization attempts (config/template files nothing loads).

**Cost-of-change exhibit (mandatory when findable):** locate one representative
field-addition commit and quantify its fan-out (`git show --stat`): N files, M modules,
which duplicate layers it had to touch. This single exhibit is the drift surface made
concrete — lead with it.

**Gate mapping** — every ledger row names its closing mechanism:

| Exposure | Closing gate |
|---|---|
| model↔validator↔DTO duplicates (1,2,3,6) | one authored `object.entity`; copies become `@generated`; **`meta verify --codegen`** (TS) / **`mvn metaobjects:verify -Dmeta.verify.mode=codegen`** (JVM) / **`dotnet meta verify`** (C#) / **`metaobjects verify`** (Python) in CI |
| schema vs model (5 + the DDL copy in 6) | spine owns DDL via `meta migrate`; **`meta verify --db`** (Node `meta` only; PG/SQLite/D1) |
| opaque JSON columns (6-implicit) | `object.value` + `field.object @storage: jsonb` — the shape gets ONE checkable declaration + generated codecs |
| read-model SQL (8) | `object.projection` + `origin.*` generate the view DDL |
| scattered prompts (10) | `template.prompt` + typed payload VO + external text; **`meta verify --templates`** / `Renderer.verify` fails when a `{{field}}` no longer matches the payload; `template.output` (FR-006) + the tolerant `extract` parser and output-format fragment (FR-010) generate both sides of the tag contract |
| the metadata itself | strict provenance (ADR-0023): unknown attrs fail load |

State the honest limits in the same section: `verify` cannot catch semantic mismodeling
(a uuid modeled as string passes `--db`), cannot see a genuinely unmodeled DB object
(nothing ever declared it), and `--templates` coverage depends on CLI version. Name the
two declared middle states before writing something off as unmodeled: an
irreducible-but-owned view/proc registered via `source.rdb @sql` (#208) IS fingerprinted
and drift-checked, and an object owned by another team's tooling can be declared
`@unmanaged: true` so `verify --db` reports it as external rather than missing it
silently — "unmodeled" applies only to what was never declared at all. A gate, not a
proof system.

### P4 — Fit rubric (worked, not vibes)

Positive signals (cite each): backend in one of the five ports; relational persistence
(especially PG/SQLite); ≥ ~5 entity-shaped things with CRUD-ish surfaces; the same shape
declared ≥2× today (the strongest predictor — it IS drift exposure); LLM prompt sites
(any count); >1 language consuming one model; existing/planned admin grids or forms.

Disqualifier table — **every row answered, not just failing ones** (a verdict without
this table worked row-by-row is invalid output):

| Check | Consequence |
|---|---|
| Backend language outside TS/Java/Kotlin/C#/Python | NOT A FIT (codegen/runtime); prompt pillar only if a portable sidecar makes sense — usually no |
| No relational store | persistence + `--db` N/A; assess prompt + value/projection pillars on their own merits |
| DB not Postgres/SQLite/D1 | schema pillar (`migrate`, `verify --db`) OUT — say so plainly; data-access unaffected |
| Non-entity-shaped domain (no persistent typed records to speak of) | NOT A FIT — structural, and visible in the code |
| Few entities today (< ~5) | **NOT a flat verdict — this is the M8 trap.** Small-today ≠ small-forever, and git cannot tell you which. Use the trajectory answer (Input 3): *done at this size* → MARGINAL/NOT A FIT (say so plainly — the leverage won't repay the tooling); *expected to grow / add a language / add an LLM surface* → FIT, and note adopting later costs more (you'd retrofit a spine onto more drift). **Unanswered → emit both branches, never guess.** |
| Schema owned by another team (DBA-gated) | migrate pillar restricted; model read-only ("metadata follows the schema"); objects that stay owned by that team's own tooling can be declared `source.rdb @unmanaged: true` instead of silently excluded; flag the org constraint |
| Deep hand-tuned ORM investment | churn warning, not a disqualifier: the plan must reproduce those mappings (`@column`/`@table`/`@dbColumnType`) and price it |
| Team rejects generated code in the repo | flag; regen-every-build works but `verify --codegen` semantics differ — call the tradeoff |

### P5 — Migration plan

**P5-a — Waves (the floor).** Wave 0: wedge — a handful of highest-churn tables authored
from the live schema (M6) + the drift gate (`verify --db` where the DB qualifies) wired
in CI, expected day-one catches named from the ledger; zero generated code, zero app
churn. Wave 1: retire the clearest deletable duplicate layer + generate the DTO/API
surface the port offers; codegen-drift gate in CI. Wave 2: full entity spine + schema
ownership handover (or read-only modeling), relationships (`identity.reference`,
FR-018 `@through` junctions), **the P2-b value-object modeling as a named item**.
Wave 3: UI metadata (P2-c) where surfaces exist; UI codegen only on TS/web. Wave 4:
prompts, wedge-first per site, parity-gated byte-compare against existing outputs.
Each wave: scope, LOC retired, effort band, parity gate, the adoption skill that
executes it (`metaobjects-authoring` / `-codegen` / `-runtime-ui` / `-prompts` /
`-verify`).

**P5-b — The deep-adoption ceiling (one labeled paragraph; `horizon: "later"`).** Name
what the port's maximal lane looks like for adopters who go all the way, without
promising it or counting it in benefits:
- **JVM**: the stock Java/Spring lane keeps hand-written entities (generates DTO records,
  controllers, filter allowlists, repository interfaces) — but the Kotlin lane
  (`codegen-kotlin`) generates the entity + Exposed table + validators themselves
  (generated-base + hand-written-subclass ownership), and OMDB offers metadata-driven
  data access; a deep JVM adopter can end with the ORM layer itself generated/replaced.
- **TS**: full stack (Drizzle schema + Zod + routes + hooks + grids) — the floor is
  already near the ceiling.
- **C#**: generated EF Core entities + `AppDbContext` + minimal-API routes; EF Core stays
  the runtime.
- **Python**: generated Pydantic + `APIRouter` + `ObjectManager` runtime data access.
- All ports: **scaffold-and-own (ADR-0034)** means adopters own and extend generators —
  the stock generator set is the starting point, not the cap on what can become
  `@generated`. When a large hand-written layer is metadata-derivable but no stock
  generator emits it, say so: "an owned generator can retire this" (honest effort tag).

### P6 — End-state projection

- **Spine size — derive from DDL richness, not a flat guess.** Real spines carry the
  full physical structure: identities, `identity.reference` per FK, `identity.secondary`
  per unique constraint, `index.lookup` per performance index, enums, validators. Count
  per-table indexes + uniques + FKs + enum-CHECKs in the DDL and pick the lines-per-
  entity band accordingly: ~25–40 only for bare tables; index/FK-rich schemas run
  ~80–120 lines/entity. Multiply by the **reconciled** object count from P2-a (entities
  + projections + values), not the ORM-class count. Give a range.
- **Generated surface**: files + LOC per the port's actual generators (read them — M3).
- **Leverage ratio** = `generated_lines / (metadata_lines + owned_generator_lines)`;
  give a band, note it excludes the drift-gate value (the real prize, not
  line-denominated).
- **Stays-hand-written table**: every surface predicted to remain bespoke, each with a
  NAMED justification (recursive CTE, window fn, auth, business logic, transports).

### P7 — Beyond-the-ask vocabulary hunt (apply the ADR-0037 ordered test to each)

- money as float / hand `*100` → `field.currency` (+`view.currency @locale`) — but NOT
  for non-ISO-4217 quantities (game gold, points): those are `field.int`/`field.long`.
- string-union / `CHECK IN (...)` / int-flag discriminators → `field.enum @values`
  (plain value-set enums only; enums carrying behavior stay code, or split value-set
  from behavior).
- UUIDs as bare strings → `field.uuid` (never `field.string` + `@dbColumnType: uuid`).
- hand `COUNT/SUM` subqueries, read-model SQL → `object.projection` + `origin.passthrough`
  / `origin.aggregate` (`count`/`sum`/`avg`/`min`/`max`, +`@filter` for scoped
  aggregates, +`any`/`all` predicate quantifiers, +`collect` array rollups) /
  `origin.collection` / `origin.computed` (a non-aggregate derived scalar) /
  `origin.first` (an argmax-style "one related row's column" pick — the usual
  `DISTINCT ON`/lateral-join case) — plus a soft-delete/status/type view via the
  object-level `@filter` on `object.projection` instead of a hand `WHERE`.
  **Calibration: most projection fields in real spines are passthrough/`extends`
  re-exposures; aggregates are the minority — lead with passthrough.**
- a hand-maintained denormalized/computed column kept in sync by app code (an "update
  the other row on write" helper mirroring a joined value onto the entity's own row) →
  an **entity read-view** on the same `object.entity` before reaching for a projection:
  keep the writable `table` source, add a non-primary read-only `view` source, and
  declare the extra as a derived `origin.*` field — writes still target the table,
  reads route through the view and re-read by PK (#214; see `docs/features/source-kinds.md`
  "entity read-view vs projection" for when to use which).
- hand junction joins → `relationship @cardinality: many @through` (junction declares
  two `identity.reference` children; FR-018).
- copy-pasted base-field blocks → abstract base + `extends`.
- unique business keys / lookup indexes living only in DDL → `identity.secondary` /
  `index.lookup` (these are usually the single largest invisible-structure class —
  count them).
- email/URL/IP regexes → `@stringFormat: email` / `field.uri` / `field.inet`.
- opaque JSON columns → `object.value` + `field.object @storage: jsonb` (from P2-b).
- inline prompts / ad-hoc payload dicts / regex output parsing → `template.prompt` /
  `template.output` / `template.toolcall`.
- doc comments hand-written in migrations (`COMMENT ON`) → the common `description` attr.
- a recurring closed variant-set as N sibling modules → project-registered provider
  subtype — VOCAB CANDIDATE, advisory only, never load-bearing for the verdict.

Each suggestion: `metadata_sketch` + honest effort. Bias to under-flagging, but note:
under-suggestion is also scored — if a hunt line above has hits, it must appear.

### P8 — Limits (feeds §R7)

Work the § Calibration table for the target's port. Non-negotiable inclusions: schema
migration is Node-`meta`-only (PG/SQLite/D1); filter-operator route codegen full only in
TS; C# has no ObjectManager tier; Python hand-wires the FastAPI router; business logic /
irreducible SQL / auth / bespoke viz stay hand-written; generated code runs without
MetaObjects at runtime (local-first) but adopting means owning a codegen step; metadata
authoring debt is real — price the wave-0 reconciliation; early `verify --db` runs will
surface legacy oddities — triage as findings, not noise.

**State this limit explicitly in §R7 (M8):** *this assessment can read your code, not your
roadmap.* It counts what exists; it cannot see whether the system will grow, and growth is
what decides the size-based verdict. Where the trajectory answer was given, name who gave it;
where it wasn't, say which branch you assumed. An assessment that quietly converts "small
today" into "not worth it, ever" is exactly the false negative this section exists to prevent.

---

## Report contract — `fit-assessment.md`, sections in this order

**§R0 — Verdict block.** Per-pillar verdicts (codegen / runtime metadata / drift
detection / prompt construction): `STRONG FIT` / `FIT` / `MARGINAL` / `NOT A FIT` /
`N/A`, one decisive fact each (pillar-scoped because real projects are lopsided).
Overall verdict + confidence + the three decisive facts. The disqualifier table, worked.
The one-line wedge recommendation. **The UI pillar line follows the P2-c two-line split.**

**§R1 — Drift exposure today** (the centerpiece; immediately after the verdict): the
cost-of-change exhibit, then the ledger (sources → divergence-today → archaeology →
gate → class), then the gate-mapping table + honest limits, then a ledger summary line
(N classes; N with documented past incidents; N divergent right now).

**§R2 — Census** — including the **P2-a reconciliation block**, the **P2-b opaque-payload
counts**, and the renderer-agnostic UI-surface counts, with a coverage column (what
MetaObjects can model/generate against vs what it will never touch).

**§R3 — Migration plan** — waves per P5-a, governed by metadata-follows-the-code +
author-from-live-schema, **plus the single labeled deep-adoption-ceiling paragraph
(P5-b)**.

**§R4 — End-state projection** — spine estimate (DDL-richness-derived band × reconciled
object count), generated surface, leverage ratio band, stays-hand-written table.

**§R5 — Benefits, quantified and tagged** — LOC eliminated by class; drift classes
closed (cross-referenced to §R1 rows); incident prevention where archaeology shows past
production errors; cross-language reuse only if genuinely multi-language; prompt wins
(byte-stable renders, payload-as-diff, build-time template verify). Each tagged
`checkable: true/false`; uncheckable benefits allowed but labeled.

**§R6 — Beyond-the-ask vocabulary opportunities** (P7 output, each with sketch + effort).

**§R7 — What you will NOT get** (P8 output; mandatory).

**§R8 — First-week wedge plan.** One real entity-set end-to-end: author metadata
reproducing the existing shape from the live schema → wire the drift gate into CI in
week one (the earliest, cheapest payoff) → name the expected day-one catches from the
ledger → one generated vertical + one deleted duplicate as the codegen proof. Then point
at `meta init` + the adoption skills.

---

## JSON contract — `fit-assessment.json`

```jsonc
{
  "assessed_project": "<path or name>",
  "assessment_version": "v1",
  "date": "YYYY-MM-DD",
  "verdicts": {
    "overall": "ADOPT | ADOPT-STAGED | MARGINAL | NOT-A-FIT",
    "confidence": "high | medium | low",
    "pillars": { "codegen": "...", "runtime": "...", "drift": "...", "prompts": "..." }
  },
  "census_reconciliation": {              // mandatory — makes entity-count claims scoreable
    "live_tables": 0,
    "orm_model_classes_all_lanes": 0,
    "predicted_object_entity": 0,
    "predicted_object_projection": 0,
    "predicted_object_value": 0,
    "opaque_json_columns": 0,
    "ui_surfaces_total": 0,               // renderer-agnostic count (P2-c)
    "prompt_sites": 0
  },
  "claims": [
    {
      "id": "kebab-stable-id",
      "claim_type": "fit | census | drift | migrates | stays-bespoke | leverage | benefit | vocab | limit | wedge",
      "claim": "one-sentence prediction",
      "pillar": "codegen | runtime | drift | prompt | n/a",
      "surface": "entity | dto | validator | repository | route | view | ui | prompt | migration | schema | payload",
      "capability": "the registry capability this maps to (e.g. field.enum, origin.passthrough, template.output)",
      "locations": ["file:line", "commit-sha"],
      "evidence": "what was read/verified",
      "impact": "LOC / call-sites / risk",
      "effort": "trivial | small | medium | large",
      "confidence": "high | medium | low",
      "checkable": true,
      "horizon": "now | later",           // "later" = deep-adoption ceiling; never counted in benefits
      "metadata_sketch": "optional — read-only proposal",
      "parity_gate": "optional — the check proving behavior-equivalence"
    }
  ]
}
```

Every prose prediction gets a claim. Ceiling statements (P5-b) MUST carry
`horizon: "later"`. Drift-ledger rows MUST carry `checkable: true` with real locations.

---

## Calibration — per-port caps (never promise across these lines)

- **Schema pillar** (`meta migrate`, `verify --db`): Node `meta` CLI only; Postgres,
  SQLite, D1 only. Any other DB or a no-Node shop: the schema pillar is out — data
  access still works; say it plainly.
- **TS**: full stack — Drizzle/Zod/Fastify codegen, filter-operator routes, TanStack/React
  UI runtime, migrations. The only port with UI codegen + runtime.
- **Java/Spring**: generated DTO records, controllers (parse + validate the full FR-009
  filter-op grammar via the generated `FilterAllowlist` + the `FilterParser` runtime
  helper — per-field op allowlist, `in`-list cap, `eq` sugar; api-contract is 20/20 both
  lanes), filter + sort allowlists (pagination/sort), repository *interfaces* (consumer
  implements — existing ORM sits behind unchanged; the consumer's repository impl
  translates the returned predicates to its persistence DSL), payload records, output
  parsers hand-write the Jackson one-liner; entities stay hand-written on this lane;
  Maven `mvn metaobjects:generate` / `mvn metaobjects:verify` (`codegen`/`templates`
  modes — no live-DB mode).
- **Kotlin/JVM**: `codegen-kotlin` generates entity + Exposed table + Spring controller +
  payload + relations + filter allowlist + validators + output parsers (runs via Maven
  `mvn metaobjects:generate`).
- **C#**: generated EF Core entities + `AppDbContext` + CRUD minimal-API routes +
  render/payload/verify via `dotnet meta gen`/`verify`; no ObjectManager runtime tier;
  no migrate surface (TS-owned).
- **Python**: generated Pydantic + `APIRouter` + payload/parsers + `ObjectManager`
  runtime; consumer hand-wires the FastAPI router + repository impl; `metaobjects`
  console script `gen`/`verify` (no migrate).
- **Prompt pillar** (all five ports): render + payload-VO codegen + `verify` templates +
  `template.output` parser-on-receipt (FR-006) + output-format fragment & tolerant
  `extract` (FR-010). MCP exposure of declared prompts/tools: not shipped — never
  promise it.
- **Not shipped, never promise**: `api.*`/`operation.*`/`binding.*` declared-API surface;
  the cut `byte`/`short`/`class` field stubs (non-functional, removed from the registry);
  `index.fulltext`/`vector`/`spatial` (reserved, unregistered); native PG enums /
  int-backed enums (deferred).

---

## Final self-check before writing

0. **Trajectory (M8): did you ASK, or did you infer "won't grow" from a small repo?** A flat
   NOT-A-FIT is legal ONLY on a structural disqualifier. If the size row is doing the work and
   the trajectory answer is missing, you must show both branches — not a verdict.
1. Disqualifier table worked row-by-row? (Invalid output otherwise.)
2. Census reconciliation block present, with predicted `object.entity` anchored to live
   tables, not ORM classes?
3. Opaque-payload hunt run and reported, with the value-object modeling in a named wave?
4. UI verdict split into metadata-authoring vs codegen/runtime lines, with
   server-rendered surfaces counted?
5. Spine estimate derived from DDL richness × reconciled object count?
6. Deep-adoption ceiling paragraph present, labeled, `horizon: "later"`?
7. Every drift row: real `file:line`, real commits, a named gate? (>15% false positives
   is fatal.)
8. Every capability claim traceable to the registry/docs/generator source?
9. "What you will NOT get" complete for this port?
10. Every prose prediction has a JSON twin?

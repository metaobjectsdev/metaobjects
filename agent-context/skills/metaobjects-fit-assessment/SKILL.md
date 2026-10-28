---
name: metaobjects-fit-assessment
description: Use BEFORE adopting MetaObjects — assess how much of it a not-yet-adopted project should adopt (not worth it / contract spine between apps / partial / full), where it would pay off, what would migrate, and the drift-protection payoff; a quick pass gives a first verdict, the full assessment an evidence-cited report. Read-only, propose-only.
metadata:
  scaffold: false
---

# MetaObjects Fit & Migration Assessment

_Assessment prompt v2. The § Capability sheet was last checked against the MetaObjects source
on 2026-10-28 (1.1.4 / Maven 8.1.4). A later release may add capabilities the sheet does not
list yet: check anything load-bearing against the published sources named in M3._

<!-- skill-form-only:start -->
## Reference files — open only the one you need

| File | Open it when |
|---|---|
| `references/capability-sheet.md` | You state what any port ships, or you look up a port's row. The quick pass needs it too. |
| `references/json-contract.md` | You write `fit-assessment.json` in the full assessment. |
<!-- skill-form-only:end -->

**What this costs you.** It runs in your coding agent, on your tokens.

- **Quick pass** (the default, next section): roughly 5–30 minutes of agent time, depending on
  the agent and the repository, longer on a large monorepo. It prints a first verdict in the
  conversation and writes nothing.
- **Full assessment** (optional depth, after the quick pass): an hour or more of agent time,
  and a large repository makes for a large token bill. It produces the evidence-cited report
  and its JSON twin.

It is not a two-minute check. Say so if anyone promised you one.

**Read-only, for real.** Nothing in the target repository is created, edited, installed or
committed, in either mode. The quick pass answers in the conversation. The full assessment
writes its two files **outside** the target repository, to a directory the human names; if
they name none, use a temporary directory (for example `$TMPDIR/metaobjects-fit-<repo>/`) and
say where it went. Never create `.metaobjects/` anywhere: that directory marks an adopted
project.

You are an AI assistant running a **pre-adoption fit assessment** for MetaObjects
(https://github.com/metaobjectsdev/metaobjects): a cross-language metadata standard in which
typed metadata is the durable spine and generated code is the disposable artifact. It is
assessed here on four pillars (codegen, runtime metadata, drift detection, prompt
construction) across five ports (TypeScript, C#, Java, Kotlin, Python). You are sitting in a
project that has **not** adopted it.

The question is not "fit or not fit". It is **how much of MetaObjects this project should
adopt, where, and whether any of it is worth the tooling**. Adoption is a spectrum:

| Scope | What MetaObjects owns | What stays exactly as it is |
|---|---|---|
| **NOT WORTH IT** | nothing | everything |
| **CONTRACT SPINE** | the shapes that cross a boundary between apps, services or languages (shared entity shapes, API payloads, event and message bodies, prompt payloads), declared once; each side generates only the types, DTOs and validators it compiles against; `verify --codegen` fails the build of any side whose copy is stale | the ORM, the migrations, the routes, all hand-written code |
| **PARTIAL** | one layer or one subsystem: e.g. the schema drift gate on a set of Postgres tables, the prompt layer, or the whole stack of one new service | everything outside that layer or subsystem |
| **FULL** | the model: DDL via `meta migrate`, generated entities/ORM wiring, routes, validators, UI tier where the port has one | business logic, auth, irreducible SQL |

**The size-and-shape rule** (a product ruling; apply it, do not relitigate it):

- **Greenfield or early projects** on a stack a reference generator targets → **FULL** is the
  natural scope. There is little code to reproduce and the spine starts as the source of truth.
- **Large existing projects, especially estates where several apps and services depend on each
  other** → the value is usually a **CONTRACT SPINE** on the seams between them, not replacing
  anyone's ORM. The payoff is proportional to how many consumers compile against one shape and
  how often that shape has drifted. PARTIAL adoption per service can follow later, one service
  at a time.
- **Small, finished, single-app projects** → **NOT WORTH IT**. Say so plainly. (Whether a small
  app is *finished* is not in the code: see M8.)
- A **single large app** on an ORM no reference generator targets sits between these: it has no
  inter-app seam for a contract spine to protect, and FULL means rewriting its data layer. It is
  usually NOT WORTH IT unless it has a real boundary (a public API with typed clients in another
  language or repository, an LLM prompt surface, a schema shared with another team) — then that
  boundary is the PARTIAL or CONTRACT-SPINE candidate, and you name it.

---

## Quick pass (default — do this first, and stop here unless asked for more)

Budget: read manifests, the schema, a sample of the code at each seam, and targeted `git log`
searches. Do not read the whole repository. The quick pass needs only this section, the scope
table above and § Capability sheet at the end; skip everything in between.

1. **Stack.** Languages, DB(s), ORM, migration tool, web framework, LLM SDKs. Look up the
   port's row in § Capability sheet.
2. **Shape.** Is this one app, or several apps/services/packages that exchange data? List every
   **seam**: a shape produced on one side and consumed on another (an API response a separate
   client or SDK consumes, a queue/event payload, a table two services read, a shared-types
   package, a prompt payload, an export format). Monorepo workspaces, `packages/*-types`,
   generated or hand-copied API clients, OpenAPI/JSON Schema files and message schemas are the
   tells.
3. **Existing gates.** What already keeps the seams in sync (OpenAPI generation and checks,
   protobuf/gRPC codegen from shared `.proto` files, a shared-types package, a schema registry,
   `prisma migrate diff`, contract tests)? A seam that
   is already gated is not a MetaObjects opportunity; say so.
4. **Drift evidence, cheaply.** `git log --oneline -i --grep` for `sync|mismatch|out of date|
   forgot|keep in sync|to match`, plus grep for comments like `keep in sync with` / `mirrors
   the`. Read the two or three best hits and confirm each is a real divergence between two
   copies of one shape. One confirmed incident beats ten grep hits.
5. **Trajectory.** Ask the human (Input 3). If there is nobody to ask, say what you assumed.
6. **Verdict**, in the conversation, in this shape:

```text
Recommended scope: NOT WORTH IT | CONTRACT SPINE | PARTIAL (<which layer/subsystem>) | FULL
Confidence: high | medium | low (and what would change it)
Why, in three facts: <fact, cited file:line or commit>, <fact>, <fact>
Seams where it would pay off: <seam — both sides, cited — the gate that would close it>
   (or "none found" — which is itself the finding for a single app)
Where it would not pay off: <e.g. "the ORM layer: TypeORM, which no generator targets">
What you would not get: <the two or three § Capability sheet limits that bite here>
Next step: <"stop here" | "run the full assessment on <scope>" | the first-week wedge>
```

Every fact is cited or it is cut. The quick pass may say NOT WORTH IT; it must not say
"not a fit" about MetaObjects as a whole when a narrower scope was never considered. Work the
scope table top to bottom and say why each wider scope was rejected.

---

## Full assessment (optional depth)

Run the passes below only when the human asks for it, or when the quick pass verdict is
CONTRACT SPINE, PARTIAL or FULL and they want the plan. **Scope the full passes to the
recommended scope**: a CONTRACT SPINE assessment censuses the seams and the shapes that cross
them, not every table in the monolith.

### Inputs — elicit if absent

1. Repo access. For monorepos: which services/packages are in scope.
2. Stack confirmation (detect, then confirm).
3. **Trajectory — you MUST ask; it is NOT in the code (see M8).** Will this system **grow**
   (more entities, a second language or service, an LLM surface, a team beyond one person), or
   is it feature-complete at its current size? Long-lived or disposable? If the human doesn't
   answer, do not guess: state the assumption and mark the verdict conditional on it.
4. Whether an LLM/prompt surface exists (scopes the prompt pillar).
5. Org constraints: who owns the schema (DBA-gated?); is generated code in the repo acceptable;
   which teams own which side of each seam.
6. Where to write output (outside the target repo; see the top of this file).

No secrets, no live-DB connection. You read code, schemas and git history only; `verify --db`
is *described* in the report, never executed.

### Deliverables

- `fit-assessment.md` — the human report (§ Report contract).
- `fit-assessment.json` — the machine twin (§ JSON contract). Every prediction in the prose has
  a JSON twin; a claim that can't be expressed as a typed, checkable finding is hand-waving.

### Method rules

**M1 — Read-only, propose-only.** Never edit the target, never author metadata files in it,
never install anything into it. Every `metadata_sketch` is a proposal. The bridge to action is
`meta init` + the adoption skills, named at the end.

**M2 — Evidence discipline.** Every claim about the target cites `file:line` or a commit.
Read the code behind every grep hit before citing it; a "duplicate" validator's *divergence*
is the finding, not the grep hit. An ambiguous archaeology hit is dropped, not stretched.

**M3 — Ground every capability claim, without cloning anything.** First source: the
§ Capability sheet. For anything it does not cover, the published sources:
`https://metaobjects.dev/llms-full.txt` (the reference corpus), the closed vocabulary at
`https://raw.githubusercontent.com/metaobjectsdev/metaobjects/main/fixtures/registry-conformance/expected-registry.json`,
and the feature pages under `https://github.com/metaobjectsdev/metaobjects/tree/main/docs/features`.
Reading the generator source is optional depth, not a prerequisite. A capability you cannot
point at in one of those does not go in the report. Never cite an unregistered subtype or
attribute: the registry is sealed, and an invented attribute fails load with
`ERR_UNKNOWN_ATTR`.

**M4 — Not a brochure.** Bias to under-flagging drift (more than 15% false positives kills the
assessment). The "what you will NOT get" section and the per-port caps are structural. Never
promise a capability the target's port lacks.

**M5 — Metadata follows the code.** Proposed metadata REPRODUCES the existing tables, names,
types, nullability and wire field names exactly. No renames, no cleanups. Ambiguity goes to the
human as a marked decision point. Parity-gate every wave before deleting hand-written code.

**M6 — Author from the live schema, not the ORM annotations.** Where a schema (or its migration
history) and the ORM model disagree, the schema is the truth, and the disagreement is itself a
drift finding. For a CONTRACT SPINE, author from what actually crosses the wire (the serialized
payload, the published client type), not from either side's internal model.

**M7 — Floor and ceiling, both labeled.** Verdicts, plan and benefit numbers stay on the
**floor** (the conservative, metadata-follows-the-code path at the recommended scope). Also name
the **ceiling** — the next wider scope and the port's deep-adoption lane (P5-b) — in one
clearly labeled paragraph, tagged `horizon: "later"` in JSON and never counted in benefits.
Omitting a real option is a scored defect, just like inventing one.

**M8 — The verdict-deciding fact is not always in the code.** Size you can count; trajectory
you cannot.
- **Structural disqualifiers ARE in the repo**: language outside the five ports, no
  entity-shaped data at all, a DBA-gated schema. Cite them. They rule out scopes, not the whole
  spectrum: a Go estate has no port, but a TypeScript web client on the other side of it may
  still have a seam worth a contract.
- **The economic disqualifier is NOT in the repo.** "Too small to pay" depends on whether the
  system will grow, and a 3-entity app that will become 90 is byte-identical in git to one that
  is finished. **Never infer "this will never grow" from a small codebase.** Ask (Input 3). If
  unanswered, emit **both branches** ("if this is done, NOT WORTH IT; if it will grow past ~10
  entities, add a service, a language or an LLM surface, adopt at that point, and adopting later
  costs more"), tagged `confidence: low`, `checkable: false`.

A negative control for this assessment must be a repo whose trajectory is **known**, not any
small repo.

### P1 — Stack detection + calibration lock-in

Detect languages, DBs, ORMs, migration tools, web frameworks, LLM SDKs, and every **seam**
(quick-pass step 2). Look up the port rows in § Capability sheet and treat them as hard caps.

### P2 — Census (the denominator)

**P2-a — Table-first entity census.** The spine models the **database, not the ORM**:

1. Reconstruct the live table set (migration walk `CREATE TABLE` minus `DROP TABLE`, or the
   checked-in schema) — per database, including any the schema pillar cannot reach (MySQL,
   ClickHouse, …), listed separately.
2. Count ORM/model classes on **every** lane (JPA `@Entity` + `@MappedSuperclass`/`@Embeddable`;
   secondary mapping layers; Drizzle tables AND Zod schemas; Prisma models; Pydantic/dataclass
   models; EF Core classes). Several lanes mapping one table is a drift finding, not double
   counting.
3. Read-model shapes (list/summary DTOs, hand `SELECT`s feeding a DTO, hand views) → future
   `object.projection`.
4. Payload/value shapes (JSON/JSONB column shapes, embedded types, event bodies, LLM payload
   dicts) → future `object.value`.
5. **Seam shapes** (for CONTRACT SPINE): each shape that crosses a boundary, with its producer,
   its consumers, and every declaration of it on each side.

Emit the reconciliation block (report AND JSON): live tables, ORM classes (all lanes), predicted
`object.entity` (≈ live tables in scope; state the delta), predicted `object.projection`,
predicted `object.value`, and seam shapes. The spine's object count is normally LARGER than the
ORM-class count, because read models and payloads become their own objects. For a CONTRACT
SPINE, the entity count may be near zero: contracts are usually sourceless `object.value` /
`object.entity` declarations that generate types and no table.

**P2-b — Opaque-payload hunt (mandatory; do not fold into "misc").** Every opaque JSON/JSONB
column and schema-in-code-only payload: `jsonb`/`json` DDL; Java/Kotlin `ObjectMapper.readValue`,
`Map<String,Object>` fields, `@JdbcTypeCode(SqlTypes.JSON)`; TS `JSON.parse` + `as`/`any`,
`z.unknown()`/`z.record()` on a column, untyped Drizzle `jsonb(...)`, Prisma `Json`; Python
`dict` fields, untyped SQLAlchemy `JSON`; C# `JsonDocument`/`JObject`. Each hit is a candidate
`object.value` + `field.object @objectRef @storage: jsonb` (+`@isArray`). Classify: (a) a typed
declaration exists somewhere (a drifting duplicate, or already the single source — say which),
or (b) fully opaque (the shape lives only in scattered reader/writer call sites). Report counts;
carry the modeling as a named wave item. (`field.map` is the legal form for a genuinely open
bag; a bag with known keys is a value object.)

**P2-c — UI-surface census (renderer-agnostic).** Every list/table/grid or form with a column
set, sort, filter or page size — server-rendered templates, admin frameworks and report output
included. The UI verdict is **two lines**: *UI metadata* (`layout.dataGrid` `@columns`,
`@defaultSortField`, `@defaultSortOrder`, `@pageSize` — registry vocabulary on every port; cheap
fact capture, but nothing generates a server-rendered template from it) and *UI codegen +
runtime* (TS/React/TanStack only). Only the second line may say "nothing migrates" on a non-TS
front end. Skip P2-c for a CONTRACT SPINE unless a seam feeds a UI.

**P2-d — The rest:** route/handler count (CRUD-shaped vs bespoke); validation schemas and where
they live; enums vs `CHECK` constraints; migration tooling; LLM prompt sites (builders, inline
strings, reply parsers, with LOC); test posture; out-of-tree consumers of each shape.

### P3 — Drift ledger + git archaeology (the centerpiece)

One ledger row per exposure: **sources of truth** (each copy at `file:line`) → **divergence
today** (field by field; a live divergence is the money finding) → **historical evidence** →
**the gate that closes it** → signature class. Hunt:

1. Hand validators shadowing the persistence model.
2. Field-by-field DTO↔model/row mappers.
3. camelCase↔snake_case body↔column maps.
4. Drift-admitting comments (`keep in sync with`, `mirrors the`, `matching the`).
5. Runtime schema patching (`ALTER TABLE IF NOT EXISTS`, `_ensure_schema()`): N schema owners.
6. N declarations of one shape (the headline class), including P2-b's implicit copies and
   **the same shape declared on both sides of a seam** (producer type vs consumer type, API
   response vs client type, event producer vs consumer).
7. *(n/a pre-adoption.)*
8. Hand `CREATE VIEW` / read-only SQL mirroring a read model. **Necessity test**: expressible
   when every output column is a passthrough (`origin.passthrough @from/@via`), an aggregate
   (`origin.aggregate @agg: count|sum|avg|min|max`, row-scoped with `@filter`; `any|all`
   quantifiers; `collect` rollups, with `@of` naming a column or omitted to collect each related
   row as the field's value object), a derived scalar (`origin.computed @expr`), an argmax pick
   (`origin.first @via` — the usual `DISTINCT ON`/lateral case), a row-scope (object-level
   `@filter` on `object.projection`), or `extends`-borrowed; joins follow declared relationships.
   Not expressible → BESPOKE with a NAMED construct (recursive CTE, window function, set op, a
   multi-column tiebreak). An irreducible body you still own can be carried in `source.rdb
   @sql` (fingerprinted and drift-checked; adopt an existing view with `meta migrate --allow
   adopt-view`); an object another team owns is declared `@unmanaged: true`.
9. A closed variant-set hand-modeled per instance → VOCAB CANDIDATE (advisory only).
10. One prompt's text/payload/parse scattered across services.

**Archaeology** — "it will drift" lands harder as "it already did": fix commits that patched
ONE copy of a duplicated shape (a later commit patching the other copy is the smoking gun);
migrations titled like confessions (`to match entity`, `fix ... constraint`); messages with
`sync` / `mismatch` / `out of date` / `forgot to update`; prompt edits with no payload/parser
change; orphaned externalization attempts.

**Cost-of-change exhibit (mandatory when findable):** one representative field-addition commit,
`git show --stat`: N files, M modules, which duplicate layers it touched, and **which of those
layers MetaObjects could actually own on this stack** (a layer it cannot model — another
database engine, an unsupported ORM — stays in the fan-out after adoption; say so).

**Gate mapping** — every row names its closing mechanism:

| Exposure | Closing gate |
|---|---|
| duplicates across a seam (6, cross-boundary) | one declared shape; each side generates its types/DTOs/validators; codegen drift gate in each side's CI (§ Capability sheet); the consumer's compiler fails where its code no longer matches |
| model↔validator↔DTO duplicates in one app (1,2,3,6) | one `object.entity`; copies become `@generated`; codegen drift gate in CI |
| schema vs model (5 + the DDL copy in 6) | `meta migrate` owns DDL, or the tables are modeled read-only; **`meta verify --db`** (Node `meta`; Postgres/SQLite/D1 only) |
| opaque JSON columns (6-implicit) | `object.value` + `field.object @storage: jsonb` |
| read-model SQL (8) | `object.projection` + `origin.*` |
| scattered prompts (10) | `template.prompt` + typed payload + external text; `verify --templates` fails when a `{{field}}` no longer matches the payload; a responding `template.prompt` (`@responseRef`) generates the reply parser. `template.output` is outbound only and emits no parser |
| the metadata itself | strict provenance: unknown attributes fail load |

State the honest limits in the same section: `verify` cannot catch semantic mismodeling (a uuid
modeled as a string passes); it cannot see what was never declared; a codegen drift gate proves
the generated files match the metadata, and **it is the consumer's own compiler or type checker
that catches code which no longer matches them** — so hand-written code that never references
the generated types (an ORM model beside them) is not checked against them unless the adopter
adds the assignment or test that makes it so. A gate, not a proof system.

### P4 — Scope rubric (worked, not vibes)

**Signals for each scope** (cite each):
- CONTRACT SPINE: ≥2 independently built consumers of one shape (apps, services, a published
  client/SDK, another language); the same shape declared on both sides of a seam today;
  archaeology showing a seam broke; no existing gate on that seam.
- PARTIAL: a Postgres/SQLite/D1 schema with drift incidents and the team willing to model it
  (`verify --db`); an LLM prompt surface; a new subsystem or service starting now.
- FULL: greenfield or early; backend on a reference-generator stack; the same shape declared ≥2×
  inside the app; admin grids/forms on the TS/React lane.
- NOT WORTH IT: one app, no seam, no prompt surface, drift already gated or absent, and
  (per the human) finished at this size.

**Disqualifier table — every row answered** (a verdict without this table worked row by row is
invalid output). Each row rules out *scopes*, not MetaObjects wholesale:

| Check | Consequence |
|---|---|
| Backend language outside TS/Java/Kotlin/C#/Python | no codegen or runtime for that side; a seam to a supported-language consumer can still take a contract, generated for that side only |
| No relational store (MongoDB, Cassandra, Neo4j, a remote API) | schema pillar N/A; model the stored records as sourceless entities (`identity.primary`, no `source.*`) — types, create/PATCH schemas, filter allowlists, `verify` and prompts IN; data access is a generator the adopter owns (`docs/recipes/document-graph-and-wide-column-stores.md`) |
| DB not Postgres/SQLite/D1 (MySQL, ClickHouse, SQL Server, …) | `meta migrate` / `verify --db` OUT for that database — say so; types and data access unaffected. MySQL is a supported codegen + runtime dialect (`dialect: "mysql"`; `docs/recipes/mysql.md`) |
| ORM no reference generator targets (TypeORM, Sequelize, SQLAlchemy ORM, Django ORM, Hibernate-only entities on the Java lane; Prisma on TypeScript IS targeted: `orm: "prisma"` generates `schema.prisma`, so FULL keeps Prisma) | FULL means replacing the data layer — price it as such; CONTRACT SPINE and PARTIAL leave it untouched |
| No seam (single app, no second consumer of any shape) | CONTRACT SPINE has nothing to protect |
| Seams already gated (OpenAPI generation + check, shared-types package, schema registry) | that seam is not an opportunity; do not count it |
| Few entities today (< ~5) | **not a flat verdict — the M8 trap.** Done at this size → NOT WORTH IT; expected to grow → FULL (adopt early); unanswered → both branches |
| Schema owned by another team (DBA-gated) | migrate pillar out; model read-only or declare `source.rdb @unmanaged: true`; flag it |
| Team rejects generated code in the repo | flag; regenerate-every-build works, but the codegen drift gate's meaning changes — call the tradeoff |

### P5 — Migration plan (at the recommended scope)

**P5-a — Waves (the floor).**
- *CONTRACT SPINE:* Wave 0 — declare the two or three most-churned seam shapes, reproducing
  today's wire field names exactly (M5, M6); generate the types/validators into ONE consumer and
  make that consumer compile against them; codegen drift gate in its CI. Wave 1 — the other side
  of each seam generates from the same declaration (one metadata directory in a monorepo, or a
  published model: § Capability sheet, "Sharing a model"); delete the hand copies. Wave 2 — the
  rest of the seam inventory; value objects for opaque payloads that cross a seam.
- *PARTIAL / FULL:* Wave 0 — a handful of highest-churn tables authored from the live schema +
  `verify --db` in CI where the DB qualifies; zero generated code. Wave 1 — retire the clearest
  duplicate layer and generate what the port offers; codegen drift gate. Wave 2 — the full entity
  spine and schema-ownership handover (or read-only modeling), relationships, the P2-b value
  objects. Wave 3 — UI metadata; UI codegen only on TS/web. Wave 4 — prompts, parity-gated
  byte-compare against existing outputs.

Each wave: scope, LOC retired, effort band, parity gate, and the adoption skill that executes it
(`metaobjects-authoring` / `-codegen` / `-runtime-ui` / `-prompts` / `-verify`).

**P5-b — The ceiling (one labeled paragraph; `horizon: "later"`).** The next wider scope, and
the port's deep lane: JVM — the Kotlin lane generates entity + Exposed table + validators, and
OMDB offers metadata-driven data access; TS — Drizzle + Zod + routes + hooks + grids; C# —
generated EF Core entities + `AppDbContext` + minimal-API routes; Python — Pydantic + router +
`ObjectManager`. Every generator is a reference helper the adopter can eject (`meta eject`,
`metaobjects eject`, `mvn metaobjects:eject`, `dotnet meta eject`) and retarget, so a layer no
stock generator emits can still become generated: say "an owned generator can retire this", with
an honest effort tag.

### P6 — End-state projection

- **Spine size from DDL richness**, not a flat guess: ~25–40 lines per bare table; ~80–120 for
  index/FK/enum-rich schemas; value objects and contracts are usually small. Multiply by the
  reconciled object count, give a range.
- **Generated surface**: files + LOC per the port's generators at the recommended scope.
- **Leverage ratio** = `generated_lines / (metadata_lines + owned_generator_lines)`, as a band;
  it excludes the drift-gate value, which is the real prize.
- **Stays-hand-written table**: every surface that stays bespoke, each with a named reason.

### P7 — Beyond-the-ask vocabulary hunt (ADR-0037's ordered test for each)

- money as float / hand `*100` → `field.currency` (+`view.currency @locale`); not for non-ISO
  quantities (points, game gold): those are `field.int`/`field.long`.
- string unions / `CHECK IN (...)` / int flags → `field.enum @values` (value sets only).
- UUIDs as bare strings → `field.uuid`.
- hand `COUNT/SUM` subqueries, read-model SQL → `object.projection` + `origin.*` (lead with
  passthrough: most projection fields in real spines are passthroughs, aggregates the minority);
  a soft-delete/status view → object-level `@filter`.
- a denormalized column kept in sync by app code → an entity read-view (a non-primary read-only
  `view` source on the same `object.entity`) before reaching for a projection.
- hand junction joins → `relationship @cardinality: many @through`.
- copy-pasted base-field blocks → abstract base + `extends`.
- unique keys / lookup indexes living only in DDL → `identity.secondary` / `index.lookup`
  (usually the largest invisible-structure class — count them).
- email/URL/IP regexes → `@stringFormat: email` / `field.uri` / `field.inet`.
- opaque JSON columns → `object.value` + `field.object @storage: jsonb`.
- inline prompts / payload dicts → `template.prompt` / `template.toolcall`; a hand-parsed LLM
  reply → a responding `template.prompt` (`@responseRef`), never `template.output` (outbound
  only: rendered emails, documents, exports).
- `COMMENT ON` doc comments → the common `description` attribute.
- a recurring closed variant-set as N sibling modules → a project-registered provider subtype;
  VOCAB CANDIDATE, advisory, never load-bearing for the verdict.

Each suggestion: `metadata_sketch` + honest effort. If a hunt line has hits, it must appear.

### P8 — Limits (feeds §R7)

Work § Capability sheet for the target's ports. Always include: the schema pillar is Node-`meta`
only and Postgres/SQLite/D1 only; business logic, irreducible SQL, auth and bespoke
visualisation stay hand-written; adopting means owning a codegen step; metadata authoring debt
is real — price it; early `verify --db` runs surface legacy oddities, which are findings, not
noise. And, explicitly: *this assessment can read your code, not your roadmap* — name who gave
the trajectory answer, or which branch you assumed.

---

## Report contract — `fit-assessment.md`, sections in this order

**§R0 — Verdict.** The **recommended scope** (NOT WORTH IT / CONTRACT SPINE / PARTIAL: which
layer or subsystem / FULL), confidence, and the three decisive facts. Then **why each wider
scope was rejected**, one line each. The **seams** where it would pay off (both sides cited, the
closing gate) and the places it would not. Per-pillar verdicts (codegen / runtime metadata /
drift detection / prompt construction: `STRONG FIT` / `FIT` / `MARGINAL` / `NOT A FIT` / `N/A`,
one decisive fact each), read **at the recommended scope**. The disqualifier table, worked. The
one-line wedge. The UI line follows the P2-c split.

**§R1 — Drift exposure today** (the centerpiece): the cost-of-change exhibit, the ledger, the
gate mapping + honest limits, and a summary line (N classes; N with documented past incidents;
N divergent right now).

**§R2 — Census**: the P2-a reconciliation block (with seam shapes), P2-b counts, UI-surface
counts, and a coverage column (what MetaObjects can model/generate vs what it will never touch).

**§R3 — Migration plan** at the recommended scope (P5-a), plus the labeled ceiling paragraph
(P5-b).

**§R4 — End-state projection** (P6).

**§R5 — Benefits, quantified and tagged** `checkable: true/false`: LOC eliminated by class;
drift classes closed (cross-referenced to §R1); incidents that the gate would have stopped;
cross-language reuse only if genuinely multi-language; prompt wins.

**§R6 — Beyond-the-ask vocabulary opportunities** (P7).

**§R7 — What you will NOT get** (P8; mandatory).

**§R8 — First-week wedge**: the smallest end-to-end slice at the recommended scope — for a
CONTRACT SPINE, one seam shape declared, generated into one consumer, drift gate in CI, one
hand copy deleted; for PARTIAL/FULL, one entity set authored from the live schema with the drift
gate in CI and one generated vertical. Then point at `meta init` + the adoption skills.

---

## JSON contract — `fit-assessment.json`

Read `references/json-contract.md` before you write `fit-assessment.json`, and keep it open while you fill it. <!-- inline: references/json-contract.md -->

---

## Capability sheet — what each port ships at 1.1.4 (never promise across these lines)

Read `references/capability-sheet.md` before you state what any port can do; every capability claim in the assessment traces to it or to a published source (M3). <!-- inline: references/capability-sheet.md -->

---

## Final self-check before answering

0. **Scope, not fit.** Did you work the scope table top to bottom and say why each wider scope
   was rejected? Is NOT WORTH IT backed by facts, not by "the ORM isn't supported"?
1. **Seams.** Did you look for boundaries between apps, services, packages and languages — and
   for gates that already cover them?
2. **Trajectory (M8).** Asked, or both branches shown? A NOT WORTH IT that rests on "small" needs
   the human's answer.
3. **Read-only.** Nothing written inside the target repository?
4. Every capability claim traceable to § Capability sheet or a published source (M3)?
5. Every drift row: real `file:line`, real commits, a named gate? (>15% false positives is fatal.)
6. *(Full only)* Disqualifier table worked row by row; reconciliation block present; P2-b run;
   ceiling paragraph labeled `horizon: "later"`; "What you will NOT get" complete; every prose
   prediction has a JSON twin.


# MetaObjects Fit & Migration Assessment — design

_Status: Proposed · 2026-07-12_

A hosted, LLM-runnable assessment that reviews a project which has **not yet adopted
MetaObjects** and produces a decision-grade report: is this project a fit, what would
migrate, what the after-state looks like, what the benefits are — with **drift
protection as the centerpiece** — and which metadata vocabulary the project isn't
asking for but would profit from.

This is the **pre-adoption sibling of the `metaobjects-audit` skill**. The audit asks
"you adopted — how deep, and what's drifting?" (a depth score). The fit assessment asks
"should you adopt, and what would it look like?" (a fit verdict + migration proposal).
Same rigor — evidence-based, honest, cite `file:line`, bias to under-flagging — different
question. Together with the adoption skills they form one lifecycle:

```
fit-assessment (pre)  →  authoring/codegen/verify skills (during)  →  audit (post)
"should you?"            "metadata follows the code"                 "how deep? what drifts?"
```

See also: [`agent-context/skills/metaobjects-audit/SKILL.md`](../../../agent-context/skills/metaobjects-audit/SKILL.md)
(the sibling; this design reuses its capability catalog, classification scheme, drift
signatures, and calibration table),
[2026-06-29-metaobjects-audit-skill-design.md](2026-06-29-metaobjects-audit-skill-design.md),
[docs/features/downstream-metadata-decisions.md](../../features/downstream-metadata-decisions.md),
[docs/llms/llms.txt](../../llms/llms.txt) (the discovery surface this plugs into).

---

## 1. Concept, audience, boundary

**Audience.** A high-end LLM (Claude Opus/Fable, GPT-class) sitting inside a target
project's repo, with local file access and (usually) web access — and **zero MetaObjects
installed**. The operator is a developer or tech lead deciding whether MetaObjects is
worth adopting. The output must be decision-grade: honest enough that a "no" is
credible, concrete enough that a "yes" comes with a plan.

**The question it answers** (all six, in one report):

1. **Fit** — is this project a fit, per pillar, with honest disqualifiers?
2. **What migrates** — persistence (hand entities/DTOs/repos/schema → `object.entity` +
   `source.rdb` + generated ORM/DDL), UI (hand grids/forms/filters → `layout.dataGrid` +
   form generators + the runtime web packages), and the codegen surface (what becomes
   `@generated`).
3. **End result** — the after-state: spine size, generated surface, leverage ratio,
   what disappears vs. what genuinely stays hand-written.
4. **Benefits** — quantified where checkable.
5. **Beyond-the-ask vocabulary** — metadata types the project isn't asking for but
   would profit from (`object.projection`, `field.currency`, `field.enum`,
   `origin.aggregate`, `template.prompt`, a relationship it's hand-joining).
6. **Drift protection** — the centerpiece, not a footnote (§4).

**Boundary — read-only, propose-only.** Exactly like the audit: the assessment never
edits code, never authors metadata, never installs anything. Every `metadata_sketch` is
a read-only proposal. The bridge into action is `meta init` + the adoption skills — the
assessment's final section points there.

**Not a sales brochure.** The single biggest failure mode is an LLM in
marketing-brochure mode. The design counters it structurally: a mandatory disqualifier
checklist, per-port calibration (never promise a TS-only feature to a JVM adopter), a
required "what you will NOT get" section, the audit's >15% false-positive kill
criterion applied to drift findings, and a retro-test loop (§6) that scores
over-promising as a first-class defect.

---

## 2. Relationship to the audit — what's reused, what's new

| Component | Audit (post-adoption) | Fit assessment (pre-adoption) |
|---|---|---|
| Capability catalog | `references/capability-checklist.md` (registry-grounded, CI-guarded) | **Same file, re-aimed**: each "hunt the hand-written shape" line becomes "this duplicate exists today; here is the node that would own it" |
| Classification scheme | GENERATED / OWNED-GENERATOR / CANDIDATE / BESPOKE / VOCAB | Same classes minus GENERATED/OWNED (nothing is generated yet); adds **WEDGE** (the first entity to migrate) |
| Drift signatures 1–9 | "you failed to fold this into the spine" | "this is your drift exposure **today**; here is the `verify` gate that closes it" (§4) |
| Calibration table | per-port gaps are not adopter faults | same table, harder duty: **caps what may be promised** per stack |
| Adoption-direction doctrine | guardrail on `metadata_sketch` | **governs the whole migration plan**: metadata follows the code (§5) |
| Scoring | maturity tier + per-pillar bands | **per-pillar fit verdict** + confidence (§3) |
| Machine artifact | `.metaobjects/adoption-audit.json` | `fit-assessment.json` (§3; **not** under `.metaobjects/` — that directory is the marker of an adopted project) |
| Distribution | scaffolded by `meta init` into adopters | **hosted URL** — the target has no MetaObjects to scaffold from (§7) |

The two must not fork their shared substance. The capability checklist, calibration
table, and drift signatures stay **single-sourced** in the audit skill's directory; the
fit assessment references them at build time (§7.2) so the
`agent-context-capability-grounding` test keeps both honest against
`expected-registry.json`.

---

## 3. The report contract

Two artifacts, mirroring the audit:

- **`fit-assessment.md`** — the human report, sections below, verdict first.
- **`fit-assessment.json`** — machine-readable findings. Same field schema as the
  audit's findings (`id`, `title`, `pillar`, `surface`, `capability`, `locations[]`,
  `impact`, `effort`, `confidence`, `metadata_sketch`, `parity_gate`) **plus two fields
  that exist for the validation loop** (§6):
  - `claim_type`: `fit` | `migrates` | `stays-bespoke` | `leverage` | `drift` | `vocab` | `benefit`
  - `checkable`: `true`/`false` — can this claim be verified against a real migration?

  Every prediction in the prose report must have a JSON twin. This is deliberate:
  **the report is designed to be scoreable.** A claim that can't be expressed as a
  typed, checkable finding is probably hand-waving.

Default output location: a `metaobjects-fit/` directory at the target repo root (or
wherever the operator says). Never create `.metaobjects/`.

### Report sections (in this order)

**§R0 — Verdict block** (first thing the reader sees):

- **Per-pillar fit verdict** — one line each for **codegen**, **runtime metadata**,
  **drift detection**, **prompt construction**: `STRONG FIT` / `FIT` / `MARGINAL` /
  `NOT A FIT` / `N/A`, each with its one decisive fact. Pillar-scoped verdicts matter
  because real projects are lopsided: an LLM-heavy service on a document store can be
  a NOT-A-FIT on persistence and a STRONG FIT on the prompt pillar — one binary verdict
  would lie in both directions.
- **Overall verdict** + confidence (high/medium/low) + the three decisive facts.
- **Disqualifier checklist, explicitly worked** (§3.1) — every row answered, not just
  the failing ones. An assessment that skips this section is invalid.
- The one-line wedge recommendation ("start with entity X").

**§R1 — Drift exposure today** (the centerpiece — §4; immediately after the verdict,
before any migration content, because it is the pitch).

**§R2 — Census.** Stack + versions; entity-shaped things (tables, model classes, DTOs,
validation schemas); route/handler count; UI list/form/filter surfaces; LLM
prompt-construction sites; migration tooling; test posture. Counts + locations, the
denominator for everything after.

**§R3 — Migration plan** (§5): wave-ordered, wedge-first, persistence → codegen surface
→ UI → prompts, every wave with a parity gate, governed by metadata-follows-the-code.

**§R4 — End-state projection.** Estimated metadata spine (entities × observed
lines-per-entity bands from real adopters — roughly 25–120 YAML lines per entity
depending on validator/prompt richness), estimated generated surface (files + LOC per
port, from what the port's generators actually emit), **leverage ratio** =
`generated_lines / (metadata_lines + owned_generator_lines)` (the audit's formula), and
the **stays-hand-written table**: every surface predicted to remain bespoke, each with
a NAMED justification (recursive CTE, window function, auth, business logic — "it's an
aggregation" is not a justification; count/sum/avg/min/max rollups are
`origin.aggregate`).

**§R5 — Benefits, quantified and tagged.** LOC eliminated (by class: entities, DTOs,
mappers, validators, allowlists, DDL), drift classes closed (cross-referenced to §R1's
ledger), cross-language reuse (only if the project is genuinely multi-language),
prompt-pillar wins (byte-stable renders, payload-as-diff, `verify --templates`). Each
benefit tagged `checkable: true/false` in the JSON. Uncheckable benefits are allowed
but must be labeled as such.

**§R6 — Beyond-the-ask vocabulary opportunities.** The inverse hunt, reusing the
audit's axis-I "new-vocabulary opportunity" discipline and the ADR-0037 ordered test:

- money as float / hand `*100` math → `field.currency` (+ `view.currency @locale`)
- string-union / `CHECK IN (...)` / int-flag discriminators → `field.enum @values`
- UUIDs as bare strings → `field.uuid` (never `field.string` + `@dbColumnType: uuid`)
- hand `COUNT/SUM` subqueries or read-model SQL views → `object.projection` +
  `origin.aggregate` / `origin.passthrough` (+ the view-necessity test from audit
  drift-signature 8)
- hand junction-table joins → `relationship @cardinality: many @through`
- copy-pasted base-field blocks → abstract base + `extends`
- email/URL/IP validation regexes → `@stringFormat: email` / `field.uri` / `field.inet`
- inline prompt strings, ad-hoc payload dicts, regex output parsing →
  `template.prompt` / `template.output` / `template.toolcall`
- a recurring closed variant-set hand-coded as N sibling modules → a
  project-registered provider subtype (VOCAB CANDIDATE, advisory, ADR-0023/0037)

Each suggestion carries a `metadata_sketch` and honest effort. Bias to under-flagging.

**§R7 — What you will NOT get (mandatory).** The honesty section, driven by the
calibration table for the target's stack. Non-negotiable inclusions:
- schema migration (`meta migrate`, `verify --db`) is Node-`meta`-only and supports
  **Postgres, SQLite, and D1** — a MySQL/SQL-Server/Oracle shop keeps its existing
  migration tool (data-access still works; the schema pillar is out);
- filter-operator route codegen is full only in TS — JVM/C#/Python get
  pagination/sort/count;
- C# has no ObjectManager runtime tier (EF Core is the runtime);
- Python hand-wires the FastAPI router around the generated `APIRouter`;
- business logic, custom SQL beyond projection-expressible shapes, auth, and bespoke
  visualization stay hand-written — MetaObjects generates entity-shaped boilerplate,
  it is not a prompt-to-app builder;
- generated code is idiomatic and runs without MetaObjects at runtime (local-first) —
  but adopting still means owning a codegen step in the build.

**§R8 — First-week wedge plan.** One real entity (single-column PK, standard CRUD),
end-to-end: `meta init` → author the wedge's metadata **reproducing the existing
shape** → `meta gen` → parity-gate → wire `verify` into CI **in week one** (the drift
gate is the earliest payoff and the cheapest to install before habits form). Then point
at the adoption skills for the rest.

### 3.1 The fit rubric (worked, not vibes)

**Positive signals** (each cited with evidence):
- backend in one of the five ports (TS / Java / Kotlin / C# / Python);
- relational persistence, especially Postgres or SQLite;
- ≥ ~5 entity-shaped things with CRUD-ish surfaces;
- the same shape declared ≥ 2× today (ORM model + validation schema + DTO + SQL) — the
  strongest single predictor, because it is drift exposure (§4);
- LLM prompt-construction sites (any count — the prompt pillar has no incumbent);
- more than one language consuming one model (the cross-language reuse case);
- planned or existing admin-style grids/forms (TS/web).

**Honest disqualifiers / caps** (every row answered in §R0):

| Check | Consequence |
|---|---|
| Backend language outside the five ports | NOT A FIT (codegen/runtime pillars); prompt pillar only if a portable sidecar makes sense — usually say no |
| No relational store (pure document/event-sourced) | persistence + `--db` pillars N/A; assess prompt + value/projection pillars on their own merits |
| DB is not Postgres/SQLite/D1 | schema pillar (migrate, `verify --db`) OUT; say so plainly; data-access unaffected on JVM |
| < ~3 entities, or a domain that isn't entity-shaped (compiler, game loop, numeric kernel) | MARGINAL/NOT A FIT — the leverage ratio won't pay for the tooling |
| Schema owned by another team/org (DBA-gated) | migrate pillar restricted; model `metadata follows the schema` read-only; flag the org constraint |
| Deep, hand-tuned ORM investment (heavily customized Hibernate/Prisma mappings) | not a disqualifier but a churn warning: the migration must reproduce those mappings (`@column`/`@table`/`@dbColumnType`), and the plan's effort estimate must reflect it |
| Team culture rejects generated code in the repo | flag it — the model works uncommitted (regen-every-build) too, but `verify --codegen` semantics differ; call the tradeoff |

A verdict without this table worked row-by-row is invalid output.

---

## 4. Drift protection — the centerpiece section (§R1)

The pitch is not "you'll write less code." The pitch is: **every hand-maintained
duplicate of one fact will drift, and here is your inventory of them.** The report
leads with this immediately after the verdict.

### 4.1 The drift ledger

Reuse the audit's drift signatures 1–9, re-aimed at a project with zero MetaObjects.
For each finding, a **ledger row**:

| Column | Content |
|---|---|
| Second source of truth | the duplicate pair/triple, with `file:line` for each copy (e.g. "`User` exists as an ORM model + a Zod/DTO schema + a Flyway/DDL migration + a TS client type — 4 declarations of one shape") |
| Divergence today | field-by-field diff of the copies — **an actual current divergence is the money finding** (a column the validator doesn't know, a nullable mismatch, a renamed field one copy missed) |
| Historical drift evidence | git archaeology (§4.2) |
| The gate that closes it | which mechanism prevents recurrence post-adoption (§4.3) |
| Class | maps to drift-signature # for scoring |

Signature classes, pre-adoption phrasing:
1. hand validators shadowing the persistence model;
2. field-by-field DTO↔model/row mappers;
3. camelCase↔snake_case body↔column maps;
4. drift-admitting comments (`"keep in sync with"`, `"mirrors the"`);
5. runtime schema patching (`ALTER TABLE IF NOT EXISTS`, `_ensure_schema()`) — N schema owners;
6. N declarations of one shape (the headline class);
7. *(n/a pre-adoption — `own*()` is a MetaObjects-internal discipline)*;
8. hand-written `CREATE VIEW` / read-only SQL mirroring a read model (view-necessity test);
9. a closed variant-set hand-modeled per instance;
10. **(new, prompt-pillar)** one prompt's text/payload/parse scattered across services —
    a renamed field silently degrades the prompt with no build-time signal.

### 4.2 Git archaeology — prove the drift is real, not theoretical

The assessment must mine the target's own history for **realized** drift incidents,
because "it will drift" lands 10× harder as "it already did, twice":

- fix commits that patched **one** copy of a duplicated shape (then a later commit
  patching the other copy — the smoking gun);
- migration files that diverge from the model class in the same commit range;
- bug-fix messages containing `sync`, `mismatch`, `out of date`, `forgot to update`;
- prompt-string edits with no corresponding payload/parser change (and vice versa).

Each archaeology hit is cited (`commit-sha: subject`) and attached to its ledger row.
Bias to under-flagging: an ambiguous hit is dropped, not stretched.

### 4.3 Exactly which gate closes which exposure

Every ledger row names its closing mechanism — this is where the four verify surfaces
become the product story:

| Exposure class | Closing gate |
|---|---|
| model ↔ validator ↔ DTO duplicates (1, 2, 3, 6) | one authored `object.entity`; the copies become `@generated` artifacts; **`meta verify --codegen`** (regen-and-diff) in CI fails the build when committed output drifts from the spine |
| schema vs. model (5, and the DDL copy in 6) | the spine owns DDL via `meta migrate`; **`meta verify --db`** (Node `meta`, PG/SQLite/D1) fails on live-DB divergence |
| read-model SQL views (8) | `object.projection` + `origin.*` generate the view DDL; **note honestly**: an *unmodeled* hand view is invisible to `verify --db` (unmanaged) — modeling it is what makes it gateable at all |
| scattered prompts (10) | `template.prompt` + typed payload VO + external text; **`meta verify --templates`** fails when a `{{field}}` no longer matches the payload shape; byte-stable render keeps prompt-cache prefixes intact |
| the metadata itself | strict provenance (ADR-0023): unknown attrs fail load (`ERR_UNKNOWN_ATTR`) — the spine can't silently grow untracked vocabulary |

And the honest limits, in the same section: `verify` cannot catch **semantic
mismodeling** (a uuid modeled as string passes `--db` because the column really is
uuid), cannot see **unmodeled** DB objects, and `--templates` coverage depends on CLI
version. Drift protection is a gate, not a proof system.

---

## 5. The migration plan (§R3) — governed by "metadata follows the code"

The adoption-direction doctrine is the law of this section (it already governs the
audit's sketches and the authoring skill's brownfield section):

- **Author metadata to REPRODUCE the existing code** — native types, column/table
  names, nullability. Model `field.uuid` where the code uses UUID; carry over
  `@column`/`@table`/`@required`; match `columnNamingStrategy` to the existing schema.
- **Minimize churn to code the generator is not replacing.** A plan step that re-types
  or renames working call sites the generator doesn't own is modeling the wrong thing.
- **Never** change-metadata → regen → fix existing code as "bugs".
- **Ambiguity goes to the human.** The plan marks decision points (e.g. an int-ordinal
  enum column with production data: match-existing `field.int` now, modernization
  deferred) instead of silently picking the churnier option.
- **Parity-gate every wave** before deleting hand-written code — generated schemas are
  often looser; prove behavior-equivalence first.

Wave structure (adapt counts to the target):

1. **Wave 0 — wedge.** One entity end-to-end + `verify` in CI. Deliverable: the team
   has seen regen + drift-gate work on real code.
2. **Wave 1 — persistence core.** The entity graph (entities, identities,
   relationships, enums, value objects), generated ORM layer + DDL ownership handover
   (or read-only schema modeling where the DB isn't PG/SQLite). Hand entities/DTOs
   retired per parity gate.
3. **Wave 2 — API/codegen surface.** Routes/controllers/repositories/filter allowlists
   per the port's generators; scaffold-and-own the generators (ADR-0034) from day one.
4. **Wave 3 — UI** (TS/web consumers). `layout.dataGrid` + form generators + the
   runtime web packages for list/form surfaces classified CANDIDATE-high; bespoke
   presentation keeps hand-written viz over generated data layers.
5. **Wave 4 — prompts.** `template.prompt`/`template.output`/`template.toolcall` per
   prompt site, `verify --templates` gate.

Each wave lists: entities/surfaces in scope, LOC retired, effort band, parity gate,
and the skill that executes it (`metaobjects-authoring` / `-codegen` / `-runtime-ui` /
`-prompts` / `-verify`).

---

## 6. Validation methodology — the retro-test loop

The assessment is a predictor; the maintainer has **real migrations** whose before/after
states are in git. So the design is falsifiable: run the assessment on a
**pre-adoption git state**, compare its predictions to what actually happened, and
score calibration. This section is the part of the design most worth building first.

### 6.1 Targets

Concrete targets exist in the maintainer's environment. This public repo names them
generically; the concrete repo/SHA map lives in the maintainer's private notes.

| Target | Profile | Pre/post split | Role |
|---|---|---|---|
| **Adopter A** — a private JVM/Kotlin multi-module product (Spring, Maven, Postgres, LLM-heavy) | ~1.5k Kotlin/Java files pre-adoption; Spring Data JDBC + Flyway; adopted in a named "wave-0" commit series (2026-05); post-state: ~10k-line YAML spine across ~200+ files, ~95 entities, ~190 mustache prompt templates, codegen regenerated every build (not committed), CI drift gate | **Clean boundary**: baseline = parent of the first wave-0 commit. Bonus ground truth: the repo contains its own human-written migration-plan FR docs (persistence + prompt migration) — an independent expert plan to compare structure against | **Primary / development target** (tune the prompt here) |
| **Adopter B** — a private TS+Python AI platform (Fastify-style API, Drizzle-era schema, Postgres) | Adopted persistence in a single commit (2026-06): ~12k insertions, hand-written `schema.ts` retired, per-entity generated files; later cross-language (Python telemetry) + prompt adoption | Baseline = parent of that adoption commit | **Holdout** (scored once per prompt version — never tuned against) |
| **Negative controls** — e.g. a static marketing site and a small config/CLI utility repo from the same environment | no entities, no persistence, or trivially small | n/a | Verify the verdict machinery can say **NOT A FIT** with a straight face |
| *(Non-target)* the public reference demo app | MetaObjects-native from its first commit | **no pre-state exists** | explicitly excluded — nothing to predict |

Adopter A is the richer target (multi-module, JVM port, prompts, projections, a long
post-adoption history to mine). Adopter B is the cleaner one (one adoption commit, TS
port). Two targets ≈ a train/holdout split; it is tiny, but it is the difference
between "tuned on one anecdote" and "generalized once."

### 6.2 Baseline selection + decontamination (load-bearing detail)

Procedure per target:

1. **Find the adoption boundary**: `git log --reverse -S '<dep-token>'` (the Maven
   groupId / npm scope) plus first commit creating the metadata module. Baseline =
   parent of the earliest such commit.
2. **Decontaminate.** Both real targets' pre-adoption trees are already contaminated:
   Adopter A's baseline tree contains MetaObjects **migration-planning FR docs** (the
   answer key, sitting in the tree); Adopter B's baseline tree contains **scaffolded
   `metaobjects-*` skills** (agent context installed before the persistence commit).
   An assessment run on the raw baseline would just read the answers. So: fresh
   worktree at the baseline SHA → delete every file whose path or content matches the
   tool name (case-insensitive) → record the removal manifest alongside the run. If
   the planning docs predate the boundary by a lot, prefer stepping the baseline back
   to before planning began (more authentic), decontaminating only what remains.
3. **Blind the assessor.** Run in a **fresh agent session with no project memory** —
   the maintainer's own agent memory knows these migrations intimately. The model's
   pre-training may know MetaObjects exists; that is acceptable (a real prospect's LLM
   knows whatever the web says) — what must not leak is *this target's* outcome.
4. Give the assessor exactly what a real prospect's LLM gets: the decontaminated repo
   + the hosted assessment URL (§7) + web access. Nothing else.

### 6.3 Ground truth extraction (scripted, from the post state)

A small script (repo-local tooling, not shipped) computes, from the current adopted
state:

- **Spine census**: metadata files/lines; counts of `object.entity` / `object.projection` /
  `object.value`; a **vocabulary histogram** (every `type.subtype` and notable `@attr`
  actually used — the oracle for scoring §R6 vocab suggestions);
- **Generated-surface census**: run the port's generator (for adopters that don't
  commit output, e.g. Adopter A regenerates every build — count from the build's
  output, never from a repo grep) → files + LOC → the **actual leverage ratio**;
- **Retired-code census**: `git diff --stat <baseline>..<post>` classified — which
  hand-written entities/DTOs/mappers/validators/DDL were deleted (the actual
  "what migrated" list), and which survived (the actual "stays bespoke" list);
- **Drift-gate state**: which `verify` subverbs are wired into CI;
- **Prompt census**: template count, payload VOs, `--templates` gating;
- **The human plan** (Adopter A only): the in-repo migration FR docs, as an
  independent expert plan for structural comparison;
- **Realized-drift incidents**: the same git-archaeology queries (§4.2) run over the
  **pre-baseline** history — the oracle for whether the assessment's drift ledger
  found the real ones.

### 6.4 Scoring — what is checkable, and how

Every JSON finding carries `claim_type` + `checkable` (§3), so scoring is mostly
mechanical, with a human adjudication lane on top:

| Claim type | Checked against | Metric |
|---|---|---|
| `fit` (per-pillar verdicts) | the fact of successful adoption per pillar (+ negative controls) | direction correct? (adopters must not score MARGINAL/NOT-A-FIT on pillars they adopted deeply; controls must fail) |
| `migrates` (the entity/surface list) | retired-code census + spine census | **recall** (% of actually-modeled entities predicted) and **precision** (% of predicted migrations that really happened or were adjudicated sound) |
| `stays-bespoke` | survived-code census | precision (predicted-bespoke that indeed stayed hand-written, with matching justification class) |
| `leverage` (ratio + spine-size estimates) | actual leverage ratio | within a ×/÷2 band = pass (order-of-magnitude honesty, not decimals) |
| `drift` (the ledger) | (a) the duplicate really existed at the cited `file:line` in the baseline; (b) archaeology hits are real commits; (c) post-adoption, was it in fact retired/gated? | per-finding TRUE/FALSE; **false-positive rate > 15% kills the prompt version** (the audit's kill criterion, applied with full force) |
| `vocab` (§R6 suggestions) | the vocabulary histogram | hits (suggested ∧ used) / over-suggestions (suggested ∧ unused → adjudicate: bad idea, or a real miss by the migration?) / **under-suggestions** (used ∧ never suggested — scored too; under-promising is a defect, just a cheaper one) |
| `benefit` (checkable ones) | LOC/census deltas | claim-by-claim TRUE/FALSE/UNVERIFIABLE |

**Adjudication lane.** The real migrations are not a perfect oracle — they were built
by the tool's own author with agent assistance, and actual adoption depth can exceed
or lag the ideal. So each mechanical mismatch gets a three-way human ruling:
**CONFIRMED** (matches reality) / **REASONABLE-DIVERGENCE** (reality differed; the
prediction was defensible — e.g. it proposed a projection the migration didn't build
but arguably should have) / **WRONG**. The headline calibration numbers:

- **Over-promise index** = WRONG claims of benefit or migration ÷ total such claims —
  the number that decides whether this thing is publishable at all;
- **Under-promise index** = real wins the assessment missed ÷ real wins;
- **Drift precision** (the ledger's false-positive rate) — the kill criterion.

**Discipline:** tune the assessment prompt only against Adopter A; score Adopter B
once per prompt version; report both. If Adopter-B scores collapse relative to
Adopter-A scores, the prompt has been overfitted to one migration's shape.

---

## 7. Hosting, discovery, invocation

### 7.1 The constraint that drives the design

The target project has **zero MetaObjects installed**, so the audit's distribution
channel (`meta init` scaffolds skills) is unavailable by definition. The assessor LLM
has, at minimum, local repo access + the ability to fetch **one URL** (some
enterprise setups may not even have that — see the offline fallback). Therefore:

**The assessment ships as one self-contained, version-stamped Markdown file at a
stable URL.**

### 7.2 Where it lives (single-source, three surfaces)

- **Canonical source (this repo):** `agent-context/skills/metaobjects-fit-assessment/`
  — `SKILL.md` + thin references, exactly like its five siblings, so it shares the
  audit's `references/capability-checklist.md` and is covered by the
  `agent-context-capability-grounding` test (no vocabulary claim can outlive the
  registry). **But it is excluded from the `meta init` scaffold set** (the assembler
  gets a per-skill `scaffold: false` flag): a project that has run `meta init` has
  already decided; shipping "should you adopt?" into adopters is noise. Keeping it in
  `agent-context/` anyway buys the grounding test, the shared catalog, and the option
  to flip the flag later.
- **Built artifact:** a build step (sibling of the existing agent-context assembler)
  flattens `SKILL.md` + the capability catalog + the calibration table + the report
  contract into **one file**, stamped with the release version and the vocabulary
  grounding line ("grounded against MetaObjects `0.15.x` / Maven `7.7.x`,
  metamodel-registry manifest of that release"). Size budget: it must stay a single
  practical fetch (target ≤ ~1,500 lines; the deep per-port references stay
  second-fetch links, not inlined).
- **Published URLs:**
  - `https://metaobjects.dev/assess.md` — the primary, human-quotable URL (the www
    site is static files; this is one more file next to `llms.txt`).
  - The raw GitHub URL of the built artifact (mirrored into `docs/llms/` next to
    `llms-full.txt`) — for LLMs that trust the repo more than the site, and as the
    offline story: a prospect can also just be handed the file.

### 7.3 Discovery — how an LLM finds it

- **`llms.txt`** (already the AI front door) gains a section **before** the current
  "For AI assistants adopting MetaObjects": *"For AI assistants evaluating whether a
  project should adopt MetaObjects — fetch `https://metaobjects.dev/assess.md` and
  follow it against the repository. It produces a fit verdict + migration proposal
  and needs no MetaObjects installation."* (The adopting section stays the next step
  after a YES verdict.)
- **Repo README + `getting-started.html`**: one line each — "Not sure it fits? Have
  your AI assistant run the fit assessment: `metaobjects.dev/assess.md`."
- **The invocation contract is one sentence a human can paste into any agent:**
  > Fetch https://metaobjects.dev/assess.md and run the MetaObjects Fit & Migration
  > Assessment against this repository.

### 7.4 Inputs the assessment asks for

Declared at the top of the hosted file, so the LLM elicits them if absent:
- repo access (required); which subdirectory/service to scope to, for monorepos;
- stack confirmation (detected, but confirm: language(s), DB, ORM, web framework);
- whether an LLM/prompt surface exists (pillar-4 scoping);
- org constraints that gate verdicts (who owns the schema; is generated code in the
  repo acceptable);
- where to write `metaobjects-fit/` output.

No secrets, no DB connection (the assessment reads code and migrations, never a live
database — `verify --db` is described in the report, not executed).

### 7.5 Later (explicitly optional)

`npx @metaobjectsdev/cli assess` — zero-commitment via `npx`, prints or scaffolds the
same built artifact locally. Deferred: the URL covers the need, and a CLI verb implies
support surface. Similarly deferred: MCP exposure of the assessment (rides the
existing MCP roadmap item, not this design).

---

## 8. Open questions & risks

**Risks, ranked:**

1. **Over-promising** (LLM brochure mode) — the whole §6 loop exists to measure this;
   the structural counters (§1) exist to prevent it. If the over-promise index or the
   drift false-positive rate can't be driven under the kill criterion on the holdout,
   **don't publish the URL** — an inflated assessment that a prospect later falsifies
   is worse than no assessment.
2. **Non-independent ground truth** — both retro targets are the author's own
   migrations, agent-assisted. The oracle can be wrong in both directions (over-deep
   dogfooding; missed opportunities). Mitigated by the adjudication lane, and properly
   fixed only by the first independent adopter's before/after (which this tool, if it
   works, helps create).
3. **Contamination/blinding limits** — decontamination handles the tree; nothing
   handles a model that has read this public repo (including this spec) in training.
   Acceptable for calibration purposes (real prospects' models share the exposure);
   worth noting in every retro-score report.
4. **Staleness** — a hosted prompt hard-codes capability claims that rot per release.
   Countered by single-sourcing through the grounding-tested agent-context tree +
   the version stamp + regenerating `assess.md` in the release flow (same motion that
   already refreshes `llms.txt` version strings).
5. **Fetch-size / single-file tension** — inlining enough to be self-contained vs.
   staying fetchable. The ≤ ~1,500-line budget + second-fetch links is the compromise;
   validate it by actually running the retro-test through the built artifact, not the
   source tree.

**Open questions:**

- Should a completed `fit-assessment.json` feed `meta init` (pre-seed the wedge entity,
  pre-select generators)? Attractive bridge; deferred until the report contract is
  stable.
- Does the fit assessment eventually **merge with the audit** into one skill with a
  Phase-0 fork ("MetaObjects present? no → fit path")? The audit's Phase 0 already
  classifies Greenfield; keeping them separate preserves the hosted/scaffolded
  distribution split, which seems load-bearing. Revisit after both have mileage.
- Negative-control library: worth curating 2–3 permanent NOT-A-FIT fixture repos so
  every prompt revision re-runs them cheaply?
- Should retro-test scoring artifacts (scores per prompt version) be committed to this
  repo (genericized) as a public calibration record? Strong marketing if the numbers
  are good; decide after Phase 2.

---

## 9. Phased build plan

**Phase 0 — one real run (prototype; ~half a day).**
Draft `SKILL.md` v0 (report contract §3 + drift centerpiece §4 + rubric §3.1 + the
migration-direction rules §5, referencing the existing capability checklist). Prepare
the decontaminated Adopter-A baseline worktree (§6.2). Run once with a strong model in
a blinded session. **Eyeball only**: does the verdict block read decision-grade? Is the
drift ledger citing real duplicates? Did it hallucinate capabilities? This single run
decides whether the concept survives.

**Phase 1 — ground truth + scoring (Adopter A).**
Build the ground-truth extraction script (§6.3) + the scoring sheet (§6.4). Score the
Phase-0 run; iterate prompt v0 → v1 against Adopter A until drift precision and the
over-promise index clear the bar. Deliverable: a scored calibration report.

**Phase 2 — holdout + controls.**
One blind run on the Adopter-B baseline + the negative controls; score without tuning.
Go/no-go: publishable calibration on the holdout, and the controls got honest NOT-A-FIT
verdicts. If no-go, loop to Phase 1 with the failure analysis.

**Phase 3 — productize.**
Add the flatten/build step to the agent-context assembler (with the `scaffold: false`
exclusion + grounding-test coverage); publish `assess.md` to metaobjects.dev + mirror
into `docs/llms/`; add the `llms.txt` section, README + getting-started pointers; wire
the version-stamp regeneration into the release flow.

**Phase 4 — keep it honest.**
Re-run the retro-suite per release that changes vocabulary or generators (the fixture
worktrees make this cheap); publish the calibration record if §8's open question lands
that way; revisit the `npx meta assess` and audit-merge questions once real prospects
have used the URL.

---

## 10. Summary of opinionated calls

1. **Sibling of the audit, not a mode of it** — shared catalog/calibration/signatures
   (single-sourced, grounding-tested), different question, different distribution.
2. **Per-pillar fit verdicts** — one binary verdict would lie about lopsided projects.
3. **Drift exposure leads the report** — right after the verdict; the ledger + git
   archaeology + gate-mapping is the pitch, told with the project's own history.
4. **The report is machine-scoreable by design** — `claim_type` + `checkable` on every
   finding exist so the retro-test loop is mechanical, not vibes.
5. **Hosted single-file URL, not a scaffolded skill** — the target has no MetaObjects
   to scaffold from; `metaobjects.dev/assess.md` + an `llms.txt` entry is the whole
   distribution story, with the source living in `agent-context/` (scaffold-disabled)
   for grounding.
6. **Metadata follows the code governs the migration plan** — reproduce existing
   shapes, parity-gate every wave, ambiguity goes to the human.
7. **The retro-test is a train/holdout split with decontamination and a kill
   criterion** — Adopter A to tune, Adopter B to score, negative controls to prove
   the machinery can say no; >15% drift false-positives or a failing over-promise
   index blocks publication.

---

## Phase-0 findings + refinements (2026-07-12)

Phase 0 ran as designed: a blinded high-end LLM session was given only the
decontaminated Adopter-A baseline tree + this public repo, ran a v0 of the assessment,
and was hand-scored against the actual migrated spine (94 `object.entity` /
20 `object.projection` / 15 `object.value`, ~10k-line YAML spine) plus the adopter's
own in-repo human migration plan as an independent expert baseline.

**Result: STRONG GO.** The verdict (ADOPT, staged, wedge-first) and per-pillar scores
were correct and well-calibrated. The drift-ledger centerpiece **exceeded the human
expert plan**: where the human plan stated the drift thesis generically ("entity shape,
schema, validation, payload shapes maintained in 3–4 places"), the blinded run found
*specific, verified, production-biting* incidents — a status-enum vs `CHECK`-constraint
chase spanning 146 migrations (one repair explicitly quoting a production constraint
violation), a **currently-live** column-width divergence (DB widened by migration; the
ORM annotation still declaring the old width — and feeding a second schema generator via
the test profile), an orphan column confessed in a DAO comment, and a one-field-addition
commit fanning out to 28 files across 4 modules. Every archaeology citation checked out
real. The design's #1 risk — over-promising / brochure mode — **did not materialize**;
the over-promise index was ~0. Every miss was a conservative **under-prediction**.

### Under-prediction diagnosis → prompt fixes (v0 → v1)

| # | Miss (predicted vs actual) | Diagnosis | v1 fix |
|---|---|---|---|
| U1 | **Entity count**: 49 predicted vs 94 actual `object.entity` (plus 20 projections + 15 values) | The run counted ORM `@Entity` classes and equated that with the future spine. But the spine models the **database, not the ORM layer**: junction tables, operational tables, and ORM-less tables all get modeled, read models become their own `object.projection`, payload shapes their own `object.value`. Even the raw class census was low (one mapping lane counted). | Mandatory **table-first census + reconciliation block** (prompt pass P2-a): reconstruct the live table set from the migration history; count ORM classes on *every* lane; anchor predicted `object.entity` ≈ live tables and predict the projection/value split explicitly. The JSON twin gains a structured `census_reconciliation` object so this claim is scored mechanically. |
| U2 | **JSONB → value-object modeling under-headlined** (actual: 12 `field.object` + 15 `object.value` — a sizeable workstream; the human plan called opaque JSON columns a headline drift source) | The v0 contract had no mandated pass for opaque JSON columns. The drift signatures hunt *duplicated* declarations; an opaque `jsonb` column is the inverse smell — a shape with N **implicit** declarations (every `readValue`/`JSON.parse` call site) and **zero** checkable ones — so it fell through to a footnote ("`field.map`, typed later" — legal vocabulary, wrong weight). | Mandatory **opaque-payload hunt** (P2-b): grep DDL for `json/jsonb` + the per-port deserialization idioms; classify each column typed-somewhere (duplicate) vs fully-opaque (implicit-copy variant of drift signature 6); report counts in the census; carry `object.value` + `field.object @storage: jsonb` modeling as a **named migration-wave item**. |
| U3 | **UI**: "nothing migrates" vs 5 `layout.dataGrid` actually authored | Two conflations: (a) UI-surface *detection* was React-scoped, so a server-rendered admin (tables with columns/sort/pagination) didn't register as a UI surface; (b) `layout.dataGrid` **metadata** (cross-port registry vocabulary, cheap to author on any port) was conflated with the grid **codegen/runtime** (genuinely TS/React-only). | Renderer-agnostic UI census (P2-c): a UI surface is anything grid-shaped, including server-rendered templates. The UI verdict is **two lines, never one**: UI-metadata authoring (cross-port; captures column/sort/page-size facts into the spine today) vs UI codegen+runtime (TS-only cap). "Nothing migrates" is only permitted on the second line. |
| U4 | **Spine size ~2.5× low** (3.2–4k YAML lines predicted vs ~10k actual; ~40–60 vs ~106 lines/entity) | Flat lines-per-entity guess ignoring DDL richness. The actual vocabulary histogram is dominated by physical structure — `index.lookup` 319, `identity.reference` 117, `identity.secondary` 48 — i.e. indexes/FKs/unique keys are spine lines too. Compounded by U1's low object count. | **DDL-richness-derived estimator** (P6): count per-table indexes + uniques + FKs + enum-CHECKs and pick the lines-per-entity band accordingly (~25–40 bare; ~80–120 index/FK-rich), multiplied by the *reconciled* object count. |
| U5 | **Runtime/persistence ceiling omitted**: "the ORM is not replaced" stated as flat fact; the actual adopter later moved to metadata-driven persistence (ObjectManagerDB, then generated Kotlin/Exposed entities, generated-base + hand-written-subclass ownership) | The run capped "what migrates" at the detected language's **stock generator lane** (Java/Spring generates DTOs/controllers/repo interfaces, not entities) and over-applied metadata-follows-the-code to the *end state* rather than the wave order — omitting the JVM's Kotlin lane (`codegen-kotlin` generates entity + Exposed table) and scaffold-and-own's owned-generator lever. | **Floor/ceiling rule** (M7 + P5-b): verdicts, plan, and benefit numbers stay on the conservative floor, but one clearly-labeled "deep-adoption ceiling" paragraph names the port's maximal lane, tagged `horizon: "later"` in JSON and never counted in benefits. Bounds the under-promise index without reopening over-promise risk. |
| U6 | *(calibration nudge)* projection vocabulary led with `origin.aggregate`; the actual spine used `origin.passthrough` 42× and aggregates ~0 | Aggregates are the flashier suggestion; real projections are mostly passthrough/`extends` re-exposures. | The §R6 projection hunt now states: lead with `origin.passthrough`; aggregates are the minority case. |

**Deliberately unchanged** — the machinery that produced the honest, grounded result is
frozen: the worked disqualifier table, `file:line`/commit evidence discipline, the git
archaeology + cost-of-change exhibit, bias-to-under-flagging with the >15%
false-positive kill criterion, the per-port calibration caps, metadata-follows-the-code
+ author-from-the-live-schema (the run independently converged on the same
reverse-engineer-from-the-live-schema methodology the human plan chose — now codified as
rule M6), and the wedge-first plan shape. One negative check also passed: the run's one
unusual vocabulary choice (`field.map`) was verified **registered** — the grounding rule
(every capability claim traceable to `expected-registry.json`) held; no hallucinated
vocabulary.

The refined, self-contained, target-agnostic prompt (v1) folds in U1–U6 and is the
draft content for the future `assess.md` / skill source below.

### Build sequence (forward)

1. **Land the skill** — `agent-context/skills/metaobjects-fit-assessment/` with
   `SKILL.md` = prompt v1, `scaffold: false` (excluded from `meta init`, §7.2),
   single-sourced with the audit's `capability-checklist.md` + calibration table, and
   covered by the `agent-context-capability-grounding` test.
2. **Build the retro-test harness** (§6.3 ground-truth extraction script + §6.4 scoring
   sheet) so scoring is mechanical, not hand-adjudicated prose. The structured
   `census_reconciliation` JSON block and the `horizon` tag were added to the contract
   for exactly this.
3. **Regression run on Adopter A** with v1: the five under-predictions must close
   (entity count within the reconciliation band, JSONB as a named wave item, UI split
   verdict, spine estimate within ×/÷2, ceiling paragraph present) while drift precision
   and the over-promise index do not regress.
4. **Holdout gate**: one blind run on the Adopter-B baseline + the negative controls,
   scored once with no tuning — **this is the publish gate** for `assess.md`. Collapse
   on the holdout relative to Adopter A = overfit; loop to step 3 with the failure
   analysis, never tune on B.
5. **Productize** per Phase 3 (assembler flatten step, publish to the site + mirror
   into `docs/llms/`, `llms.txt` section, README/getting-started pointers, release-flow
   version stamping).

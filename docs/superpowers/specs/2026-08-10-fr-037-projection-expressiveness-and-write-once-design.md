# FR-037 — Projection expressiveness (`origin.rank` + a per-field SQL escape) and caller-supplied write-once fields

**Date:** 2026-08-10
**Status:** Requirements (pre-design). This doc states WHAT and WHY with acceptance criteria; it is not an implementation plan. Where a design decision is genuinely open it is marked **OPEN** with the options framed — the design phase resolves those, not this doc.
**Provenance:** [`spec/design-docs/2026-08-10-metamodel-gaps-from-requirements-modeling-spike.md`](../../../spec/design-docs/2026-08-10-metamodel-gaps-from-requirements-modeling-spike.md) — six metamodel gaps (G1–G6) surfaced as by-products of a 20-agent requirements-modeling spike, of which 8 greenfield runs authored a full model against a one-page stakeholder brief. Replication counts below are out of those 8 runs.
**Relates to:** [ADR-0037](../../../spec/decisions/ADR-0037-metamodel-vocabulary-expansion-decision-framework.md) (vocabulary-expansion decision procedure — applied explicitly per requirement below), [ADR-0023](../../../spec/decisions/ADR-0023-strict-metadata-provenance.md) (never invent an attr; registry-conformance gating), [ADR-0043](../../../spec/decisions/ADR-0043-ddl-ownership-escape-valves.md) (`@sql`/`@unmanaged` escape valves), [ADR-0045](../../../spec/decisions/ADR-0045-generated-api-surface-owns-write-semantics.md) (the generated API surface owns write semantics), [ADR-0028](../../../spec/decisions/ADR-0028-object-taxonomy-projection-value-purity.md)/[ADR-0029](../../../spec/decisions/ADR-0029-entity-child-extends-and-via-inference.md) (projection taxonomy; `@via`/ordering grammar), [ADR-0015](../../../spec/decisions/ADR-0015-single-shared-migrate-engine.md) (schema lowering is TS-owned), FR-013 (`@readOnly`, [design doc](2026-05-28-fr-013-field-read-only-design.md)), FR-035/FR-036 (PATCH tristate; wire-tier constraint enforcement), #211 (backend-agnostic projection materialization), #195 (origins are semantic; "anything that only makes sense for an RDB is a defect"), #210 (assembly origins live on projections).

## Why this doc exists

The spike's agents were not hunting for metamodel holes — they were trying to finish a
modelling task and hit walls. That provenance is the sequencing argument: each gap below
was hit by an agent trying to express a *real stakeholder rule*, and the replication
count says how often. Two of the walls sit exactly where the findings doc says the cost
is highest:

> "The one rule the officer says the scheme lives or dies on is the one place the
> metadata is not the single source of truth."

This FR turns the **accepted subset** of those findings into requirements:

| # | Requirement | Findings gap | Replication | ADR-0037 verdict (shown in full below) |
|---|---|---|---|---|
| R1 | `@writeOnce` — caller-supplied write-once field | G4 | 2 of 8 | **attribute** (2c, boolean exception-flag) |
| R2 | Per-field SQL escape on a synthesized projection | buried under G1 | 8 of 8 (every run paid the all-or-nothing `@sql` cost) | **attribute** (step 1, physical-only) |
| R3 | `origin.rank` — a ranking/window origin | G1 | 8 of 8 | **subtype** (2a, own behavior + own attrs) |
| R4 | Run-length / gaps-and-islands | G3 | 4 of 8 | acceptance case of R3 — no vocabulary of its own |

G2 (forbidden-combination validator), G5 (state transitions) and G6 (access control) are
**parked**, each with its reason, in the [Parked](#parked--not-in-this-fr) section.

**One correction to the findings doc, so it does not propagate:** G3 lists `first` as a
member of `origin.aggregate @agg`. It is not. The registered `@agg` set is
`count | sum | avg | min | max | any | all | collect` (verified against
`fixtures/registry-conformance/expected-registry.json`); `first` is an origin
**subtype** (`origin.first` — argmax-then-project, with its own `@orderBy`/`@of`/`@via`/`@filter`).
The registered origin subtypes are `aggregate, base, collection, computed, first,
passthrough` — there is no window/rank construct, which is exactly G1.

## Shared obligations (apply to every requirement here)

These are stated once and are binding on R1–R3 individually:

1. **ADR-0023 strict provenance.** Every new attribute or subtype in this FR requires
   (a) a **written can't-be-computed justification** — the ADR-0037 walks in this doc
   are the draft; the design phase carries them into the shipping spec/ADR text — and
   (b) a **`registry-conformance` fixture**: the addition lands in
   `fixtures/registry-conformance/expected-registry.json` and in every port's registered
   provider so all five ports (TS / C# / Java / Kotlin / Python) gate the vocabulary
   byte-identically. This repo boots strict and seals the registry — an unregistered
   attr is `ERR_UNKNOWN_ATTR` at load, so there is no soft-landing path.
2. **ADR-0037 §"Consistency corollaries".** Any closed value-set introduced here ships
   with `allowedValues` in the registry gate (ADR-0036 discipline).
3. **Cross-port scope split follows ADR-0043 §4's precedent.** Registration + loader
   validation + resolving accessors: **all five ports**, conformance-gated by shared
   `fixtures/conformance/` error fixtures. Schema/DDL **lowering**: **TS-only**
   (ADR-0015 — the other ports have no migrate engine to change).
4. **New error codes are proposals.** Codes marked **(new)** below do not exist yet;
   they enter the shared error-code ledger (TS `errors.ts` exact-bidirectional, plus the
   Python/Java registries) as part of the design phase, per the ADR-0044/#219 ledger
   precedent. Codes cited without the marker (`ERR_ORIGIN_UNDER_SQL_BODY`,
   `ERR_BAD_ATTR_VALUE`, `ERR_SUBTYPE_RULE_VIOLATION`, `ERR_READONLY_DOWNGRADE`,
   `WARN_READONLY_VALUE_OBJECT`, …) are verified to exist today.
5. **Versioning.** Everything here is additive — metadata not using the new vocabulary
   produces byte-identical output (pinned by no-churn tests, per the ADR-0043/#238
   precedent). Registered-vocabulary additions have shipped as coordinated PATCH before
   (`@maxTokens` in 0.20.5, `@lenient` in 0.20.6); the release-line placement is a
   release-time call, but nothing in this FR is breaking.

---

## R1 — `@writeOnce`: a caller-supplied field settable on create, never on update (G4, 2 of 8)

### The case

"An application's date of record and an inspection's evidence trail must be settable
once, never rewritten." The metamodel has no way to say this today:

- `@readOnly` (FR-013, registered on `field.base`) means *never* application-written —
  it is omitted from **both** the insert and update settable sets (verified:
  `server/typescript/packages/codegen-ts/src/generators/api-field-shape.ts` documents
  the InsertSchema walk as "auto-gen PK omitted, `@readOnly` omitted, …"). That is the
  wrong shape: a date of record is *caller-supplied at create*.
- `@autoSet: onCreate` (registered on `field.timestamp` only, values
  `onCreate | onUpdate`) is write-once **by construction** — but the **server** supplies
  the value and caller-supplied values are ignored (ADR-0045 §3). A caller-chosen
  application date is not expressible; nor is any non-timestamp write-once field.

In the spike, one run carried the rule as a comparison invariant plus an amendment-note
field; another as prose. Neither is enforced by the generated write surface.

### ADR-0037 walk (the ordered test, applied)

- **Step 0 — derivable?** No. The closest existing metadata is `@autoSet: onCreate`,
  and the difference is precisely the non-derivable bit: `@autoSet` declares *the server
  supplies the value* (caller input ignored); write-once-ness with a *caller-supplied*
  value is a distinct contract no combination of existing subtype + attrs + structure
  implies. `@readOnly` cannot derive it either — it excludes the create path.
- **Step 1 — physical-only?** No. Like `@readOnly` (FR-013's explicit layer-placement
  finding), it changes the generated write surface and native binding — a logical
  concern, not introspectable from `information_schema`.
- **Step 2 — thing / kind / modifier?** It has no native type, no behavior of its own,
  no child vocabulary — it **modifies the write behavior of an existing field**. That is
  2c: an **attribute**, and specifically the 2c "boolean exception-flag" shape (the
  common case is absent; never a default-true opt-out).

**Verdict: boolean attribute `@writeOnce` on `field.base`** (common field attrs,
inherited by every subtype — the same registration home as `@readOnly`, registered by
the core field provider, not the db provider). Name: `@writeOnce` self-documents the
one-shot semantics; `@immutable` was rejected as ambiguous against `@readOnly`
(ADR-0037 "self-documentation over economy").

### The write-semantics pair (specified together or they drift)

R1's normative core is a **two-axis contract** — *who supplies the value* × *when it may
be written* — and `@writeOnce` must be documented and gated alongside `@autoSet`, its
server-supplied counterpart, because they share one enforcement mechanism:

| declaration | supplied by | settable on POST | settable on PATCH |
|---|---|---|---|
| (plain field) | caller | yes | yes |
| `@writeOnce` **(this FR)** | **caller** | **yes** | **no — excluded from the settable set** |
| `@autoSet: onCreate` | server | no (server stamps; caller value ignored) | no |
| `@autoSet: onUpdate` | server | no (server stamps) | no (server re-stamps) |
| `@readOnly` | nobody (DB/trigger/external owner) | no | no |

This table is itself a deliverable: it lands in the attr descriptions and the API-contract
docs so the pair cannot drift apart (the findings doc's explicit warning).

### Requirements

1. **Create path.** A `@writeOnce` field is a normal settable field on POST: validated
   per FR-036, present-required when `@required` (with the existing carve-outs — a
   `@default` supplies the once-written value when the caller omits it).
2. **Update path.** A `@writeOnce` field is **excluded from the PATCH settable set** —
   the exact mechanism that excludes `@autoSet: onCreate` from the UpdateSchema walk
   today (verified in `api-field-shape.ts`: "update-payload → the UpdateSchema walk: TPH
   discriminator + `@autoSet`-onCreate omitted"). This includes the FR-035 present-null
   arm: clearing is a write, so a present-null `@writeOnce` key gets the same excluded
   treatment as any other write to it.
3. **ADR-0045 applies verbatim.** The **outermost generated write artifact** an adopter
   deploys enforces the exclusion — no consumer-supplied seam may sit between the
   guarantee and the wire. Vanilla **and** TPH per-subtype surfaces, in all five ports
   (the 0.19.4 lesson: the TPH surface is a separate unstamped code path per port unless
   gated). Persistence-layer exclusion (ObjectManager / OMDB / Exposed / EF) is retained
   as the carrier for non-HTTP writes, per ADR-0045 §2.
4. **Loader validation (all five ports; error fixtures in `fixtures/conformance/`):**
   - `@writeOnce` + `@readOnly` on the same field → contradiction (one says
     caller-writes-at-create, the other says the application never writes) →
     `ERR_WRITEONCE_CONFLICT` **(new)**.
   - `@writeOnce` + `@autoSet` on the same field → contradiction on the supplied-by
     axis → `ERR_WRITEONCE_CONFLICT` **(new)**.
   - `@writeOnce: false` overriding an inherited `@writeOnce: true` → rejected,
     mirroring `ERR_READONLY_DOWNGRADE` (max-restrictive wins across `extends`) —
     either reuse a generalized downgrade rule or mint the sibling code; **design-phase
     choice**, but the no-downgrade behavior itself is required.
   - `@writeOnce` on a field child of an `object.value` → WARN, mirroring the shipped
     `WARN_READONLY_VALUE_OBJECT` (values have no generated write surface; the attr may
     still inform record/`val` treatment).
   - `@writeOnce` on a field of a read-only host (projection / read-only `@kind`) →
     WARN (no write surface exists to enforce it against; benign, mirrors the R6-style
     "documented but unacted-on" treatment).
5. **OPEN — presented-key hardening.** Today an excluded key presented on PATCH is
   silently stripped (Zod `.object()` strips unknown keys; ADR-0045 pins
   "caller-supplied `@autoSet` values are ignored"). For `@writeOnce` the caller *owns*
   the value at create, so a presented PATCH key is more plausibly a client bug:
   - **Option A — ignore** (strip): zero new machinery, exactly the `@autoSet`
     precedent; the cost is a silent non-update on a field the client believed it
     changed.
   - **Option B — 400 on any present `@writeOnce` key in a PATCH body**: fail-closed
     (the FR-035/FR-036 lean), but new cross-port rejection machinery, and it must be
     pinned identically in five ports (see the parked-G2 section for what pinning
     write-time semantics across five ports costs).
   The design phase picks one and gates it in `api-contract-conformance` in both lanes;
   this doc deliberately does not.

### Acceptance criteria

- Registry: `@writeOnce` registered on `field.base` in all five ports;
  `expected-registry.json` updated; registry-conformance green.
- Conformance fixtures: canonical round-trip preserves the attr; the two
  `ERR_WRITEONCE_CONFLICT` error fixtures and the downgrade fixture green in all five
  ports; the value-object WARN unit-tested per port (the corpus has no warn-fixture
  mechanism — ADR-0043 §4 precedent).
- `api-contract-conformance`, both lanes (reference server AND generated artifact over
  HTTP), every port, vanilla AND TPH: a POST sets a `@writeOnce` field; a subsequent
  PATCH carrying a new value for it leaves the stored value unchanged (and, per the
  resolved OPEN item, either 200-ignores or 400s — asserted identically everywhere);
  a PATCH not naming it leaves it unchanged; present-null does not clear it.
- No-churn: output for metadata with no `@writeOnce` is byte-identical.
- The supplied-by × settable-when table published in the attr description and docs.

---

## R2 — a per-field SQL escape on a synthesized projection (buried under G1; cost paid in 8 of 8 runs)

### The case

ADR-0043 gave a projection two escape valves — `@sql` (author-supplied whole body) and
`@unmanaged` — and made `@sql` deliberately **all-or-nothing**: rules R4/R5 in
`server/typescript/packages/metadata/src/persistence/source/validate-source-escapes.ts`
raise `ERR_ORIGIN_UNDER_SQL_BODY` both for an `origin.*`-bearing field under an `@sql`
host and for a projection-level `@filter` (#207) under an `@sql` host, because two
bodies for the same data is a two-sources-of-truth defect.

The spike showed the price of that granularity: every one of the 8 runs hit **one**
irreducible column (the rank — R3) and thereby lost **every** column of the projection
to hand-written SQL — origins gone, `@filter` gone, the whole read model opaque. The
findings doc's closing judgment is blunt and correct:

> "The escape-valve composition problem noted under G1 — `@sql` being all-or-nothing
> per projection — may be more valuable than any single gap on this list, since it
> bounds the blast radius of every future irreducible column."

R3 removes *this* wall, but there will always be a next irreducible column (recursive
CTEs, lateral joins, vendor functions). R2 is the containment mechanism and is valuable
independently of R3.

### ADR-0037 walk

- **Step 0 — derivable?** No — by construction. The escape exists precisely for the
  column the `origin.*` vocabulary cannot express. (Where an origin *can* express it,
  the escape is the wrong tool and the docs must say so — same posture as ADR-0043's
  "genuinely-irreducible" bar.)
- **Step 1 — physical-only?** **Yes — decisive**, and it is the *same* verdict ADR-0043
  §2 reached for `@sql`: the fragment changes no native type and no logical meaning.
  The field still declares its `field.<subType>`, which types the read model and the
  wire; the SQL text is a pure physical-DDL payload, the same category as the existing
  raw-SQL escapes (`@sql` on the source; `@expr`/`@where` on `identity.secondary` /
  `index.lookup`, both registered by the db provider as "RDB-physical").

**Verdict: a per-field attribute in the physical-escape category** — not a subtype (the
field is not a new kind of thing), not a `@kind` (no structural variant of a subtype),
and emphatically **not a new `origin.*` member**: `origin.*` is the *semantic*
derivation vocabulary, and per #211/#195 a construct that only makes sense for an RDB
does not belong in it ("anything that only makes sense for an RDB is a defect"). The
escape is a **lowering fragment**, and it must live where physical lowering concerns
live.

### OPEN — name and host

- **Name.** Candidates: `@sqlExpr` (lean) vs reusing `@sql` on the field. ADR-0037's
  "same concept → same attr name" corollary pulls toward `@sql`; its
  "never same-name-different-meaning" corollary pulls away — the source-level `@sql` is
  a full view **body**, the field-level escape is a single SELECT-list **expression**,
  and the two have different validation and different embedding. Note also that bare
  `@expr` is already carrying two meanings in the registry (raw SQL string on
  `identity.secondary`/`index.lookup`; the portable `attr.expression` AST on
  `origin.computed`) — the new name should not extend that overload, which argues for
  the explicit `@sqlExpr`. Design phase decides; this doc leans `@sqlExpr`.
- **Host.** An attr directly on the projection-hosted field (sibling of `@column` /
  `@dbColumnType`, contributed by the db provider) is the lean. An alternative host —
  a child node under the field — was considered and rejected in-principle above (any
  child-node shape drifts toward looking like an origin, which #211 forbids).

### Requirements

1. **Composition is the point.** Under a host whose view body the tool synthesizes,
   a field carrying the escape contributes its SQL expression **verbatim** into the
   synthesized SELECT list; **sibling fields keep their `origin.*` derivations** and the
   projection-level `@filter` keeps lowering to the synthesized outer `WHERE`.
   ADR-0043's R4/R5 remain untouched for `@sql` hosts — the tool still owns exactly one
   body; one column of it is now author-supplied.
2. **Never parsed, honestly costed.** Like `@sql`, the fragment is registered,
   embedded, and fingerprinted **but never parsed**: no reference validation, no
   dialect portability, failure surfaces at apply time. The docs must state this cost
   plainly, and the authoring guidance must present the escape as the *last* resort
   after `origin.*` (including R3) — the same "genuinely-irreducible" bar ADR-0043 sets,
   now at field granularity.
3. **#211 containment.** The escape is **not** derivation metadata. In #211's terms it
   pins the field to **one paradigm's lowering** (`source.rdb`, view kinds). The
   requirement on the future capability matrix: a projection containing an
   escape-bearing field is materializable to an RDB view and to nothing else; any
   non-RDB materialization of it must fail at **load time** with a clear error — #211's
   "clear error, not silent omission" lesson. Until the matrix exists, the RDB view
   synthesis is the only consumer and nothing silently drops the field.
4. **Loader validation (all five ports; error fixtures):**
   - Escape + `origin.*` on the **same field** → two derivations for one column →
     `ERR_ORIGIN_UNDER_SQL_BODY` (reuse — it is the same defect class at field scope)
     or a sibling code **(design-phase choice)**.
   - Escape on a field under an **`@sql` host** → the author already owns the whole
     body; a second owner for one column is the R4 defect inverted → error (same code
     family).
   - Escape on a field under an **`@unmanaged` host** → the tool acts on nothing; WARN,
     mirroring `WARN_ORIGIN_UNDER_UNMANAGED` (R6 symmetry).
   - Escape on a field of a host with **no synthesized view** (a plain table entity, a
     sourceless projection) → nothing to embed it in → error; exact code design-phase.
   - Empty/whitespace value → `ERR_BAD_ATTR_VALUE` (R3-of-ADR-0043 symmetry).
5. **Providability.** The projection validation chain (ADR-0028: every declared field
   must be providable — `extends`-bound / origin-derived / self-declared-under-external-
   assembly) accepts escape-supplied as a providability leg; the field is read-only like
   any derived field.
6. **Lowering + drift (TS-only, ADR-0015).** `build-projection-views` embeds the
   fragment; the existing whole-body view fingerprint covers it, so editing the fragment
   is drift and `meta verify --db` sees it — **no new drift machinery class**. The
   declared `field.<subType>` remains authoritative for the read model's types (the
   #270 doctrine: declared, never derived from the lowering).

### Acceptance criteria

- A projection with N fields, N−1 carried by `origin.*` + 1 by the escape: loads clean,
  `meta migrate` emits one synthesized `CREATE VIEW` embedding the fragment verbatim,
  `@filter` still lowers to the outer WHERE, and the emit→apply-to-real-engine→re-diff
  round-trip is EMPTY (the migrate idempotence gate).
- Editing the fragment in metadata produces view drift detectable by `meta verify --db`.
- All error/WARN fixtures above green in all five ports; registry-conformance green on
  the new attr; no-churn for models not using it.
- Docs: the escape documented beside ADR-0043's valves as the third rung of one ladder
  (origins → per-field escape → whole-body `@sql` → `@unmanaged`), each rung's cost
  stated.

---

## R3 — `origin.rank`: a declared ranking/window construct (G1, 8 of 8)

### The case

The spike brief's single most important rule is a queue: an offer goes to the
longest-waiting applicant, ties broken by a second key. A projection therefore needs
each row's **position** under an ordering, optionally within a partition. All 8 of 8
greenfield runs hit this wall; every one fell back to whole-projection `@sql`; two
independently observed that the declarative chain broke at the *most-argued-over* rule
rather than at the periphery. This is the highest-impact item in the findings doc.

Nothing registered today expresses it (verified against `expected-registry.json`):
`origin.aggregate` reduces a related set to one value per host row; `origin.first` is
argmax-then-project (one related row's column); `origin.computed`'s `@expr` is a
**closed, row-local** grammar (the `attr.expression` registry description: "field/value
refs, comparisons sharing the filter op vocabulary, isNull/isNotNull, and/or/not,
coalesce" — additive node kinds are #159). A rank depends on **other rows**, which no
row-local expression and no set-reduction can produce.

### ADR-0037 walk

- **Step 0 — derivable?** No — a position is a function of the *whole ordered row set*,
  and no composition of the registered origins yields it (aggregate collapses the set;
  first projects one row; computed is row-local by grammar).
- **Step 1 — physical-only?** No. A rank changes what the field *means* — it is a
  logical value with wire semantics (an integer position an API consumer sorts and
  pages by), not a storage detail. It must be specified semantically precisely so it is
  *not* an RDB passthrough (#211).
- **Step 2a — its own thing?** Yes on two of the three sufficient conditions: it has
  its **own behavior** (an ordering-dependent position over a row set — categorically
  different from `aggregate`'s reduction and `first`'s selection) and its **own
  required attributes** (partition keys, order keys with direction). The 2a litmus
  ("would I want to attach behavior or extra attributes to this later?") is plainly yes
  — tie disciplines, related-set windows, per-origin filters are all natural growth.

**Verdict: subtype `origin.rank`.** Two alternatives rejected explicitly:

- **A windowed `origin.aggregate`** (e.g. `@agg: rank`): rejected. `@agg` members share
  one semantic frame — *reduce the `@via`-related set to one value per host row* — and
  a rank is not a reduction, does not (in v1) traverse `@via`, and returns a
  per-row-of-the-projection value. Folding it in gives one attr two disjoint semantics,
  the ADR-0037-forbidden same-name overload, and misdescribes the data model.
- **An attribute on an existing origin**: rejected by the 2a test — it carries its own
  required configuration and its own lowering; it is not a modifier of anything.

### The semantic contract (#211 is load-bearing here)

Per #211, `origin.*` declares **semantic intent** and a SQL view is only **one
lowering**; per #195, "anything that only makes sense for an RDB is a defect". R3 is
therefore specified as a deterministic function of the row set — `ROW_NUMBER() OVER
(PARTITION BY … ORDER BY …)` is *a lowering of it*, never its definition:

> **`origin.rank` yields the 1-based position of the host projection's row within its
> partition, under a declared total order over the projection's base row set.**

Normative elements:

1. **Ordering grammar: reuse `origin.first`'s, verbatim.** `@orderBy` — ordering keys
   as `'field[:asc|desc]'` (default `asc`), nulls sort last, **the base entity's PK
   ascending appended as the deterministic tie-breaker**, "semantic — carries no SQL
   syntax". This doctrine is already registered and shipped on `origin.first`; R3 must
   reuse the attr name and grammar (ADR-0037 "same concept → same attr name") and the
   appended-PK rule makes the order **total**, so positions are unique, deterministic
   and gap-free — the `ROW_NUMBER` vs `RANK` vs `DENSE_RANK` distinction becomes a
   deliberately **deferred** tie-semantics question (a future `@ties` enum can relax
   totality if an adopter case demands peer-equal ranks), not a v1 ambiguity.
2. **`@partitionBy`** (string array of base-entity field references; optional): absent
   = one global partition; present = independent 1-based numbering per distinct key.
   Exact reference form (bare field names vs dotted paths) is design-phase, but it must
   follow the ADR-0029 addressing model rather than invent a new one.
3. **v1 scope: the self-window.** The rank is computed over the **projection's own base
   row set** — both spike cases (queue position; G3's run-length at child grain) are
   self-windows. A `@via`-scoped related-set rank ("this child's position among its
   parent's children" hosted on the parent side) is **deferred** until a case demands
   it; the subtype's attr shape must not preclude it.
4. **Determinism doctrine.** Same inputs ⇒ same positions, on every lowering, pinned by
   conformance probes whose seed data includes deliberate order-key **ties** (the
   de-blinding lesson: a corpus whose seed data is tie-free cannot see a
   nondeterministic tie-break).
5. **Typing.** Declared-authoritative per the #270 doctrine: the host field declares an
   integer subtype (`field.int`/`field.long`) and the loader validates agreement
   (extending the existing extends/origin-agreement pass). Unlike `origin.first`
   (empty related set ⇒ null ⇒ must not be `@required`), a rank is **total over the
   view's rows** — every visible row has a position — so a rank field MAY be
   `@required`; the contract must state this contrast.
6. **Evaluation time is the materialization's property, never the derivation's**
   (#211 doctrine): a query-time view computes positions per read; a matview at
   refresh; that difference lives on `source.rdb @kind`/`@role`, and `origin.rank`'s
   declaration is identical in all cases.
7. **Assembly-origin discipline (#210).** `origin.rank` joins the
   `ASSEMBLY_ORIGIN_SUBTYPES` set in every loader — value-hosted use fails
   `ERR_SUBTYPE_RULE_VIOLATION` automatically, as a property of the shared constant
   rather than a new branch.
8. **OPEN — interaction with the projection-level `@filter` (#207).** Is the position
   computed over the base row set **before** the row-scope filter, or over the
   **visible (filtered) row set**? Both are coherent: rank-then-filter preserves each
   row's global position (holes appear where rows are filtered out); filter-then-rank
   yields a dense 1..N over what the view shows (the "queue of *eligible* applicants"
   reading — the spike's case wants this one). This doc leans **filter-then-rank**
   (self-consistent output; matches the eligible-queue case) but the pin is
   design-phase and MUST be fixed by an explicit conformance probe with rows excluded
   by `@filter` — silence here is exactly how cross-port divergence ships.
9. **OPEN — a per-origin `@filter` on `origin.rank`** (scoping which rows join the
   window, as `origin.aggregate`/`origin.first` already have): plausible, deferred to
   design phase; v1 may ship without it.

### Requirements

1. Registry: `origin.rank` registered in all five ports with `@orderBy` (required) and
   `@partitionBy` (optional); `expected-registry.json` updated; registry-conformance
   green (Shared obligation 1).
2. Loader validation, all five ports: missing `@orderBy` →
   `ERR_MISSING_REQUIRED_ATTR`; unresolvable order/partition field references →
   the existing invalid-reference/`ERR_BAD_ATTR_VALUE` family (exact codes
   design-phase); non-integer host field subtype → the extends/origin-agreement error
   path; value-hosted → `ERR_SUBTYPE_RULE_VIOLATION` (via `ASSEMBLY_ORIGIN_SUBTYPES`);
   `origin.rank` under an `@sql` host → already covered by the existing R4 rule
   (`ERR_ORIGIN_UNDER_SQL_BODY`), fixture-pinned.
3. RDB lowering (TS-only, ADR-0015): `build-projection-views` synthesizes the window
   expression (`ROW_NUMBER() OVER (PARTITION BY … ORDER BY …, <pk> ASC)` on Postgres;
   SQLite window functions per the existing dialect split) honoring the resolved
   `@filter` pin; migrate idempotence gate (emit → apply to a real engine → re-diff
   EMPTY) applies.
4. Every port **reads** ranked projections: the persistence-conformance corpus already
   provisions each port's test DB from the committed TS-produced
   `canonical/schema.postgres.sql`, so a ranked-view scenario exercises all five ports'
   read paths against the same lowered schema.
5. Cross-lowering parity: any other evaluator of projection derivations that claims
   rank support (e.g. an in-memory driver, a future #211 paradigm) must implement the
   semantic contract and pass the same scenario fixtures; one that does not support it
   must **error, not silently omit** (#211). This FR does not require any new lowering
   beyond the RDB view.

### Acceptance criteria

- **The spike's queue case, end-to-end:** a waiting-list projection declaring
  `origin.rank` (`@orderBy: ["appliedAt:asc"]`, tie broken deterministically by the
  appended PK; optionally `@partitionBy` a site key) loads, migrates, round-trips the
  idempotence gate, and serves correct positions over HTTP through the generated
  read surface — with seed data containing **ties on `appliedAt`** and (per the
  resolved `@filter` pin) rows excluded by a row-scope filter, asserted identically in
  every port's lane.
- Determinism probe: two applies of the same seed in different insert orders produce
  identical positions.
- All loader error fixtures green in five ports; registry-conformance green; no-churn
  for models without `origin.rank`.
- R4 below.

---

## R4 — run-length / gaps-and-islands (G3, 4 of 8) — an acceptance case of R3, not a feature

**Decision: R4 adds no vocabulary.** The findings doc's own ADR-0037 read stands: a
run-length is a window construct and should fall out of G1. Encoding it as a dedicated
`@agg` member would violate step 0 the moment R3 exists.

**The case (normative acceptance scenario for R3):** an `Inspection` entity
(`plotId` FK, `inspectedAt`, `grade` enum including `Neglected`); the stakeholder rule
is "two consecutive `Neglected` inspections trigger a warning; three take the plot
back." The spike's runs resolved this with denormalised snapshot state three different
ways — the shape "most likely to be silently wrong in a real adopter model".

**Acceptance criterion:** the R3 design phase MUST demonstrate a fully
metadata-declared model in which "length of the trailing run of a given grade per plot"
is expressible by composing `origin.rank` with **existing** vocabulary, and gate it
with a persistence-conformance scenario whose seed data includes **interrupted runs**
(`Neglected, other, Neglected` — the probe that distinguishes a run from a count; an
uninterrupted-only corpus is blind to the whole feature).

*Non-normative plausibility sketch* (a design argument, not a design): at inspection
grain, the classic rank-difference construction — `seq` = rank per plot ordered
`inspectedAt:desc`, `seqInGrade` = rank per (plot, grade) ordered the same way — makes
`seq = seqInGrade ∧ grade = 'Neglected'` characterize the trailing Neglected run, a
row-local comparison plausibly within `origin.computed`'s existing grammar; a
parent-grain rollup then needs an aggregate over those rows. Two composition edges are
**unproven** today and are exactly what the acceptance case must force the design to
settle: (a) whether `origin.computed` may reference **sibling derived fields** of the
same projection, and (b) whether a parent-level `origin.aggregate` can traverse to a
**child-grain projection's** rows rather than an entity's. If either edge cannot be
closed with R3 + existing vocabulary, the design doc must name the missing piece and
bring it back to this FR — **the requirement is the case, not a mechanism**, and R4 is
not satisfied by prose, by a snapshot counter column, or by the R2 escape.

---

## Parked — not in this FR

### G2 — forbidden-combination / predicate validator (5 of 8): re-scoped, not adopted

The findings doc calls this "cheap because the `attr.filter` AST already exists and is
cross-port". **This FR pushes back on that costing: `attr.filter` makes the *syntax*
free, not the *semantics*.** A predicate **validator** means all five ports must
evaluate an arbitrary predicate AST **identically at write time**: three-valued logic
over NULLs, absent-vs-null under the FR-035 tristate, coercion at type boundaries,
short-circuit order, and the POST-vs-PATCH partial-payload question (what does a
cross-field predicate mean when the PATCH carries only one of the fields?). The
evidence for what that costs is in this repo's own history: FR-036's pre-release
adversarial review found **11 cross-port divergences in one pass** for pins far simpler
than this (is a `@required` string non-empty; is `validator.regex` a full match) — and
those had no AST evaluator, just scalar rules. Today `attr.filter`'s write-time
consumers are query-shaped (`origin.aggregate @filter`, projection `@filter`) where the
single SQL engine evaluates it; a validator moves evaluation into five generated write
surfaces.

**Parked as:** *syntax free, semantics a conformance program* — a future FR sized
comparably to R3 (a semantic contract + a five-port conformance corpus with adversarial
NULL/tristate probes), not to R1. The 5-of-8 replication says it deserves that FR; it
must not ship as a rider on this one. (Registered validator subtypes today:
`array, atLeastOne, base, comparison, length, numeric, presentIff, regex, required,
requiredWhen` — no forbidden-combination form; the gap is real, only the "cheap" is
wrong.)

### G5 — state transitions (2 of 8)

Parked. A transition model overlaps FR-024's declared-API surface: a legal-transition
rule is arguably a **post-condition of an `operation.command`**, not a property of a
`field.enum`, and designing it from a requirements spike would pre-empt the FR-024
surface where it more likely belongs (guards, effects and concurrency give it a long
tail). Recorded so the next proposer knows it has been hit in practice.

### G6 — access control (3 of 8)

Parked — **blocked on FR-024**. `api.*` is chartered by ADR-0030 but has **zero
subtypes registered** today (verified against `expected-registry.json`), so there is no
node an authorization requirement can attach to; nothing here is independently
actionable. The sequencing signal is worth keeping: access control was the **single
largest category** of requirement the metamodel could not reach in the spike — useful
1.1 prioritization evidence for FR-024's declared-API work.

---

## Out of scope / non-goals

- **Any new `@agg` member** (including a rank or run-length member) — R3 is a subtype;
  R4 is composition.
- **`@via`-scoped related-set rank** — deferred (R3 §3); the attr shape must not
  preclude it.
- **Tie-semantics variants** (`RANK`/`DENSE_RANK`-style peer ranks) — deferred behind
  the total-order doctrine (R3 §1).
- **Non-RDB lowerings of `origin.rank`** — #211's program; R3 only obligates the
  semantic contract and the error-not-omission rule so it slots in.
- **The G2/G5/G6 constructs** — parked above with reasons.
- **DDL machinery for `@writeOnce`** — like `@readOnly` (FR-013), it emits no DDL; the
  write surface enforces it.
- **Retro-fitting `@autoSet` beyond `field.timestamp`** — the pair table documents
  today's registration truthfully; widening `@autoSet` is a separate proposal.

## Definition of done (requirements-level)

- R1–R3 each carried through the design phase with their ADR-0037 walks and
  can't-be-computed justifications recorded in the shipping design docs/ADRs
  (Shared obligation 1a), every OPEN item above explicitly resolved and
  conformance-pinned, and all acceptance criteria green across the five ports.
- R4's acceptance case demonstrated end-to-end or its blocking gap named and returned
  to this FR.
- The parked section's reasoning carried into whatever future FR picks G2 up, so
  "cheap because the AST exists" does not get re-argued from scratch.

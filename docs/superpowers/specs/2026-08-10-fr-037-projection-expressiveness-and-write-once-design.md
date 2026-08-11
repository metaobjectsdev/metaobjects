# FR-037 — Projection expressiveness (`origin.rank` + origin-vocabulary hygiene) and field write-access modes (`@mutability`)

**Date:** 2026-08-10. **Revised 2026-08-11 (pass 1, maintainer review):** R1 reshaped from a `@writeOnce` boolean to a single `@mutability` mode enum (breaking — retires `@readOnly`); a new R2 added (origin-vocabulary hygiene — retire `origin.collection`); the per-field SQL escape demoted from a required R2 to a **conditional** R5 per the project's SQL-stays-semantic doctrine. **Revised 2026-08-11 (pass 2):** every OPEN item **decided** against code evidence — see the [Resolved decisions](#resolved-decisions-review-record) table; the R4 composition edges investigated and **closed-negative** (the finding, with the precisely-named missing vocabulary, is carried in R4); one of this doc's own pass-1 claims corrected (the projection-level `@filter` supports the full per-subtype operator band — verified — so static range-scoped ranks ARE expressible; only the origin-level `@filter` is narrow). **Revised 2026-08-11 (pass 3, maintainer ruling):** *"the semantic concepts must work against other persistence layers, not just an RDB — if it's RDB-only, it isn't semantic; writing the functions in adapter code to satisfy a backend is okay."* The per-field SQL escape is **rejected outright in any form** and R5 is recast as an additive **semantic expression-capability program** (typed `fn` vocabulary + a cross-backend capability matrix) — supersedes decision D10. `origin.rank` was re-audited against the matrix, prepared to reverse R3, and **survives** (MongoDB has native window operators; the search paradigm gates to refresh-time per #211).
**Status:** Requirements (pre-design), decisions resolved. Remaining deliberate deferrals each carry a named re-entry trigger; nothing is left open by default.
**Provenance:** [`spec/design-docs/2026-08-10-metamodel-gaps-from-requirements-modeling-spike.md`](../../../spec/design-docs/2026-08-10-metamodel-gaps-from-requirements-modeling-spike.md) — six metamodel gaps (G1–G6) surfaced as by-products of a 20-agent requirements-modeling spike, of which 8 greenfield runs authored a full model against a one-page stakeholder brief. Replication counts below are out of those 8 runs. R2 has a second provenance: the maintainer's review of this FR itself.
**Relates to:** [ADR-0037](../../../spec/decisions/ADR-0037-metamodel-vocabulary-expansion-decision-framework.md) (vocabulary-expansion decision procedure — applied explicitly per requirement below), [ADR-0023](../../../spec/decisions/ADR-0023-strict-metadata-provenance.md) (never invent an attr; registry-conformance gating; sealed strict registry), [ADR-0007](../../../spec/decisions/ADR-0007-source-v2-paradigm-subtypes-multisource.md) Amendment 2 (the registry re-entry bar), [ADR-0040](../../../spec/decisions/ADR-0040-index-type-and-secondary-key-purity.md) (the reserved-not-registered treatment), [ADR-0043](../../../spec/decisions/ADR-0043-ddl-ownership-escape-valves.md) (`@sql`/`@unmanaged` escape valves), [ADR-0045](../../../spec/decisions/ADR-0045-generated-api-surface-owns-write-semantics.md) (the generated API surface owns write semantics), [ADR-0028](../../../spec/decisions/ADR-0028-object-taxonomy-projection-value-purity.md)/[ADR-0029](../../../spec/decisions/ADR-0029-entity-child-extends-and-via-inference.md) (projection taxonomy; `@via`/ordering grammar), [ADR-0015](../../../spec/decisions/ADR-0015-single-shared-migrate-engine.md) (schema lowering is TS-owned), FR-013 (`@readOnly`, [design doc](2026-05-28-fr-013-field-read-only-design.md)), FR-035/FR-036 (PATCH tristate; wire-tier constraint enforcement), #211 (backend-agnostic projection materialization), #195 (origins are semantic; "anything that only makes sense for an RDB is a defect"), #210 (assembly origins live on projections), #270 (declared-authoritative payload typing; deleted `origin.collection`'s last consumer), #159 (the chartered additive-expression-capabilities umbrella, cited by the `attr.expression` registry description).

## Why this doc exists

The spike's agents were not hunting for metamodel holes — they were trying to finish a
modelling task and hit walls. That provenance is the sequencing argument: each gap below
was hit by an agent trying to express a *real stakeholder rule*, and the replication
count says how often. Two of the walls sit exactly where the findings doc says the cost
is highest:

> "The one rule the officer says the scheme lives or dies on is the one place the
> metadata is not the single source of truth."

This FR turns the **accepted subset** of those findings into requirements, plus one
vocabulary-hygiene requirement the review of this FR itself surfaced:

| # | Requirement | Provenance | Replication | ADR-0037 verdict (shown in full below) | Status |
|---|---|---|---|---|---|
| R1 | `@mutability` — one write-access mode per field (readWrite / writeOnce / readOnly) | G4 | 2 of 8 | **attribute** (2c, closed-set enum) | required; **BREAKING** (retires `@readOnly`) |
| R2 | Origin hygiene — retire `origin.collection` to reserved-not-registered | maintainer review of this FR | — | fails the 2a bar against `origin.aggregate` | required; **BREAKING** |
| R3 | `origin.rank` — a ranking/window origin | G1 | 8 of 8 | **subtype** (2a, own behavior + own attrs) | required |
| R4 | Run-length / gaps-and-islands | G3 | 4 of 8 | acceptance case of R3 — no vocabulary of its own | child-grain half gated in v1; **full closure blocked — two named vocabulary gaps carried as findings** |
| R5 | Semantic expression capabilities — typed `fn` vocabulary growth + a cross-backend **capability matrix** (replaces the REJECTED per-field SQL escape) | buried under G1; maintainer ruling (pass 3) | 8 of 8 paid the all-or-nothing `@sql` cost | **additive members of the existing `attr.expression` `fn` node** — no new axis (2c growth inside a registered closed set) | required, staged waves; raw-SQL escape **REJECTED** (D11) |

G2 (forbidden-combination validator), G5 (state transitions) and G6 (access control) are
**parked**, each with its reason, in the [Parked](#parked--not-in-this-fr) section.

**One correction to the findings doc, so it does not propagate:** G3 lists `first` as a
member of `origin.aggregate @agg`. It is not. The registered `@agg` set is
`count | sum | avg | min | max | any | all | collect` (verified against
`fixtures/registry-conformance/expected-registry.json`); `first` is an origin
**subtype** (`origin.first` — argmax-then-project, with its own `@orderBy`/`@of`/`@via`/`@filter`).
The registered origin subtypes are `aggregate, base, collection, computed, first,
passthrough` — there is no window/rank construct, which is exactly G1.

## Resolved decisions (review record)

Every previously-open item, decided. Details, evidence and rejected alternatives at the
point of use (section references in the first column).

| # | Decision | Confidence |
|---|---|---|
| D1 (R1 §6) | A presented `writeOnce` key on PATCH is **ignored (stripped)**, matching the shipped excluded-settable-set family; gated by a behavioral probe. 400-on-present rejected: it would break every generated edit form and diverge from `@autoSet`/`readOnly` on the same path. | high |
| D2 (R1 §5) | The one conflict rule generalizes: **`@autoSet` requires `@mutability: readWrite`** — `ERR_MUTABILITY_AUTOSET_CONFLICT` (new) fires for `writeOnce` OR `readOnly` + `@autoSet`. | high |
| D3 (R1 §5) | Error-code names: mint `ERR_MUTABILITY_DOWNGRADE` + `WARN_MUTABILITY_VALUE_OBJECT` (generalize the retired-attr-named codes in the same breaking cut); **keep** `ERR_READONLY_ASSIGNED_PRIMARY` (its condition is readOnly-mode-specific and the name stays exact). | medium |
| D4 (R2 §Req 1) | A legacy `origin.collection` fails load with **`ERR_UNKNOWN_SUBTYPE`** (the registered code; a de-registered subtype is unknown by definition). | high |
| D5 (R3 §8) | **Filter-then-rank — and it is forced, not chosen**: the row-scope `@filter` defines the projection's row set; three independent grounds converge. Corollary: a rank field is **not addressable** in the `@filter` (the shipped #207 pass already excludes it by default). Rank-then-filter semantics stay reachable via query-time `?filter`. | high |
| D6 (R3 §9) | v1 `origin.rank` registers **no per-origin `@filter`**; static range-scoped ranks are already expressible via the projection `@filter` (full op band — verified, correcting this doc's pass-1 claim). The origin-level narrow op set + relative-time values are a **pre-existing, origin-wide** program (#159's umbrella), not R3's to fix. | high |
| D7 (R3 §2) | `@partitionBy` takes **bare base-entity field names** (the `@orderBy` grammar's reference form); dotted paths rejected for v1 (they imply joins — the deferred related-set window). | high |
| D8 (R3 §Req 2) | Loader codes for bad rank refs: **reuse the existing origin-reference family** (`ERR_INVALID_ORIGIN`, via the shipped `_validateOrderByKeys`-style walk); mint nothing. | high |
| D9 (R4) | **The composition does not close today.** Edge (a) closed-negative: `origin.computed` refs resolve against the *base entity's* fields (verified), so sibling derived fields are unreachable — though the expression *grammar* already suffices. Edge (b) unspecified-unsupported: `@via` resolution is subtype-blind but the join machinery presupposes entity FK references. Missing pieces named + costed in R4; v1 R3 acceptance re-scoped to the child-grain ranks. | high |
| D10 (R5) | ~~Deferral confirmed; attr name settled as `@sqlExpr`.~~ **SUPERSEDED by D11** (pass 3). Its durable half survives and is retained in R5: recursion and calendar spines are *not* per-field cases (whole-body `@sql` / `@kind: tableFunction` are their valves), and most remaining candidates are chartered expression growth. | superseded |
| D11 (R5) | **The per-field SQL escape is rejected outright, in any form** — not deferred. Two grounds: a raw fragment is un-typeable, so a text-returning fragment in a `field.int` ships silently (whereas a registered `fn` declares a return type and `inferExprType` verifies it); and it hides an RDB-only construct inside an otherwise-portable projection, which is worse for #211 than whole-body `@sql` that at least marks the whole object un-portable. R5 is recast as additive growth of the EXISTING `attr.expression` `fn` node (today a closed set of one, `coalesce`), governed by a cross-backend **admission rule**: a construct earns core vocabulary only with a real lowering — native or adapter code — on an RDB **and** at least one non-RDB backend. Vendor/domain residue goes to provider-registered functions (ADR-0023), where hand-written backend code legitimately lives. | high |
| D12 (R3, re-audit) | `origin.rank` was re-audited against the capability matrix **prepared to reverse R3** and **survives on the merits**: native on RDB (`ROW_NUMBER() OVER`) and on MongoDB (`$setWindowFields` + `$documentNumber`, 5.0+), trivial in memory. The search paradigm has no window functions in its query DSL, so it is **capability-gated** there and must error rather than silently omit (#211). | high |

## Shared obligations (apply to every requirement here)

These are stated once and are binding on R1–R3 and R5 individually:

1. **ADR-0023 strict provenance.** Every new attribute or subtype in this FR requires
   (a) a **written can't-be-computed justification** — the ADR-0037 walks in this doc
   are the draft; the design phase carries them into the shipping spec/ADR text — and
   (b) a **`registry-conformance` fixture**: the addition lands in
   `fixtures/registry-conformance/expected-registry.json` and in every port's registered
   provider so all five ports (TS / C# / Java / Kotlin / Python) gate the vocabulary
   byte-identically. This repo boots strict and seals the registry — an unregistered
   attr is `ERR_UNKNOWN_ATTR` at load, so there is no soft-landing path. The same
   sealed-registry property is what makes R1's and R2's **retirements** breaking: a
   retired attr/subtype fails load, it does not degrade.
2. **ADR-0037 §"Consistency corollaries".** Any closed value-set introduced here ships
   with `allowedValues` in the registry gate (ADR-0036 discipline). `@mutability`'s
   three-member set is such a value-set.
3. **Cross-port scope split follows ADR-0043 §4's precedent.** Registration + loader
   validation + resolving accessors: **all five ports**, conformance-gated by shared
   `fixtures/conformance/` error fixtures. Schema/DDL **lowering**: **TS-only**
   (ADR-0015 — the other ports have no migrate engine to change).
4. **New error codes are proposals.** Codes marked **(new)** below do not exist yet;
   they enter the shared error-code ledger (TS `errors.ts` exact-bidirectional, plus the
   Python/Java registries) as part of the design phase, per the ADR-0044/#219 ledger
   precedent. Codes cited without the marker (`ERR_ORIGIN_UNDER_SQL_BODY`,
   `ERR_BAD_ATTR_VALUE`, `ERR_BAD_ATTR_FILTER`, `ERR_INVALID_ORIGIN`,
   `ERR_SUBTYPE_RULE_VIOLATION`, `ERR_UNKNOWN_SUBTYPE`, `ERR_READONLY_ASSIGNED_PRIMARY`,
   `WARN_READONLY_VALUE_OBJECT`, …) are verified to exist today.
5. **Versioning — this FR carries the pre-1.0 breaking slot.** R1 and R2 are
   **breaking** (they retire registered vocabulary; under the sealed strict registry a
   legacy use fails load). The precedent is the `0.21.0` coordinated MINOR — pre-1.0,
   `^0.20.x` does not resolve `0.21.0`, so a MINOR is the slot that forces deliberate
   adoption; a PATCH would be auto-adopted and break adopters silently. **GA/1.0 is the
   next release move, so the window for R1+R2 is now** — both should land in the same
   coordinated pre-1.0 MINOR, with a migration guide under `docs/features/migrations/`
   (the `identity-secondary-to-index-lookup` precedent). R3 is additive (no-churn for
   models not using it); R5 is additive `fn` growth, staged in waves.

---

## R1 — `@mutability`: one write-access mode per field (G4, 2 of 8) — BREAKING

### The case

"An application's date of record and an inspection's evidence trail must be settable
once, never rewritten." The metamodel has no way to say this today:

- `@readOnly` (FR-013) means *never* application-written — it is omitted from **both**
  the insert and update settable sets (verified:
  `server/typescript/packages/codegen-ts/src/generators/api-field-shape.ts` documents
  the InsertSchema walk as "auto-gen PK omitted, `@readOnly` omitted, …"). That is the
  wrong shape: a date of record is *caller-supplied at create*.
- `@autoSet` (registered on `field.date` / `field.time` / `field.timestamp`, values
  `onCreate | onUpdate`) is write-once **by construction** for `onCreate` — but the
  **server** supplies the value and caller-supplied values are ignored (ADR-0045 §3).
  A caller-chosen application date is not expressible; nor is any non-temporal
  write-once field.

In the spike, one run carried the rule as a comparison invariant plus an amendment-note
field; another as prose. Neither is enforced by the generated write surface.

### Shape: one mode enum, not a second boolean

The first draft of this FR proposed a `@writeOnce` boolean beside the existing
`@readOnly` boolean. The maintainer's review rejected that shape on a
make-illegal-states-unrepresentable argument, and this doc adopts the correction:
`readOnly` and `writeOnce` are **mutually exclusive modes of one axis** — *who may
write, and when*. Two booleans make the illegal combination representable, which is the
only reason the first draft needed a readOnly×writeOnce conflict error and its
fixtures. One enum makes it unrepresentable:

> **`@mutability: readWrite | writeOnce | readOnly`** on `field.base`, default
> `readWrite`.

The readOnly×writeOnce conflict rule and its error fixtures are **deleted from this
FR's scope by construction** — that is a benefit of the shape, not an omission. The
enum also gives inheritance a clean total order (see the downgrade rule below), which
two independent booleans do not.

**`@autoSet` stays a separate attribute.** It answers a different question — *what the
server stamps* (and it is registered only on the three temporal subtypes), whereas
`@mutability` answers *who may write*. Folding it into the enum would overload one attr
with two questions, against ADR-0037's "self-documentation over economy" and its
never-same-name-different-meaning corollary. Exactly **one** cross-attr conflict rule
therefore survives from the first draft — generalized by decision D2 below to cover
both non-default modes.

**Naming.** `@mutability` was chosen over `@access`, which reads as *authorization*
(who is allowed, per principal) and would collide head-on with the parked G6 /
FR-024 access-control territory. `@writability` was considered and adds nothing over
`@mutability`.

### ADR-0037 walk (the ordered test, applied)

- **Step 0 — derivable?** No. The closest existing metadata is `@autoSet: onCreate`,
  and the difference is precisely the non-derivable bit: `@autoSet` declares *the
  server supplies the value* (caller input ignored); write-once-ness with a
  *caller-supplied* value is a distinct contract no combination of existing subtype +
  attrs + structure implies. The `readOnly` mode is likewise not derivable (FR-013's
  layer-placement finding: not introspectable from `information_schema`).
- **Step 1 — physical-only?** No. Like `@readOnly` before it, the mode changes the
  generated write surface and native binding — a logical concern.
- **Step 2 — thing / kind / modifier?** No native type, no behavior of its own, no
  child vocabulary — it **modifies the write behavior of an existing field**. That is
  2c, and within 2c the shape test picks the **"closed set of choices → enum attr with
  `allowedValues`"** arm (not the boolean exception-flag arm, because there are three
  mutually exclusive states, and flag-pairs make the illegal pair representable).

**Verdict: enum attribute `@mutability` on `field.base`** (common field attrs,
inherited by every subtype — the registration home `@readOnly` occupies today),
registered by the core field provider, not the db provider, with
`allowedValues: [readWrite, writeOnce, readOnly]` byte-gated.

### The write-semantics contract (one table, `@mutability` × `@autoSet`)

R1's normative core is a **two-axis contract** — *who supplies the value*
(`@mutability`) × *what the server stamps* (`@autoSet`) — documented together so the
pair cannot drift (the findings doc's explicit warning):

| declaration | supplied by | settable on POST | settable on PATCH |
|---|---|---|---|
| `@mutability: readWrite` (default, attr absent) | caller | yes | yes |
| `@mutability: writeOnce` **(this FR)** | **caller** | **yes** | **no — excluded from the settable set** |
| `@autoSet: onCreate` (separate axis; requires the default mode, D2) | server | no (server stamps; caller value ignored) | no |
| `@autoSet: onUpdate` (separate axis; requires the default mode, D2) | server | no (server stamps) | no (server re-stamps) |
| `@mutability: readOnly` | nobody (DB/trigger/external owner) | no | no |

This table is itself a deliverable: it lands in the attr descriptions and the
API-contract docs.

### Requirements

1. **Create path.** A `writeOnce` field is a normal settable field on POST: validated
   per FR-036, present-required when `@required` (with the existing carve-outs — a
   `@default` supplies the once-written value when the caller omits it).
2. **Update path.** A `writeOnce` field is **excluded from the PATCH settable set** —
   the exact mechanism that excludes `@autoSet: onCreate` from the UpdateSchema walk
   today (verified in `api-field-shape.ts`: "update-payload → the UpdateSchema walk:
   TPH discriminator + `@autoSet`-onCreate omitted"). This includes the FR-035
   present-null arm: clearing is a write, so a present-null `writeOnce` key gets the
   same excluded treatment as any other write to it (per D1: stripped).
3. **`readOnly` behavior is preserved exactly.** `@mutability: readOnly` produces the
   same generated output `@readOnly: true` produces today (no setter / omitted from
   both settable sets / persistence skips the column) — the migration is
   behavior-preserving by definition, pinned by an output-equivalence test.
4. **ADR-0045 applies verbatim.** The **outermost generated write artifact** an adopter
   deploys enforces the mode — no consumer-supplied seam may sit between the guarantee
   and the wire. Vanilla **and** TPH per-subtype surfaces, in all five ports (the
   0.19.4 lesson: the TPH surface is a separate code path per port unless gated).
   Persistence-layer exclusion is retained as the carrier for non-HTTP writes, per
   ADR-0045 §2.
5. **Loader validation (all five ports; error fixtures in `fixtures/conformance/`):**
   - **DECIDED (D2)** — `@autoSet` requires `@mutability: readWrite` (the default):
     `ERR_MUTABILITY_AUTOSET_CONFLICT` **(new)** fires when `@autoSet` is present and
     the mode is `writeOnce` **or** `readOnly`. *Reasoning:* `writeOnce` + `@autoSet`
     contradicts on the supplied-by axis (caller-supplied-once vs server-stamped);
     `readOnly` + `@autoSet` is equally contradictory — `readOnly` means the
     persistence layer skips the column on INSERT/UPDATE (FR-013), which makes the
     stamp dead code. The boolean era left that second combination representable but
     unvalidated; the enum cut is the moment to close both with one rule. *Rejected:*
     leaving readOnly×`@autoSet` as an observation (it is exactly the
     silently-dead-semantic shape ADR-0045 exists to kill). Confidence: high.
   - **No-downgrade across `extends`:** the enum orders by strictness
     `readWrite < writeOnce < readOnly`; a subtype may tighten an inherited mode,
     never loosen it. **DECIDED (D3)** — the rule generalizes the shipped
     `ERR_READONLY_DOWNGRADE` as `ERR_MUTABILITY_DOWNGRADE` **(new)**, retiring the
     old code in the same breaking cut. *Reasoning:* the rule now spans modes (a
     `writeOnce → readWrite` loosening must fire it, which a code named "READONLY"
     misdescribes), and the fixtures are being rewritten by the attr retirement
     anyway — renaming is nearly free now and never again. *Rejected:* keeping the
     old name for ledger stability (the 0.21.6 keep-baked-identifiers precedent) —
     distinguishable because these code strings live in the ledger and fixtures, not
     in byte-gated registry descriptions, and this cut already rewrites those
     fixtures. Confidence: medium; the behavior, not the name, is the requirement,
     and keeping all old names is the acceptable fallback.
   - The shipped `@readOnly`-on-assigned-primary ban carries over to
     `@mutability: readOnly` and **keeps its code** `ERR_READONLY_ASSIGNED_PRIMARY`
     (D3): the condition is readOnly-mode-specific, so the name stays exact. Note the
     asymmetry: `writeOnce` on an assigned primary is **legal — indeed the natural
     mode** for a caller-assigned, never-rewritten key.
   - Non-default `@mutability` on a field child of an `object.value` → WARN —
     generalized as `WARN_MUTABILITY_VALUE_OBJECT` **(new)** replacing
     `WARN_READONLY_VALUE_OBJECT` (D3, same argument as the downgrade code); values
     have no generated write surface; the attr may still inform record/`val`
     treatment.
   - `writeOnce` on a field of a read-only host (projection / read-only `@kind`) →
     WARN (no write surface exists to enforce it against; benign).
6. **DECIDED (D1) — presented-key on PATCH: ignore (strip).** A PATCH body presenting
   a `writeOnce` field's key is accepted with the key stripped; the stored value is
   untouched; the request otherwise processes normally.
   - *Grounding in what ships:* this is the **uniform behavior of every
     excluded-settable-set key on this path today** — `@autoSet` and `@readOnly` keys
     presented on PATCH are stripped (Zod `.object()` strips unknown keys; ADR-0045
     pins "caller-supplied `@autoSet` values are ignored" as a conformance assertion),
     and POST already accepts-and-ignores `@autoSet` keys (the InsertSchema walk marks
     them optional). One surface, one posture.
   - *The decisive mechanical fact:* the generated edit form submits **every
     registered field** (react-hook-form `handleSubmit` passes all values; the 0.19.2
     fix switches the resolver to UpdateSchema on edit — it does not diff-and-omit).
     Under 400-on-present, **every generated edit form for an entity carrying a
     `writeOnce` field would fail on every save** — the option breaks the project's
     own shipped client.
   - *Why "wrong data is worse than a missing endpoint" does not bind here:* the
     0.21.5 Hono TPH doctrine guards against **wrong data being served or mutated**
     (cross-subtype rows read and written). Ignoring a `writeOnce` key stores and
     serves nothing wrong — the field is immutable either way; the failure mode is a
     *client's stale belief*, which the contract already addresses (the field is
     absent from the documented update-payload shape in `api-field-shape.ts`-derived
     docs, so a client sending it is off-contract, and merge-patch-style stripping of
     off-contract keys is the established behavior).
   - *Rejected:* **400 on any present key** — fail-closed instinct, but it breaks the
     shipped form, diverges from every sibling on the same path (two behaviors for
     excluded keys on one surface is its own inconsistency), and requires new
     rejection machinery pinned across five ports. **Compare-then-400** (reject only a
     *changed* value) — requires a read-before-write on every PATCH and is racy;
     rejected outright.
   - *Gate:* the api-contract probe asserts behaviorally — PATCH carrying a new value
     for a `writeOnce` field returns **200 and the stored value is unchanged** — which
     FAILS on a port that either applies the write or 400s. A UI-tier nicety (the
     generated form rendering the field disabled on edit) is design-phase polish, not
     load-bearing. Confidence: high; the evidence that would reopen it is an adopter
     incident where a silently-ignored `writeOnce` PATCH caused real harm — that
     would motivate a WARN-level response header or a strict-mode opt-in, not a
     default flip.

### Breaking change and migration — why this cannot wait

`@readOnly` is **shipped vocabulary**: registered on `field.base` and explicitly on the
concrete field subtypes — **18 registry entries** in
`expected-registry.json` (verified) — byte-gated across five ports, with shipped loader
validation (`validate-field-readonly.ts`) and codegen consumers. Under ADR-0023's
sealed strict registry, retiring it means a legacy `@readOnly` **fails load with
`ERR_UNKNOWN_ATTR`** — there is no deprecation shim, by design.

- **Migration is mechanical:** `@readOnly: true` → `@mutability: readOnly`; an explicit
  `@readOnly: false` (rare) → delete the attr (`readWrite` is the default). One
  rewrite, no judgment calls; the migration guide documents it with before/after
  metadata.
- **Registry + fixtures:** all 18 `readOnly` entries replaced by `@mutability` entries
  (with `allowedValues`) in `expected-registry.json` and every port's provider; the
  FR-013 conformance fixtures re-expressed over the enum (with the D3 code renames).
- **Timing:** GA/1.0 is the project's next release move, and the pre-1.0 MINOR is the
  chartered breaking slot (0.21.0 precedent). **If R1 misses that window, the project
  carries `@readOnly` AND `@mutability` plus the boolean-pair conflict rule
  permanently** — the exact illegal-state-representable shape the enum exists to
  eliminate. That is the whole argument for doing this now, stated plainly.

### Acceptance criteria

- Registry: `@mutability` (with `allowedValues`) registered on `field.base` in all five
  ports; **`@readOnly` retired everywhere**; `expected-registry.json` updated;
  registry-conformance green.
- Output equivalence: `@mutability: readOnly` output is identical to today's
  `@readOnly: true` output (pinned); metadata with no `@mutability` is byte-identical
  to today (no-churn).
- Conformance fixtures: canonical round-trip preserves the attr; the
  `ERR_MUTABILITY_AUTOSET_CONFLICT` fixtures (both non-default modes × `@autoSet`),
  the `ERR_MUTABILITY_DOWNGRADE` fixture (loosen-attempt fails), and the
  assigned-primary fixtures green in all five ports; the value-object WARN unit-tested
  per port (the corpus has no warn-fixture mechanism — ADR-0043 §4 precedent); a
  legacy-`@readOnly` fixture proving `ERR_UNKNOWN_ATTR`.
- `api-contract-conformance`, both lanes (reference server AND generated artifact over
  HTTP), every port, vanilla AND TPH: a POST sets a `writeOnce` field; a subsequent
  PATCH carrying a new value for it returns **200 with the stored value unchanged**
  (D1); a PATCH not naming it leaves it unchanged; present-null does not clear it.
- Migration guide published under `docs/features/migrations/`; the supplied-by ×
  settable-when table published in the attr descriptions and docs.

---

## R2 — Origin-vocabulary hygiene: retire `origin.collection` (reserved-not-registered) — BREAKING

### Provenance

Not a spike gap: this surfaced in the maintainer's review of this FR. R3 argues
`origin.rank` into the registry by showing it has a **distinct semantic frame** no
existing origin covers. Holding the *existing* origin vocabulary to that same bar
exposes one registered subtype that fails it.

### The case against `origin.collection`

Verified registry facts: the registered origin subtypes are `base` (abstract),
`passthrough`, `aggregate`, `collection`, `computed`, `first`. `origin.collection`
registers **only `@via`** (required) — no `@filter`, no `@orderBy`. `origin.aggregate`
registers `@agg` (required; `count,sum,avg,min,max,any,all,collect`), `@distinct`,
`@filter`, `@of`, `@orderBy`, `@via`.

1. **It duplicates `origin.aggregate @agg: collect`.** Both walk `@via` to a related
   set and yield an array per host row; the only difference is `@of` present (collect
   scalars) vs absent (collect whole objects). That difference is not subtype-worthy,
   because `aggregate` is **already heterogeneous** on exactly the axes that would have
   to justify the split: in return type (`count`→int, `any`/`all`→boolean,
   `collect`→array, `sum`/`avg`→numeric) and in required-attr shape (`any`/`all`
   **forbid** `@of`; `sum` **requires** it — both from the registered attr
   descriptions). "Collects objects instead of scalars" is a smaller delta than the
   deltas `@agg` already absorbs.
2. **The split actively harms.** A `collection` cannot be filtered or ordered
   (`@via` is its only attr) while `collect` takes `@filter`, `@orderBy` and
   `@distinct`. That asymmetry is accidental, not principled — merging the concept
   into the aggregate frame is a capability *gain* for the collection case.
3. **It has no implementation.** `MetaCollectionOrigin`
   (`server/typescript/packages/metadata/src/persistence/origin/meta-origin.ts`) is a
   lone `via` getter; the projection/view tier does not dispatch on it at all (zero
   references in `codegen-ts`/`migrate-ts` source); and its one real consumer — the
   payload-VO typing edge in the Kotlin/Python/Java generators — was **deleted in
   0.20.16 as #270**, where it was **actively wrong**: it discarded the field's
   declared `@objectRef` and substituted the `@via` relationship's target entity,
   silently turning a declared curated value-object into the full entity.

### ADR-0037 read (the test, run in reverse)

Expansion asks "does X earn a subtype?"; hygiene asks the same question of what is
already registered. `origin.collection` fails 2a **relative to `origin.aggregate`**:
no distinct behavior (same frame — reduce a `@via`-related set to a per-host-row
value), no distinct native type beyond what `@agg: collect` + the field's declared
`@objectRef`/`isArray` already carry, and a strictly smaller attr set. It is a
structural variant of a reduction, and reductions already have their variant axis:
`@agg`.

### Treatment: reserved-not-registered, per precedent

**Retire `origin.collection` from the registry; document it as
reserved-not-registered** — the ADR-0040 treatment (`index.fulltext` / `index.vector`
/ `index.spatial`) also applied to the `@role` shrink in 0.21.0 (#212). The project's
own re-entry bar decides when it may come back — ADR-0007 Amendment 2, quoted in the
registry itself: *"a member enters the registry only when a shipping consumer
dispatches on it."* Today no shipping consumer dispatches on `origin.collection`; the
last one was deleted for being wrong.

**Considered alternative — fold in now:** register `@agg: collect` with `@of`
**optional** (absent = whole-object rollup, typed by the field's declared
`@objectRef` + `isArray` per the #270 declared-authoritative doctrine). This keeps the
concept expressible and is the natural **re-entry shape** when a consumer arrives —
but activating it *now* would mint registry capability that, exactly like the subtype
it replaces, no shipping consumer dispatches on. The same Amendment-2 bar that retires
`collection` says the fold-in waits. Recommendation: retire now, and record the
`@of`-optional fold-in as the designated re-entry form.

**Considered and REJECTED — also merging `origin.first` into `origin.aggregate`** (so
it is not re-litigated): `first`'s attrs are exactly `aggregate`'s minus
`@agg`/`@distinct`, and both reduce a `@via` set to one value per host row — but
`first` is **argmax-then-project**: it orders by one column and projects *another*
(`@orderBy: "inspectedAt:desc"` + `@of: grade`), which `min`/`max` cannot express since
they reduce over `@of` itself. Folding it in would make `@agg` a ten-member grab-bag
spanning scalar reduction, boolean quantification, array rollup, object rollup and
argmax — the catch-all ADR-0037 warns against, against its "self-documentation over
economy" rule. `first` keeps a distinct semantic frame; `collection` does not.

**This strengthens R3.** A rank is the host row's **position within the projection's
own row set** — it does not reduce a related set at all — so `origin.rank` survives
exactly the scrutiny that retires `collection`. After R2, every registered origin
subtype has a distinct semantic frame **and** a consumer that dispatches on it:
`passthrough` (mapping), `aggregate` (reduce a related set), `first`
(argmax-then-project), `computed` (row-local expression), `rank` (position in own row
set).

### Requirements

1. Remove `origin.collection` from every port's registered provider and from
   `expected-registry.json`; a legacy use fails load with **`ERR_UNKNOWN_SUBTYPE`**
   (D4 — the registered unknown-subtype code; a de-registered subtype is unknown by
   definition), with a conformance error fixture asserting that code.
2. Shrink `ASSEMBLY_ORIGIN_SUBTYPES` (which today contains `collection` — verified in
   `origin-constants.ts`) in every loader, in lockstep — the #210 property that
   cross-port coverage is a property of the shared constant.
3. Delete `MetaCollectionOrigin` and any residual registration/serializer arms;
   document the reserved-not-registered status + the Amendment-2 re-entry bar + the
   designated fold-in re-entry shape where ADR-0040 documents its reserved index
   subtypes.
4. **Sweep by member value, not constant name** (the retirement lesson): spec files,
   embedded metamodel definitions, authoring skills, docs and CLAUDE.md's
   cross-language contract list all name `collection` in the origin subtype set and
   must be updated in the same change.
5. Migration guide entry (same guide as R1's, same pre-1.0 MINOR): a declared
   `origin.collection` was contributing nothing after 0.20.16 (no consumer) — the
   migration is *delete the child*, or re-model as `@agg: collect` where `@of` scalar
   collection is what was actually meant.
6. Bundle with R1 in the coordinated pre-1.0 MINOR — one breaking window, one
   migration guide, per Shared obligation 5.

### Acceptance criteria

- Registry-conformance green in all five ports with `origin.collection` absent;
  the legacy-use error fixture green in all five ports.
- No source reference to the retired subtype remains outside the
  reserved-not-registered documentation and the migration guide (value-sweep, not
  constant-name-sweep, verified in the change).
- `ASSEMBLY_ORIGIN_SUBTYPES` updated in every loader; #210's value-host rejection
  still green for the remaining assembly origins (aggregate/computed/first — plus
  `rank` once R3 lands).
- The re-entry bar and fold-in shape documented; no-churn for models that never
  declared `origin.collection`.

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
  the ADR-0037-forbidden same-name overload, and misdescribes the data model. (R2
  applies the same frame test in the other direction — it is one bar, used both ways.)
- **An attribute on an existing origin**: rejected by the 2a test — it carries its own
  required configuration and its own lowering; it is not a modifier of anything.

### The semantic contract (#211 is load-bearing here)

Per #211, `origin.*` declares **semantic intent** and a SQL view is only **one
lowering**; per #195, "anything that only makes sense for an RDB is a defect". R3 is
therefore specified as a deterministic function of the row set — `ROW_NUMBER() OVER
(PARTITION BY … ORDER BY …)` is *a lowering of it*, never its definition. The
registered bar for "semantic, not SQL" already exists in this vocabulary:
`origin.first` ships required ordering keys, a portable filter AST, an explicit
total-order tie-break, and a description that literally ends **"Semantic — carries no
SQL syntax."** R3 is held to exactly that bar:

> **`origin.rank` yields the 1-based position of the host projection's row within its
> partition, under a declared total order over the projection's row set.**

Normative elements:

1. **Ordering grammar: reuse `origin.first`'s, verbatim.** `@orderBy` — ordering keys
   as `'field[:asc|desc]'` (default `asc`), nulls sort last, **the base entity's PK
   ascending appended as the deterministic tie-breaker**, "semantic — carries no SQL
   syntax". This doctrine is already registered and shipped on `origin.first`; R3 must
   reuse the attr name and grammar (ADR-0037 "same concept → same attr name") and the
   appended-PK rule makes the order **total**, so positions are unique, deterministic
   and gap-free — the `ROW_NUMBER` vs `RANK` vs `DENSE_RANK` distinction becomes a
   deliberately **deferred** tie-semantics question (a future `@ties` enum can relax
   totality if an adopter case demands peer-equal ranks; re-entry trigger: such a
   case, documented), not a v1 ambiguity.
2. **`@partitionBy`** (optional string array). **DECIDED (D7): bare base-entity field
   names** — the same reference form `@orderBy`'s registered grammar uses ("ordering
   keys … over the … entity's fields", bare names), following the ADR-0029 addressing
   model rather than inventing one. *Rejected:* dotted paths — they imply joins, which
   is the deferred `@via`-scoped related-set window, and admitting them in v1 would
   pre-commit that design. Absent = one global partition; present = independent
   1-based numbering per distinct key. Confidence: high.
3. **v1 scope: the self-window.** The rank is computed over the **projection's own
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
8. **DECIDED (D5) — the `@filter` interaction is filter-then-rank, and it is forced,
   not free.** The projection-level row-scope `@filter` (#207) **defines the
   projection's row set**; the rank is a function of that row set. Three independent
   grounds converge:
   - *The vocabulary's own semantics.* Everywhere `@filter` appears at origin level it
     is **set-defining, not post-predicating**: `origin.aggregate @filter` "scopes
     which related rows the aggregate spans"; `origin.first @filter` "scopes which
     related rows are eligible for selection" (registered descriptions). Filters
     define the input set; operators apply to it. A projection's `@filter` defines the
     projection's rows; ranking rows *outside* that set would make a derivation depend
     on rows outside the declared exposure — against ADR-0028's fail-closed exposure
     doctrine.
   - *The shipped validation already encodes the order.* The #207 pass
     (`validateProjectionFilter`, `validation-passes.ts`) rejects `@filter` refs to
     aggregate-derived fields with "a view-level WHERE runs before aggregation"
     (`ERR_BAD_ATTR_FILTER`) — the architecture has already pinned that the row-scope
     predicate evaluates **before** set-dependent derivations.
   - *The natural lowering agrees.* In SQL's logical processing order, `WHERE`
     precedes window evaluation in the same SELECT — so the straightforward
     single-SELECT lowering (`SELECT …, ROW_NUMBER() OVER (…) FROM base WHERE p`) IS
     filter-then-rank; producing the other order requires deliberately computing rank
     in a subquery and filtering outside it.
   **Corollary (also decided):** a rank field is **not addressable in the projection
   `@filter`** — a WHERE cannot see a window value, for exactly the reason it cannot
   see an aggregate. The shipped pass **already enforces this by default** (its
   addressability classification admits only passthrough/computed origins; any other
   origin subtype — including `rank` — is fail-closed non-addressable), needing only a
   cosmetic error-message generalization. *Rejected:* rank-then-filter (global
   position with holes) — a legitimate reading, but it stays **reachable without new
   vocabulary**: declare the projection unfiltered and apply the predicate at query
   time via the FR-009 `?filter` surface, which filters *outside* the view and hence
   over already-ranked rows. Declared filter = eligible-set ranking; query-time filter
   = global ranking, filtered display. Both semantics served, no switch attr needed.
   *The pinning probe (must FAIL on the wrong order):* seed data in which the
   globally-earliest row is **excluded** by the `@filter`; assert the earliest
   *visible* row has rank **1** and ranks are dense `1..N` over the result. A
   rank-then-filter port reports rank 2 with a hole and fails. Confidence: high.
9. **DECIDED (D6) — no per-origin `@filter` on v1 `origin.rank`; the operator-set gap
   is not R3's.** Pass 1 of this doc claimed a range-scoped rank ("applications after
   date X") was inexpressible. **Code evidence corrects that claim:** the
   projection-level `@filter` validates operators against the full per-subtype FR-009
   band (`opsForSubType` in `checkProjectionFilterRefs` — `gt/gte/lt/lte` on
   numeric/date/timestamp fields, verified in `query-constants.ts`), so a **static**
   range-scoped rank is expressible **today**: put the range predicate in the
   projection `@filter`, and by D5 the rank spans exactly the scoped set. What the
   narrow `eq/ne/in/isNull` grammar limits is the **origin-level** `@filter`
   (`origin.aggregate`/`origin.first`, per their registered descriptions) — a
   **pre-existing, origin-wide** limitation R3 would merely inherit if it registered
   that attr. Decision: v1 `origin.rank` registers **no `@filter`** — row-scoping is
   the projection `@filter`'s job (one mechanism, and D5's eligible-set semantics is
   exactly the scoped-rank reading). The origin-level op-set widening, and the
   genuinely-missing **relative-time value vocabulary** (a "last 12 months" bound
   needs a now()-relative *value*, which no filter or expression node expresses —
   an op widening alone would not fix it), belong to the chartered
   expression/filter growth program (#159 is the registry's own pointer), owned
   origin-wide, not by R3. *Rejected:* widening the origin filter grammar inside R3 —
   it smuggles a cross-cutting five-port change into a subtype FR, for an attr v1
   rank does not even register. *Re-entry trigger:* an adopter needing a rank over a
   scoped subset while the projection must **show** unfiltered rows — that is the
   per-origin-`@filter` case, and the design then imports the existing origin-filter
   machinery as-is (narrow ops first). Confidence: high.

### Requirements

1. Registry: `origin.rank` registered in all five ports with `@orderBy` (required) and
   `@partitionBy` (optional); `expected-registry.json` updated; registry-conformance
   green (Shared obligation 1).
2. Loader validation, all five ports: missing `@orderBy` →
   `ERR_MISSING_REQUIRED_ATTR`; unresolvable order/partition field references →
   **DECIDED (D8): reuse the existing origin-reference validation family** — the
   shipped `@via`/`@of`/order-key walks emit `ERR_INVALID_ORIGIN` (verified:
   `_validateViaPath` / `_validateOrderByKeys` in `validation-passes.ts`), and rank's
   ref checks ride the same passes; mint nothing. *Rejected:* a dedicated rank-ref
   code — no new failure semantics to name. Confidence: high. Also: non-integer host
   field subtype → the extends/origin-agreement error path; value-hosted →
   `ERR_SUBTYPE_RULE_VIOLATION` (via `ASSEMBLY_ORIGIN_SUBTYPES`); `origin.rank` under
   an `@sql` host → already covered by the existing R4 rule of ADR-0043
   (`ERR_ORIGIN_UNDER_SQL_BODY`), fixture-pinned; rank ref in a projection `@filter`
   → already fail-closed by the shipped #207 addressability rule
   (`ERR_BAD_ATTR_FILTER`), fixture-pinned with the generalized message.
3. RDB lowering (TS-only, ADR-0015): `build-projection-views` synthesizes the window
   expression (`ROW_NUMBER() OVER (PARTITION BY … ORDER BY …, <pk> ASC)` on Postgres;
   SQLite window functions per the existing dialect split) in the same SELECT whose
   WHERE carries the `@filter` (the D5 order falls out of the natural lowering);
   migrate idempotence gate (emit → apply to a real engine → re-diff EMPTY) applies.
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
  read surface — with seed data containing **ties on `appliedAt`** AND a row excluded
  by the row-scope `@filter` whose exclusion would shift positions (the D5 probe:
  earliest visible row ranks 1, ranks dense `1..N`), asserted identically in every
  port's lane.
- Determinism probe: two applies of the same seed in different insert orders produce
  identical positions.
- All loader error fixtures above green in five ports; registry-conformance green;
  no-churn for models without `origin.rank`.
- R4's child-grain half, below.

---

## R4 — run-length / gaps-and-islands (G3, 4 of 8) — an acceptance case of R3, investigated and PARTIALLY BLOCKED

**Decision: R4 adds no vocabulary.** The findings doc's own ADR-0037 read stands: a
run-length is a window construct and should fall out of G1. Encoding it as a dedicated
`@agg` member would violate step 0 the moment R3 exists.

**The case:** an `Inspection` entity (`plotId` FK, `inspectedAt`, `grade` enum
including `Neglected`); the stakeholder rule is "two consecutive `Neglected`
inspections trigger a warning; three take the plot back." The spike's runs resolved
this with denormalised snapshot state three different ways — the shape "most likely to
be silently wrong in a real adopter model".

The classic composition is the rank-difference construction: at inspection grain,
`seq` = rank per plot ordered `inspectedAt:desc`, `seqInGrade` = rank per
(plot, grade) ordered the same way; then `seq = seqInGrade ∧ grade = 'Neglected'`
characterizes the trailing Neglected run, and a per-plot count of those rows is the
run length. Pass 1 left the two composition edges as design-phase questions.
**Pass 2 investigated both against the shipped code (D9). The finding: the
composition does NOT close with R3 + existing vocabulary.**

### Edge (a) — `origin.computed` over sibling derived fields: CLOSED-NEGATIVE (verified)

The expression **grammar is not the blocker** — `attr.expression` already has
field-vs-field comparison (`{op, left, right}` where both sides may be `{field}`
nodes), the full comparison set including `gt/lt`, and `and` (verified in
`meta-attr-expression.ts`); `seq = seqInGrade ∧ grade = 'Neglected'` is expressible in
the existing node kinds, typed `field.boolean`. The blocker is **reference scope**:
the shipped computed-origin pass resolves `{field}` refs against **the base entity's
effective fields** ("Type inference against the base entity's EFFECTIVE fields",
`validation-passes.ts`, `resolveField` over `base.children()`) — a sibling field
declared only on the projection (a rank) does not resolve, failing
`ERR_INVALID_ORIGIN`. And even with scope widened, the natural lowering cannot emit a
sibling-window reference in the same SELECT (SQL cannot reference a window alias in a
sibling SELECT-list expression) — it requires a **layered lowering** (windows in an
inner subquery, sibling-referencing computeds outside) plus acyclicity validation.

**Precisely what is missing:** (i) extend `origin.computed`'s reference scope to the
projection's own declared fields (sibling refs), with cycle detection; (ii) a layered
view synthesis in `build-projection-views`. No new expression node kinds. Chartered
home: the #159 additive-expression-capabilities umbrella (the registry's own pointer
for expression growth). Cost class: a bounded loader-pass + view-builder change, five
ports for the validation, TS-only for the lowering.

### Edge (b) — parent-level `origin.aggregate` over a child-grain projection's rows: UNSPECIFIED-UNSUPPORTED (verified)

The `@via` walk resolves hop targets through the subtype-blind `resolveObjectRef`
(`_findObject`, `validation-passes.ts`) — **no explicit target-must-be-entity rule was
found** on relationship `@objectRef` for the 1:N case or on `@via` hop resolution. But
the machinery that makes a hop *lowerable* presupposes entities: joins derive from the
`identity.reference` FK SSOT (the FR-018 doctrine; `_findReference` navigates FK
edges), and a projection carries no FK references to correlate on. So
aggregate-over-projection is today **unspecified rather than fail-closed** — it has no
defined join semantics and no lowering, and a model attempting it fails somewhere
downstream rather than at a named rule. Two obligations follow:

- **A fail-closed rule this FR hands the design phase regardless of G3:** a `@via`
  hop or aggregate target resolving to a non-entity must error clearly at load
  (`ERR_INVALID_ORIGIN` family), not misbehave downstream. Cheap, and true today
  independent of any rank work.
- **What full G3 closure would need:** a defined correlate for aggregating over a
  projection's rows (the natural candidate: the projection's `extends`-bound identity
  pass-through, ADR-0028) + view-builder support for joining a projection's view.
  SQL-side this is easy (views join like tables); the work is the metamodel semantics
  and the capability-matrix entry (#211).

### What R4 therefore requires

1. **v1 gate (achievable now, still de-blinding):** the child-grain ranked projection
   — `seq` and `seqInGrade` per D5/D7 over Inspection — correct on seed data with
   **interrupted runs** (`Neglected, other, Neglected` — the probe that distinguishes
   a run from a count; an uninterrupted-only corpus is blind to the whole feature).
   This is an R3 acceptance scenario and ships with R3.
2. **The finding, carried:** full G3 closure = R3 + the two named extensions —
   sibling-ref computed scope + layered lowering (edge a), and
   aggregate-over-projection semantics (edge b) — both #159/#211-adjacent, neither
   scheduled by this FR. Until then the honest adopter guidance is the denormalised
   counter column **with its drift risk stated** (exactly the shape the spike flagged
   as most likely to be silently wrong) — documented, not endorsed.
3. The fail-closed non-entity-`@via`-target rule from edge (b), regardless of G3.
4. When the extensions land, the full case's gate is as pass 1 stated: a fully
   metadata-declared trailing-run-length, seeded with interrupted runs — **not
   satisfied by prose, by a snapshot counter column, or by any raw-SQL escape (D11).**

---

## R5 — Semantic function vocabulary: `fn` growth + provider-registered lowerings

> **Status: ACTIVE requirement.** This section previously proposed a per-field SQL
> escape (`@sqlExpr`), CONDITIONAL/DEFERRED. That is **rejected and replaced** on the
> maintainer's ruling: *"Make sure the semantic concepts work against other persistence
> layers, not just an RDB — if it's RDB-only, it isn't semantic. Even if we write the
> functions in code to satisfy a backend, that's okay."*

### Why `@sqlExpr` is rejected (recorded, not revisited)

1. **Un-typeable.** `origin.computed` VERIFIES its declared subtype — `inferExprType`
   walks the tree and a mismatch is an error. A raw SQL fragment cannot be inferred, so
   a text-returning fragment assigned to a `field.int` would ship silently. Trading a
   verified contract for a trusted one is the wrong direction for this codebase.
2. **Dishonest portability.** Whole-body `@sql` (ADR-0043) marks an ENTIRE projection
   hand-written and RDB-only — visible at the object level. A per-field fragment hides
   an RDB-only construct inside an otherwise-portable projection, so the object *looks*
   semantic while one column is not. Under #211 that is worse than the valve it was
   meant to improve on.

### The mechanism already exists

- `attr.expression` already carries a function node — `{ fn: string; args: ExprNode[] }`
  (`meta-attr-expression.ts`) — a **closed set with exactly one member, `coalesce`**.
  The extension point is the member list, not a new escape hatch.
- The lowering seam already exists and is dialect-aware:
  `view-ddl-emit.ts` → `case "coalesce": return COALESCE(...)`.
- `inferExprType` types the tree, so every added `fn` declares its return type and the
  host field's declared subtype stays VERIFIED.
- The module header already states the doctrine: *"Deliberately NOT a raw-SQL string: a
  declarative, backend-agnostic tree that any lowering (SQL view DDL, an in-process
  evaluator, a document store) can walk."*

### The admission rule (new, and it binds core vocabulary generally)

> A construct earns **core** semantic vocabulary only if it has a real lowering — native
> primitive OR deterministic adapter code — on an RDB **and at least one non-RDB
> backend**. "The backend lacks a primitive" is not disqualifying (adapter code is
> explicitly allowed). "It can only be done by loading the whole set into memory" is.
> Anything RDB-only is either refused from core, or admitted **capability-gated**, and
> per #211 a lowering that cannot support it must **error, never silently omit**.

### Capability matrix

Backends: **RDB** (Postgres / SQLite) · **Doc** (MongoDB aggregation pipeline) ·
**Search** (OpenSearch / Elasticsearch: query DSL, aggregations, runtime fields) ·
**Mem** (in-process evaluator). Legend: **N** native primitive · **A** adapter-
implementable deterministically · **S** only via full-set scan · **X** unsupported.

| construct | RDB | Doc | Search | Mem | verdict |
|---|---|---|---|---|---|
| `eq` `ne` `in` | N | N (`$eq/$ne/$in`) | N (`term`/`terms`) | N | core |
| `gt` `gte` `lt` `lte` | N | N | N (`range`) | N | core |
| `isNull` | N | N | N (`must_not exists`) | N | core — **contract hazard**, see below |
| `like` | N | A (`$regex` + `%`/`_` translation) | A (`wildcard`, keyword field) | N | core — **contract hazard**, see below |
| `and` `or` `not` | N | N | N (`bool`) | N | core |
| comparison, field-vs-field | N | N (`$expr`) | A (runtime field) | N | core |
| `coalesce` | N | N (`$ifNull`) | A (runtime field) | N | core (shipped) |
| arithmetic | N | N (`$add`/`$subtract`/`$multiply`/`$divide`) | A (runtime field) | N | **core — take first** |
| `case`/`when` | N | N (`$switch`/`$cond`) | A (runtime field) | N | **core — take first** |
| string ops (concat/lower/upper/substr) | N | N (`$concat`/`$toLower`/`$toUpper`/`$substr`) | A | N | **core — take first** |
| JSON / path traversal | N (PG `->>`, SQLite `json_extract`) | **N — native document access** | N (object/nested fields) | N | **core — take first** |
| date bucketing (`dateTrunc`) | N PG; A SQLite (`strftime`, no `date_trunc`) | N (`$dateTrunc`, 5.0+) | N (`date_histogram`) / A | N | core |
| regex extraction | A PG (`substring … from`); **X SQLite without an extension** | N (`$regexFind`, 4.2+) | A (script — **commonly disabled by policy**) | N | **capability-gated, not core** |
| `@agg` count/sum/avg/min/max | N | N (`$group`) | N (aggregations) | N | core (shipped) |
| `@agg` any/all | N | A | A (filtered agg) | N | core (shipped) |
| `@agg` collect | N (`array_agg`/`json_group_array`) | N (`$push`) | A (`top_hits`) | N | core (shipped) |
| `@distinct` | N | N (`$addToSet`) | **A — `cardinality` is APPROXIMATE** | N | core — **contract hazard** |
| `origin.first` (argmax) | N | N (`$setWindowFields`+`$first`; or sort+`$group`) | A (`top_hits` size 1, sorted) | N | core (shipped) |
| **`origin.rank` (R3)** | N (`ROW_NUMBER() OVER`) | **N (`$setWindowFields` + `$documentNumber`, 5.0+)** | **X in the query DSL** — no window functions; composite agg + client numbering, or the SQL plugin (SQL again) | N | **PASSES** — core, Search capability-gated |

Confidence: high on RDB, Doc and Mem rows and on the absence of window functions from
the Search query DSL; medium on the Search **A** rows, which depend on runtime-field and
scripting availability that deployments routinely restrict by policy.

### The finding this pass actually produced

**R3 survives.** `origin.rank` lowers natively on an RDB *and* on MongoDB, and trivially
in memory — it clears the admission rule on the merits, not by exemption. Search is the
one backend that cannot express it in its query DSL, so it is capability-gated there and
must error rather than omit. This is a *stronger* position than the doc previously
claimed, because it is now demonstrated rather than assumed.

**But the EXISTING vocabulary carries cross-backend semantic hazards the RDB-only world
never exposed.** Three, none of which R5 introduces and all of which any non-RDB lowering
must pin before it ships:

1. **`like`.** ADR-0049 (0.21.6) just ruled `like` is case-SENSITIVE SQL `LIKE`
   everywhere. On Doc that requires translating `%`/`_` into an anchored regex; on
   Search it holds only against an **unanalyzed/keyword** field — against an analyzed
   field, `match` applies tokenization and stemming, which is not "LIKE with different
   case folding" but a different retrieval model entirely. The contract must say
   *exact-substring on unanalyzed text*, or `like` silently means two things.
2. **`isNull`.** An RDB has one null. A document store distinguishes **missing** from
   **explicit null**; Search's `exists` is false for both. The contract must state which
   the metamodel means (recommendation: absent and null are indistinguishable at the
   metamodel level — the RDB reading — and adapters normalise to it).
3. **`@distinct`.** Search's `cardinality` aggregation is **approximate** (HyperLogLog++).
   An approximate distinct count silently violates the determinism doctrine R3 sets. It
   must be exact-or-error, never approximate-and-quiet.

These belong to #211's capability matrix, not to this FR — but they are recorded here
because this is the pass that found them, and because they are evidence for the
admission rule: a vocabulary chosen against one backend acquires hazards invisible until
a second arrives.

### Requirements

1. **`fn` vocabulary growth, ordered by the matrix.** Take first, in this order:
   **arithmetic**, **`case`/`when`**, **string ops**, **JSON/path traversal** — each
   native or adapter-implementable on every backend evaluated. **Date bucketing**
   follows (SQLite needs `strftime` adapter code, not a primitive). Each added member:
   declares its arg types and return type so `inferExprType` keeps the host field's
   declared subtype VERIFIED; registered cross-port; a `registry-conformance` fixture;
   and a lowering in the existing `view-ddl-emit` switch. No member is added without at
   least one non-RDB lowering demonstrated or specified.
2. **Regex extraction is capability-gated, not core** — SQLite has no regex without an
   extension and Search scripting is commonly disabled. If admitted, it errors on a
   lowering that cannot support it.
3. **Provider-registered functions are the answer for the vendor/domain residue**
   (geospatial distance, custom DB functions). ADR-0023 already makes registered
   providers the sanctioned extension point (`docs/features/extending-with-providers.md`).
   A provider declares the function's **name, argument types, return type, and a lowering
   per backend**; metadata references it as `{ fn: "<name>", args: [...] }` — a name and
   typed arguments, never a SQL string. This is where hand-written backend code
   legitimately lives, per the maintainer's explicit allowance.
4. **Unknown-`fn` behaviour is fail-closed and named.** A lowering encountering an `fn`
   it has no implementation for must raise a clear error naming the function and the
   backend — #211's "error, not silent omission". A metadata author must never get a
   quietly-missing column.
5. **No SQL string enters the metamodel.** `@sqlExpr` is not registered, now or on
   activation. The escape ladder ends where it already does: origins → whole-body `@sql`
   (ADR-0043) → `@unmanaged`.

### Acceptance criteria

- Each added `fn` member: registry-conformance green in five ports; `inferExprType`
  rejects a return-type/declared-subtype mismatch (fixture); RDB lowering gated by the
  migrate idempotence round-trip (emit → apply to a real engine → re-diff EMPTY).
- A **second-backend proof** for at least one added member — an in-memory evaluator
  lowering exercised by a test — so "backend-agnostic" is demonstrated by a running
  second lowering rather than asserted by a table.
- Unknown-`fn` error fixture: a lowering without an implementation errors, naming the
  function and the backend; it does not omit the column.
- The three contract hazards above (`like`, `isNull`, `@distinct`) are written into the
  respective attr/op descriptions as explicit cross-backend contracts, so a future
  non-RDB adapter inherits the ruling instead of re-deciding it.
- No-churn: models using no `fn` beyond `coalesce` emit byte-identical output.

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
1.1 prioritization evidence for FR-024's declared-API work. (It is also why R1's mode
attr is named `@mutability`, not `@access` — the authorization word stays free for
this territory.)

---

## Out of scope / non-goals

- **Any new `@agg` member** (including a rank or run-length member) — R3 is a subtype;
  R4 is composition. The `@of`-optional `collect` fold-in is R2's *documented re-entry
  shape*, not scheduled work.
- **`@via`-scoped related-set rank** — deferred (R3 §3); the attr shape must not
  preclude it.
- **Tie-semantics variants** (`RANK`/`DENSE_RANK`-style peer ranks) — deferred behind
  the total-order doctrine (R3 §1), with the documented-adopter-case re-entry trigger.
- **Widening the origin-level `@filter` operator set / relative-time filter values**
  — a pre-existing origin-wide program (#159's umbrella), not R3's (D6).
- **Sibling-ref computed scope + layered lowering, and aggregate-over-projection**
  — R4's two named gaps; carried as findings with their chartered homes
  (#159 / #211), not scheduled here.
- **Non-RDB lowerings of `origin.rank`** — #211's program; R3 only obligates the
  semantic contract and the error-not-omission rule so it slots in.
- **Folding `@autoSet` into `@mutability`** — rejected in R1: separate questions
  (what the server stamps vs who may write); folding would overload one attr.
- **The G2/G5/G6 constructs** — parked above with reasons.
- **DDL machinery for `@mutability`** — like `@readOnly` before it (FR-013), it emits
  no DDL; the write surface enforces it.
- **Retro-fitting `@autoSet` beyond `field.date`/`field.time`/`field.timestamp`** —
  the pair table documents today's registration truthfully; widening `@autoSet` is a
  separate proposal.

## Definition of done (requirements-level)

- R1–R3 each carried through the design phase with their ADR-0037 walks,
  can't-be-computed justifications, and the **D1–D8 decisions** recorded in the
  shipping design docs/ADRs (Shared obligation 1a) — each decision
  conformance-pinned by the probe named at its point of use — and all acceptance
  criteria green across the five ports.
- R1 + R2 land together in the coordinated pre-1.0 MINOR **before GA/1.0**, with one
  migration guide covering both retirements (`@readOnly` → `@mutability`;
  `origin.collection` → delete or `@agg: collect`); if the window is missed, the
  permanent-double-vocabulary consequence in R1 is accepted **explicitly, in writing**,
  not by default.
- R4: the child-grain gate ships with R3; the two named vocabulary gaps (D9) and the
  fail-closed non-entity-`@via`-target rule are carried into the design phase as
  findings with owners (#159 / #211), not silently dropped.
- R5 ships as additive `fn` members that each clear the admission rule, with a second-backend
  lowering demonstrated by a running test rather than asserted by a table; no raw-SQL escape is
  registered, now or later (D11).
- The parked section's reasoning carried into whatever future FR picks G2 up, so
  "cheap because the AST exists" does not get re-argued from scratch.

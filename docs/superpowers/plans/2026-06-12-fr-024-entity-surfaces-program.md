# FR-024 Entity Surfaces — Program Plan + Phase A (Decisions & Documentation)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement FR-024 (`docs/superpowers/specs/2026-06-12-fr-024-entity-surfaces-projections-design.md`): `object.projection`, universal `Entity.child` extends-resolution, the `via` inference contract, and the `api.operational` declared surface — across all five ports, with the decisions recorded as ADRs and every authoring-facing doc surface updated.

**Architecture:** Six sequenced phases. Phase A (this document, fully detailed) lands the durable decisions (3 ADRs) and every markdown surface, so parallel sessions and ports build against recorded contracts. Phases B–F are scoped here as **scope cards** — each gets its own detailed plan doc when execution reaches it (the repo's established pattern for multi-port FRs), because their task bodies require reading the then-current loader/codegen internals.

**Tech Stack:** Markdown/ADRs (Phase A); TS reference port (Bun) then Java/Kotlin/C#/Python; shared conformance corpus under `fixtures/`.

---

## Program sequencing

| Phase | Deliverable | Gate |
|---|---|---|
| **A** (detailed below) | ADR-0028/0029/0030 + CLAUDE.md + roadmap + FR-021 sketch annotation | docs committed, pre-commit guard green, content matches spec |
| **B** | TS metamodel core: `Entity.child` extends (fields + identities), `object.projection` + value tightening + child licensing, via rules, all §§3–7 loader checks, TS registry provider; **shared conformance fixtures authored here** | `cd server/typescript && bun test` green; new `fixtures/conformance/` fixtures pass TS runner; TS registry-conformance updated |
| **C** | TS codegen + DDL: view-DDL emitter (quoting + schema + assembly from extends/origins), projection read-only codegen + `ProjectionOf<E>` marker, entity derived-field routing/exclusions, multi-source read routing | DDL golden fixtures byte-green; generated-output snapshots; typecheck gate |
| **D** | `api.operational` (TS): loading + fixtures, route-shell codegen, verify integration, `meta docs` api/projection pages | api fixtures green; generated routes boot in the SP-B-style HTTP lane |
| **E** | Cross-port fan-out: Java/Kotlin → C# → Python loaders + codegen against the Phase-B/C/D corpus; `expected-registry.json` updated **atomically across all 5 ports** (the `@responseRef` carve-out-close playbook) | every port's conformance + registry-conformance green in CI |
| **F** | Context sweep: `agent-context/` fragments (deployed via `meta init` + the four per-port `agent-docs` doors), `fixtures/agent-context-conformance/` regen, Tier-2 feature docs | agent-context-conformance byte-green ×4 stacks |

Order constraints: B before C/D (loader first); C and D may interleave; E strictly after B+C+D (the corpus is the contract); F last (docs describe shipped behavior). Commit directly to `main` per repo convention; this repo is **public** — no private names, no absolute local paths, in any phase.

---

## Phase-B scope card (TS metamodel core — next plan doc)

- **Files (expected):** `server/typescript/packages/metadata/src/` — constants (new: `OBJECT_SUBTYPE_PROJECTION`, `API_TYPE`, etc. — constants land in B even though api loading is D, so the registry manifest changes once), extends-resolution module, loader validation, registry provider; `server/typescript/packages/conformance/` runner if new fixture concepts need support.
- **Behaviors:** spec §§3–7 — type-scoped `Entity.child` extends (fields + identities, cross-package); projection child licensing (identity-must-extend, read-only source kinds); value purity (no identity/source — verify nothing shipped violates, then enforce); **entity-primary-source-must-be-writable (the hard-cutover rule killing the two legacy spellings — migrate own fixtures, e.g. `ProgramSummary`-style and `parameter-ref-on-stored-proc`, to `object.projection` in the same plan)**; key-correspondence checks; computable identity `fields`; via single-hop-unique inference + `ERR_AMBIGUOUS_PATH`-class error + passthrough-to-one / aggregate-needs-to-many cardinality checks; extends/origin agreement check; derived-field providability.
- **Fixtures to author (shared corpus, `fixtures/conformance/`):** `projection-basic/`, `projection-wire-only/`, `projection-identity-passthrough/`, `projection-external-assembly-extends-only/`, `extends-entity-field-cross-package/`, `value-extends-entity-field-shape/` (proc-args), `entity-derived-fields-multi-source/`, plus `error-*` fixtures for every loader check above (resolved-format envelopes per ADR-0009). Error codes settled here (spec §11.1).

## Phase-C scope card (TS codegen + DDL)

- **Files (expected):** `migrate-ts` view-DDL emitter (reuse the table emitter's quoting/qualification helpers; add `schema`); `codegen-ts` entityFile/queriesFile/routesFile dispatch for projections + derived fields; marker type emission.
- **Gates:** golden view-DDL fixtures (new corpus dir, byte-compared); projection generated-output snapshots; derived fields absent from create/update Zod + write codecs; reads route to the read-role source.

## Phase-D scope card (api.operational, TS)

- **Files (expected):** metadata constants + loader (D-half: `api.base`/`api.operational`, `operation.query|command`, `binding.rest`, `inputRef`/`outputRef`/`many` resolution); `codegen-ts` route-shell generator (typed handler seam); verify (operation refs resolve; path-template ↔ identity validation); `meta docs` pages.
- **Open items to settle in its plan:** spec §11.2 (operation attr set, pagination per binding), §11.4 (single-base-entity identity rule).

## Phase-E scope card (cross-port fan-out)

- Per port (Java/Kotlin, C#, Python): loader + registry provider + codegen, driven by the Phase-B/C/D corpus — **read the TS reference implementation first** (cross-language-porting skill). `fixtures/registry-conformance/expected-registry.json` gains `object.projection`, `api.base`, `api.operational`, `operation.*`, `binding.*` in ONE commit with all five emitters updated. Java OMDB/Spring + Kotlin Exposed + C# EF (keyless entity for view-backed projections) + Python read models. Persistence-conformance gains projection read scenarios.
- **B4b — EXECUTED 2026-06-12** (the skip-ahead program pulled it forward; see the Phase-E handoff doc): ~~ the hard cutover (`ERR_ENTITY_PRIMARY_SOURCE_READONLY` rule + code) + ALL legacy-spelling migrations land HERE, atomically with the 5-port subtype registration: `fixtures/conformance/` legacy fixtures (`parameter-ref-*`, `source-db-view-projection`, `field-readonly-on-view-projection`, `source-rdb-kind-{view,proc,function}-*`, affected `origin-*`/`error-*` inputs) → `object.projection`; `fixtures/persistence-conformance/canonical/meta.fitness.json` `ProgramView`/`ProgramStat` → projections (all five ports must load them — the reason this rides Phase E); `error-entity-primary-source-readonly` cutover-proof fixture; `agent-context/` authoring SKILL.md prose refresh + agent-context-conformance regen.~~

## Phase-F scope card (context + deprecations)

- `agent-context/` source: new/updated fragments for projection authoring, derived fields, via rules, api authoring; ≤120-line always-on budget respected; regenerate `fixtures/agent-context-conformance/` (4 stacks byte-identical); per-port emit doors unchanged (content flows through).
- Tier-2 feature doc: `docs/features/` page for surfaces/projections; `meta docs` model pages already covered in D. (No deprecation work — the legacy spellings are removed outright in Phase B, hard cutover per spec §10.)

---

# Phase A — Decisions & Documentation (detailed tasks)

### Task A1: ADR-0028 — Object taxonomy: projection subtype, value purity, population doctrine

**Files:**
- Create: `spec/decisions/ADR-0028-object-taxonomy-projection-value-purity.md`

- [ ] **Step 1: Write the ADR**

```markdown
# ADR-0028: Object taxonomy — `object.projection`, value purity, and the population doctrine

## Status

Accepted (2026-06-12). Defined by FR-024
(`docs/superpowers/specs/2026-06-12-fr-024-entity-surfaces-projections-design.md`).

## Context

One logical entity needs several representations (table, full DB view, versioned
API view, REST DTO, grid) sharing identity but differing in exposed fields, naming,
and read/write-ability. The metamodel spelled "derived read shape" two accidental
ways: `object.entity` + `extends <Entity>` + view source (FR-003 — and `extends`
firehoses ALL entity fields, fail-open, with no subset mechanism) and
`object.value` + `origin.*` fields (FR-004 prompt payloads). A view is
*derived-from* an entity, not a subtype of it; `extends`-as-lineage was a standing
semantic lie.

## Decision

1. **`object.projection`** is the third object subtype: a derived, read-only
   representation of entities. Fields may be `extends`-bound (ADR-0029),
   origin-derived, or self-declared (external assembly, e.g. proc-computed); ALL are
   read-only because the subtype is. Identity is optional and, when present, MUST
   extend an entity identity (borrowed). Sources are optional and restricted to
   read-only `@kind`s. The declared field set IS the exposure — an inclusive list,
   fail-closed by construction; no allowlist mechanism exists.
2. **`object.value` is tightened to a pure shape**: no identity, no source, ever.
   Values may `extends` entity fields for shape (proc parameters, command inputs)
   with no identity/population/FK semantics.
3. **Population doctrine:** `source` answers "where is this populated from?"
   **Values are never populated — they are constructed** (by a caller, by assembly,
   or by embedding; embedded VO storage belongs to the owning entity's field).
   Message topics/queues are *channels*, not sources — they live at the surface
   layer as `binding.*` on operations (AsyncAPI's model), never in `source.*`.
4. **Derived means read-only, at two levels:** any field carrying `origin.*` is
   derived and therefore read-only wherever it lives (on entities: excluded from
   INSERT/UPDATE, write codecs, and create/update inputs); a projection is wholly
   read-only at the subtype level. No `@readOnly` attr exists — both are computed.
5. **Why a subtype despite ADR-0023** (don't declare the computable): the
   distinction is a *rule regime, not a label*. Which children a node may carry
   (identity allowed-and-must-extend vs forbidden; source read-only-kinds vs
   forbidden) is registry **child-licensing** — definitional, not computable.
   Lineage, exposure, read-only-ness, and keys all remain computed; only the
   licensing is declared.

## Consequences

- The two legacy spellings are REMOVED outright — hard cutover, no deprecation
  path (pre-GA, no users): one loader rule (an entity's primary source must be a
  writable `@kind`; read-only kinds only in read role) makes
  entity-`extends`-entity view objects and stored-proc result shapes as entities
  fail to load. Own fixtures migrate to `object.projection`. FR-004
  `value`+`origin.*` payloads remain valid — values still carry origins for
  assembly semantics; no migration is forced.
- One projection serves multiple surfaces simultaneously (DB view via its source,
  wire contract via an operation's `outputRef`, grid via a layout) — they cannot
  disagree because they are the same node.
- Entities gain first-class "view behavior": a read-role view source plus derived
  fields, write/read routing computed from `@kind` (ADR-0007 roles).
- All five ports register the subtype; `expected-registry.json` is updated
  atomically with all emitters.
```

- [ ] **Step 2: Verify the ADR renders and the decisions match spec §§3, 7**

Run: `grep -c "object.projection" spec/decisions/ADR-0028-object-taxonomy-projection-value-purity.md`
Expected: ≥ 3. Cross-read spec §3 table and §7 doctrine — no contradiction.

- [ ] **Step 3: Commit**

```bash
git add spec/decisions/ADR-0028-object-taxonomy-projection-value-purity.md
git commit -m "adr: ADR-0028 object taxonomy — projection subtype, value purity, population doctrine (FR-024)"
```

### Task A2: ADR-0029 — Universal `Entity.child` extends + the `via` inference contract

**Files:**
- Create: `spec/decisions/ADR-0029-entity-child-extends-and-via-inference.md`

- [ ] **Step 1: Write the ADR**

```markdown
# ADR-0029: Universal `Entity.child` extends-resolution and the `via` inference contract

## Status

Accepted (2026-06-12). Defined by FR-024
(`docs/superpowers/specs/2026-06-12-fr-024-entity-surfaces-projections-design.md`).

## Context

Contract shapes (projections, proc-parameter VOs, command inputs) need fields whose
type/docs/validators track an entity field, with drift caught at build time. Two
mechanisms competed: enhancing `origin.passthrough` to inherit shape, or field-level
`extends` targeting entity-nested fields. Separately, `@via` relationship paths
needed an omission rule that five loaders can implement byte-identically.

## Decision

1. **`extends` is THE inheritance mechanism; `origin.*` never inherits.** `extends`
   answers "where does this field's shape come from"; `origin.*` answers "where does
   its data come from / how is the view assembled." They are independent statements
   that often coincide and may appear together.
2. **`extends` may target an entity-nested child** (`Customer.id`, cross-package
   `acme::sales::Customer.id`), resolved **type-scoped**: a field resolves entity
   fields; an identity resolves entity identities. Universal — legal on projection
   fields, value fields, and entity derived fields alike. Existing override
   semantics apply (redeclare on the child to pin an inherited attr).
3. **Load-time drift gate:** renaming/retyping the target fails `extends`
   resolution in every referencing shape — the contract breaks the build at LOAD,
   strictly earlier than verify-time origin resolution.
4. **Identity pass-through:** `identity.primary { extends: Customer.primary }`
   anchors the projection's base entity, states borrowed identity, and enforces
   key correspondence (each entity-identity field must map to a local field whose
   `extends` target is that field). The local `fields` list is computable from
   those targets — optional, explicit-must-agree.
5. **`@via` lives on `origin.*` only** (fields never carry join mechanics) and
   **may be omitted only when exactly one single-hop relationship leads from the
   base entity to the `from`/`of` entity**. Multi-hop is always explicit;
   introducing a second path later is a load error naming the candidates
   (the human decides exactly when ambiguity is introduced). Inference stops at
   single-hop-unique deliberately: the algorithm is part of the cross-port
   conformance contract, and single-hop-unique is trivially portable.
6. **Cardinality checks:** a `passthrough` via-path must be effectively to-one at
   every hop (row-multiplying passthrough = error: you meant `aggregate`); an
   `aggregate` via-path must contain at least one to-many.
7. **Agreement check:** when a field has both `extends X` and an origin targeting
   Y, X and Y must agree (severity settled at planning; conformance-fixed).
8. **Assembly modes:** with an *emitted* source (generated CREATE VIEW), every
   non-base field needs an origin; with an *external* assembly (proc body,
   hand-written view), origins are not required — `extends`-only fields declare
   lineage over an opaque assembly, and self-declared fields are legal. Origins on
   external sources remain reference-resolved by verify; only the DDL emitter
   consumes them, and it does not run for external bodies.

## Consequences

- The RFC's proposed `viewOf` structural key is rejected — lineage is computed from
  extends targets and the extended identity (ADR-0023).
- Five loaders implement identical resolution + inference; every rule above gets a
  `fixtures/conformance/` fixture (positive + error envelope).
- "This parameter is a Case identifier" becomes computable (the extends target IS
  the entity's identity field) for doc-gen, FR-022 emission, and MCP tool schemas.
```

- [ ] **Step 2: Verify consistency with spec §§4–7**

Cross-read spec §4 (universal extends), §5 (identity pass-through), §6 (via table),
§7 (assembly modes). Expected: no contradiction; same omission rule sentence.

- [ ] **Step 3: Commit**

```bash
git add spec/decisions/ADR-0029-entity-child-extends-and-via-inference.md
git commit -m "adr: ADR-0029 universal Entity.child extends + via inference contract (FR-024)"
```

### Task A3: ADR-0030 — Declared API surface in core; protocol in bindings; organization-tier boundary

**Files:**
- Create: `spec/decisions/ADR-0030-declared-api-surface-and-org-tier-boundary.md`

- [ ] **Step 1: Write the ADR**

```markdown
# ADR-0030: The declared API surface lives in core; protocol lives in bindings; the organization tier stays out

## Status

Accepted (2026-06-12). Defined by FR-024 §9; aligns and grounds the FR-021 design
sketch.

## Context

Derived CRUD (FR-008/009) is convention-computed; non-CRUD operations and versioned
wire contracts had no declared home. Prior art reviewed for this design modeled
APIs/endpoints at an organization tier with CSV string references
(`exposedObjects: "a,b,c"`) — unresolvable, fail-open, invisible to verify. The
protocol-as-subtype trap (`api.rest` / `api.graphql` / `api.grpc`) was also
observed there.

## Decision

1. **Core vocabulary:** `api.base` / **`api.operational`**, `operation.query` /
   `operation.command`, and `binding.rest` enter the core registered metamodel
   providers, gated by registry-conformance in all five ports.
2. **The `api` subtype axis is the interaction model** — the axis that changes
   child-licensing — **never the protocol.** `api.operational` is the
   request/response surface whose children are operations; an event/streaming
   sibling (channels/messages — different children) is reserved for a future
   design. Protocol lives in `binding.*` ON operations (`rest` now; `messaging`,
   `grpc` later as registered subtypes), so one surface serves several protocols.
   A command carried over a queue is still `api.operational` — that is a binding,
   not a kind.
3. **Shapes are referenced, never defined, by the surface:** queries return
   `object.projection`s, commands take `object.value`s, both act on entities.
   A get-by-id operation needs no `inputRef` — its parameter is the projection's
   borrowed identity, computed.
4. **Derived CRUD remains the zero-config default**; a declared `api` extends it
   (per-entity opt-out per FR-021). Versioned surfaces are sibling `api` nodes
   over sibling projections.
5. **The organization tier (application / service / network / deployment /
   integration) stays OUT of core**, layered by an organization-level metadata
   tier via the provider SPI. Core owes that tier exactly one thing: `api` and
   `projection` nodes are named, packaged, FQN-resolvable — so upper-tier
   references are verifiable, never string CSVs.

## Consequences

- FR-022 emitters and future MCP exposure consume declared operations; route
  shells (parsing, validation, typed handler seam) are generated, verb bodies are
  hand-written business logic.
- The FR-021 sketch's contract shapes are retyped onto
  `object.projection`/`object.value` (FR-024 §9); its `wireId` placement stands.
- `binding.*` additions are registered subtypes, never freeform attrs (ADR-0023,
  sealed registry).
```

- [ ] **Step 2: Verify consistency with spec §9 and the FR-021 sketch**

Cross-read spec §9 and
`docs/superpowers/specs/2026-06-11-fr-021-api-metadata-and-contract-projections-design.md`.
Expected: ADR repeats no FR-021 detail it doesn't ground; subtype axis matches the
spec amendment.

- [ ] **Step 3: Commit**

```bash
git add spec/decisions/ADR-0030-declared-api-surface-and-org-tier-boundary.md
git commit -m "adr: ADR-0030 declared api surface in core, protocol in bindings, org-tier boundary (FR-024)"
```

### Task A4: CLAUDE.md — cross-language vocabulary + grammar updates

**Files:**
- Modify: `CLAUDE.md` (repo root) — the "Cross-language porting" bullet list and the "Grammar" sub-section

- [ ] **Step 1: Add the Object-subtypes bullet**

In the "Cross-language porting" → "Metamodel subtype vocabularies" bullet list,
insert a new bullet **before** the existing "Source subtypes:" bullet:

```markdown
- Object subtypes: `entity` (owns data: own identity, writable sources, lifecycle), `value` (pure shape: NO identity, NO source, ever; constructed — by caller/assembly/embedding — never populated; may `extends` entity fields for shape), `projection` (derived read-only representation: fields `extends`-bound / origin-derived / self-declared-under-external-assembly, all read-only at subtype level; identity optional and MUST extend an entity identity; sources restricted to read-only `@kind`s; the declared field set IS the exposure — inclusive list, fail-closed). A field carrying `origin.*` is derived ⇒ read-only wherever it lives (incl. on entities). See [ADR-0028](spec/decisions/ADR-0028-object-taxonomy-projection-value-purity.md).
```

- [ ] **Step 2: Add the API-vocabulary bullet**

Insert after the "Layout subtypes: `dataGrid`" bullet:

```markdown
- API subtypes: `api.base` / `api.operational` (request/response surface; subtype axis = interaction model, NEVER protocol — protocol lives in `binding.*` per operation: `rest` now, `messaging`/`grpc` reserved). Children: `operation.query` (outputRef → `object.projection`) / `operation.command` (inputRef → `object.value`). Derived CRUD (FR-008/009) stays the zero-config default; declared `api` extends it. Org-tier modeling (application/service/network/deployment) stays OUT of core — provider SPI, FQN references. See [ADR-0030](spec/decisions/ADR-0030-declared-api-surface-and-org-tier-boundary.md).
```

- [ ] **Step 3: Update the Grammar sub-section**

In the "Grammar:" bullet list, after the `@of` dotted-path bullet, add:

```markdown
- `extends` may target an entity-nested child: `Customer.id`, cross-package `acme::sales::Customer.id` — type-scoped (a field resolves entity fields; an identity resolves entity identities). `extends` is THE inheritance mechanism; `origin.*` never inherits. `@via` lives on `origin.*` only and may be omitted ONLY when exactly one single-hop relationship reaches the `from`/`of` entity (multi-hop always explicit). See [ADR-0029](spec/decisions/ADR-0029-entity-child-extends-and-via-inference.md).
```

- [ ] **Step 4: Verify and commit**

Run: `grep -n "ADR-0028\|ADR-0029\|ADR-0030" CLAUDE.md`
Expected: 3 hits in the edited sections.

```bash
git add CLAUDE.md
git commit -m "docs: CLAUDE.md cross-language vocabulary — object/api subtypes, Entity.child extends, via rule (FR-024)"
```

### Task A5: Roadmap entry + FR-021 sketch annotation

**Files:**
- Modify: `spec/roadmap.md` (the "Planned" section)
- Modify: `docs/superpowers/specs/2026-06-11-fr-021-api-metadata-and-contract-projections-design.md` (status line)

- [ ] **Step 1: Add the FR-024 roadmap entry**

In `spec/roadmap.md` "Planned", insert **before** the FR-021 entry:

```markdown
- **FR-024 — Entity surfaces: `object.projection`, universal field-`extends`, and the declared API.** A third object subtype (derived, read-only, borrowed identity via `extends`; the declared field set IS the exposure — fail-closed), universal `Entity.child` extends-resolution (load-time drift gate on every contract shape), `@via` single-hop-unique inference, multi-source entity view behavior, and the `api.operational` / `operation.query|command` / `binding.rest` surface — across all 5 ports, conformance-gated. Decisions: [ADR-0028](decisions/ADR-0028-object-taxonomy-projection-value-purity.md) / [ADR-0029](decisions/ADR-0029-entity-child-extends-and-via-inference.md) / [ADR-0030](decisions/ADR-0030-declared-api-surface-and-org-tier-boundary.md). Design: `docs/superpowers/specs/2026-06-12-fr-024-entity-surfaces-projections-design.md`; program plan: `docs/superpowers/plans/2026-06-12-fr-024-entity-surfaces-program.md`. Supersedes the shape-vocabulary half of the FR-021 sketch (its `api`/`wireId` direction stands, retyped onto projection/value).
```

- [ ] **Step 2: Annotate the FR-021 entry and sketch**

In the same roadmap "Planned" section, append to the end of the FR-021 entry:

```markdown
 **Revised by FR-024:** contract shapes are `object.projection` (query outputs) / `object.value` (command inputs); subtype vocabulary `api.base`/`api.operational`; see ADR-0030.
```

In the FR-021 sketch file, change the status line to:

```markdown
_Status: PROPOSED — REVISED by FR-024 (2026-06-12): contract shapes retyped onto `object.projection`/`object.value`; `api.base`/`api.operational` subtype vocabulary per ADR-0030; `wireId` + emitter direction stands. See `2026-06-12-fr-024-entity-surfaces-projections-design.md`._
```

- [ ] **Step 3: Verify and commit**

Run: `grep -n "FR-024" spec/roadmap.md docs/superpowers/specs/2026-06-11-fr-021-*.md`
Expected: hits in both files.

```bash
git add spec/roadmap.md docs/superpowers/specs/2026-06-11-fr-021-api-metadata-and-contract-projections-design.md
git commit -m "docs: roadmap FR-024 entry + FR-021 sketch revision annotation"
```

### Task A6: Phase-A close-out

- [ ] **Step 1: Public-hygiene sweep**

Run: `git log --oneline main -6` and `git diff HEAD~5 --stat`; then
`grep -rn "/home/\|Downloads" spec/decisions/ADR-002[89]*.md spec/decisions/ADR-0030*.md docs/superpowers/plans/2026-06-12-fr-024-entity-surfaces-program.md`
Expected: no absolute home paths, no private/sibling project names anywhere in the new files.

- [ ] **Step 2: Confirm Phase-B handoff**

State in the session: Phase A complete; Phase B requires its own detailed plan doc
(read `server/typescript/packages/metadata/src/` loader + extends-resolution first).
Do not begin Phase B without that plan.

---

## Plan self-review (done at authoring)

1. **Spec coverage:** §§2–7 → ADR-0028/0029 + Phase B; §8 → Phase B fixtures; §9 → ADR-0030 + Phase D; §10 → Phases B/C/E (removals land in B; DDL/codegen in C/E); §11 open items → assigned to Phase B (11.1, 11.3), Phase D (11.2, 11.4). CLAUDE.md/agent-context/roadmap/conformance all have explicit homes. No gaps found.
2. **Placeholder scan:** Phase A tasks contain full content (complete ADR texts, exact insertion anchors, commands). Phases B–F are explicitly scope cards for subsequent plan docs, not executable tasks — by design, per the program structure.
3. **Type consistency:** subtype/attr names used identically across ADRs, CLAUDE.md edits, and the spec (`api.operational`, `operation.query|command`, `binding.rest`, `object.projection`).

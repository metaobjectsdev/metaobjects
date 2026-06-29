# `metaobjects-audit` skill — design

_Status: Proposed · 2026-06-29_

A new agent-context skill that audits any project for how well it has integrated
MetaObjects — across the full adoption spectrum (greenfield first-pass →
deeply-integrated double-check) and both output modes (codegen + dynamic-runtime),
including the prompt pillar and the scaffold-and-own owned-generator model.

**Source brief:** a real audit + implementation pass on a TS/Python/React adopter
(captured at `/tmp/metaobjects-codegen-audit-skill-brief.md`; not committed — its
methodology is folded into this spec). This spec is the buildable design.

See also: [docs/features/codegen-concepts.md](../../features/codegen-concepts.md)
(the scaffold-and-own + authoring-ladder concepts the audit recommends against),
[ADR-0034 (scaffold-and-own)](../../../spec/decisions/ADR-0034-codegen-scaffold-and-own.md),
the agent-context skills (`agent-context/skills/metaobjects-*`).

---

## 1. Purpose, audience, boundary

**Purpose.** Assess a project — repo by repo, surface by surface — for **how much
more of it could be driven by MetaObjects metadata** instead of hand-written code, to
reduce drift and speed development. Covers normal app surfaces (entity schemas,
migrations, data-access/CRUD, validation, API routes, web UI, DTO/row mappers, runtime
models) **and** prompts (LLM prompt construction).

**Thesis (carry throughout).** Typed metadata is the durable spine; generated code is
the disposable artifact. **Hand-writing a layer the metadata could own creates a second
source of truth for one fact — it will drift.** The audit hunts those second sources of
truth and proposes folding them into the spine.

**Home.** A 6th `metaobjects-*` agent-context skill (`metaobjects-audit`), shipped into
adopter repos via `meta init` / the per-port `agent-docs` goal, so any project can audit
itself. Registered in `SKILL_NAMES`; byte-gated by the agent-context conformance corpus;
native-emitted across all five ports.

**Boundary — read-only assessment.** The skill's deliverable is a **written report file**
(the prioritized roadmap a team executes against), never silent edits. The actual
cutovers are a separate follow-on driven by the existing codegen / runtime-ui / authoring
skills. The audit's job is the map + the prioritized plan + the human-approved
ratification decisions.

**Invoke when:** "how much more can we generate / model with metadata", "audit our
codegen adoption", "find the drift", "where can MetaObjects reduce hand-written code",
"is this project ready to adopt MetaObjects", or planning a metadata-adoption roadmap.

## 2. Flow: triage → adaptive methodology → report

The skill opens with a fast, mechanical **maturity triage**, then runs one coherent
methodology that adapts to the maturity. Both paths converge on the same classification
scheme, drift hunt, gap assessment, ratification table, and tiered-roadmap report.

### 2.0 Triage (mechanical, fast)

Determine the adoption maturity and the owned-codegen posture:

- Is MetaObjects present at all? (a `metaobjects/` dir / `*.yaml` metadata sources;
  `@metaobjectsdev/*` / `com.metaobjects:*` / `metaobjects` / `MetaObjects.*` deps).
- Count metadata source lines + generated dirs (files carrying a `@generated` / `DO NOT
  EDIT` marker, repo-wide).
- **Owned-generators check (scaffold-and-own):** does the project own its generators
  (`codegen/generators/*` copied via `meta init`), or still import the **deprecated**
  package generator export (`@metaobjectsdev/codegen-ts/generators`)? Not owning the
  generators is itself a finding.

Classify: **greenfield** (none/minimal) · **partial** · **deep**.

### 2.1 Greenfield path (first-pass adoption)

No census/leverage (nothing generated yet). Instead:

- **Shape inventory:** catalog the project's existing modelable shapes — entities/tables,
  DTOs, validation schemas, routes, UI lists/forms, prompt sites — that MetaObjects
  *could* own.
- **Pick the highest-leverage wedge:** one real entity (a genuine table, single-column
  PK, standard CRUD) to model first.
- **From-zero roadmap:** `meta init` (scaffolds `metaobjects/` + **owned generators** +
  config) → model the wedge entity → `meta gen` the data layer → author a projection
  view → expand to routes/UI → add the prompt pillar where LLM calls exist. Owning the
  generators from day 1 is part of the roadmap, not an afterthought.

### 2.2 Partial / deep path (the brief's full methodology)

- **Phase 1 — Quantitative census.** Generated output (line/file counts of every generated
  dir + `@generated` files), the metadata spine (metadata + prompt-metadata lines), the
  **owned generators** (`codegen/generators/*` lines), hand-written (total LOC − generated).
  Compute the **leverage ratio** `generated_lines / (metadata_lines + generator_lines)`;
  a healthy adoption shows multi-× (example: ~4.7k spine → ~15.7k generated ≈ 3.3×).
- **Phase 2 — Coverage matrix.** Per modeled entity/projection/value: has query helpers?
  has a generated view? has routes? has UI? The gap between "modeled + has query helpers"
  (high) and "has view + route + UI" (often = 1) is the headline lopsidedness.
- **Phase 3 — Surface review (axes; independently runnable).** Each axis produces a
  classification table; synthesize, then **verify the top findings by reading the code**
  (grep finds candidates, not conclusions). Eight axes spanning **all four pillars +
  authoring-correctness** — the audit is not just "find codegen candidates", it checks
  the project *uses each pillar's safeguards*. Every axis works the **complete capability
  checklist** (§4b) so coverage is exhaustive, and respects the **calibration warnings**
  (§10b) so it never flags a per-port gap as the adopter's fault:
  - **A. Codegen candidates — API/server routes** — catalog + classify every handler.
  - **B. Codegen candidates — web/client** — every page + its data layer (hooks + central
    fetch module); grids/forms/filters vs `layout.dataGrid`/`formFile`/filter-allowlist.
  - **C. Drift hotspot — validation, mappers, runtime models** — hand-written validators/
    DTO-mappers/dataclasses shadowing a generated shape (§5); highest value.
  - **D. Prompt pillar** — every LLM prompt-construction site (§7).
  - **E. Owned generators & scaffold-and-own** — the `codegen/generators/*` files + config
    (§6).
  - **F. Drift-gate adoption (the most-missed pillar).** Is `meta verify` wired into CI
    and/or pre-commit AT ALL? `--codegen` (committed-output drift) + `--templates`
    (prompt↔payload) + `--db` (schema, Node-only) gates present? committed-codegen
    `git diff --exit-code` freshness gate? anti-pattern advisories heeded (not
    `--no-antipatterns`-suppressed)? routine `--no-verify` bypass? loader `ERR_*`/warnings
    addressed (parse the stable `code`, not message text, ADR-0009)?
  - **G. Runtime-contract anti-patterns.** Is metadata actually *loaded* at runtime, or
    frozen into hand-code? Hunt: module-global `db` instead of context-as-parameter
    (ADR-0008); wire-canonicalization (decimal/bigint→string) inside the query path
    instead of native in-process return types (ADR-0019); runtime reflection to resolve a
    type from its FQN instead of generated static imports / the FQN registry
    (ADR-0001/0017); a process-global registry instead of per-loader (ADR-0014); any
    code that **mutates the loaded metadata tree** (the spine is read-only); a JVM/Kotlin
    app missing the startup validator; writes not routed to the `@role: primary` source.
  - **H. Authoring-correctness / ADR-conformance** (deep adoption). Is the *metadata
    itself* authored correctly? Hunt: invented/unregistered `@`-attrs or post-bootstrap
    registration (strict provenance, ADR-0023 — custom attrs belong in a registered
    provider or the `attr.properties` bag); retired source-v2 forms (`source.dbTable`/
    `@name`/`@dbColumn`) instead of `source.rdb`+`@kind`+`@table`/`@column`+`@role`
    (ADR-0007/0018); taxonomy impurity (an entity over a read-only primary source; a read
    model that should be `object.projection`; a `value` carrying identity/source;
    ADR-0028); copy-pasted base-field blocks instead of an abstract + `extends`;
    `@`-prefixed YAML keys / unquoted coercible scalars (ADR-0006); relative refs in
    committed canonical JSON (ADR-0032); DB-type-as-logical-subtype (`field.timestamptz`,
    raw `@dbType`; ADR-0013); a per-port migration engine where schema is Node-`meta`-owned
    for every backend (ADR-0015).
  These axes are described as parallelizable (fan out one sub-agent per axis where the
  harness supports it; otherwise sequential) — **no mandated orchestration tool**, since
  the skill ships to varied adopter harnesses.
- **Phase 4 — Synthesize** into the tiered roadmap (§9 report).

**Verification discipline (hard rule).** Before declaring code dead/duplicated/bespoke,
read it. When something looks dead, check whether it *should* be called. When a validator
looks like a duplicate, **diff it field-by-field** against the generated schema — the
*divergence* is the finding, not the duplication.

## 3. Classification scheme (dual-axis: codegen AND runtime)

Apply to every surface; classify on **both** output modes.

| Class | Meaning | Action |
|---|---|---|
| **GENERATED** | Already driven by metadata (regenerable artifact). | Confirm it regenerates clean. |
| **OWNED-GENERATOR** | A `codegen/generators/*` file the project owns (scaffold-and-own). | Confirm clean regen; flag **drift from the current reference template** (intentional customization = good; stale = a missed upstream improvement); spot declarative-template-codegen opportunities (§6). |
| **CODEGEN CANDIDATE (high)** | Standard CRUD/list/form over a modeled (or modelable) entity; existing/near generators fit. | Author the view + generate; parity-gate the cutover. |
| **CODEGEN CANDIDATE (partial)** | Generatable data layer (hooks/queries) but bespoke presentation (charts, graphs, 3D, trace trees). | Generate the data layer; keep the viz hand-written. |
| **DYNAMIC-RUNTIME CANDIDATE** | Behavior that could be metadata-driven at runtime (dynamic forms, OMDB-style runtime persistence / typed jsonb, metadata-driven dispatch, runtime-authored prompts). | Assess runtime-metadata feasibility (heavier). |
| **BESPOKE (keep)** | Genuinely custom: aggregations/rollups, graph traversal, SSE/streaming, external calls, auth, search, dashboards/viz, deep business logic. | Leave hand-written — **but** see the exception below. |

**Output-mode reporting.** Per candidate surface, state whether **codegen**,
**dynamic-runtime**, or **both** is the better fit, and what it would take.

**The gold-standard hand-written exception.** A hand-written component that *derives* its
specifics from generated metadata (e.g. a thin persistence seam reading its column list
from the generated model rather than hardcoding it) **cannot drift** — flag it as good,
the model to emulate. Conversely, a "bespoke" component that *hardcodes* a shape the
metadata already knows is a hidden candidate.

## 4. Codegen-candidacy heuristics

**Strong candidate** when: standard CRUD/list/detail over a single entity (read via a
projection view, write via the entity); the entity is already modeled or is a clean
modelable shape; deviations are **small + parameterizable** (response envelope, PUT vs
PATCH, soft-delete strategy = generator *options*, not reasons to stay hand-written);
bespoke **sub-resources** (a clone action, a version bump) can stay hand-written and
**mount alongside** the generated router — don't let one custom action block generating
the standard 80%.

**Not a candidate (stays bespoke)** when the core logic is aggregation/metric rollups,
graph traversal, SSE/live streaming, external API orchestration, auth, vector/semantic
search, or inherently-custom presentation. The *read hooks* may still be generatable even
when the page isn't.

**Stub trap.** A route/page returning hardcoded/demo data (not DB-backed) looks like a
candidate but has nothing to replace — classify "candidate (future) — not DB-backed";
don't count its LOC as a win.

## 4b. Complete capability coverage (the exhaustive checklist)

The §5 drift signatures are the *high-value patterns*; they are NOT the full surface. To
guarantee the audit misses nothing, the skill ships a **`references/capability-checklist.md`**
fragment enumerating **every modelable MetaObjects capability** (the registry vocabulary +
the four pillars + the ADR contracts), each with its one-line audit hunt — derived
verbatim from the registry-conformance manifest (`fixtures/registry-conformance/expected-registry.json`)
so it can't drift from the real vocabulary. The agent works this checklist on every axis.
The capability families it covers (each is a hunt for "a hand-written shape the metadata
already describes"):

- **Object** — `entity` (hand-written entity/DTO/repository), `value` (hand request/command
  VOs), `projection` (hand read-model DTOs + their SQL views), `@discriminator`/
  `@discriminatorValue` (hand-rolled STI/TPH polymorphism).
- **Field** — every concrete subtype: `string @maxLength`, `int/long/double/float`,
  `decimal @precision/@scale` (lossy-float money/quantity), `boolean`, `currency @currency`
  (+`view.currency @locale`; float money / hand `*100` / `Intl.NumberFormat`), `date/time/
  timestamp` (+`@autoSet` hand-stamped created/updated), `enum @values` (hand union/enum/
  `CHECK IN`), `uuid` (string IDs), `object @objectRef/@storage` (hand-flattened/jsonb),
  `map @valueType` (ad-hoc key/value jsonb); common attrs `@column/@default/@required/
  @unique/@readOnly/@filterable/@sortable/@db.indexed/@dbColumnType/@example/@instruction/
  @xmlText`. (Cut subtypes `byte/short/class` — **do NOT audit for them**, §10b.)
- **Source** — `rdb @table/@schema` (default-naming divergence), `@kind=view/materializedView`
  (hand SQL views vs authored projection sources), `@kind=storedProc/tableFunction +
  @parameterRef` (hand-called procs vs modeled callables), `@role=primary` (manual
  write-through CQRS).
- **Relationship** — 1:N/N:1 (`@cardinality/@objectRef`: hand FK joins/finders), M:N
  `@through` (hand junction queries vs generated traversal), `@symmetric/@sourceRefField`
  (hand self-join/graph queries), `@onDelete/@onUpdate` (app-code cascades), `association/
  aggregation/composition` ownership semantics.
- **Identity** — `primary @generation` (hand-assigned PKs), `secondary @unique/@where/@expr`
  (raw-SQL partial/functional indexes), `reference @references/@enforce` (hand FK
  constraints).
- **Origin** (projection-field derivation) — `aggregate @agg/@of/@via` (hand COUNT/SUM/AVG
  subqueries or in-app rollups), `passthrough @from/@via` (denormalized-by-hand fields),
  `collection @via` (hand-assembled child collections).
- **Validator** — `required/length/numeric/array/regex` (hand field validation) AND the
  **cross-field** subtypes `comparison/atLeastOne/requiredWhen/presentIff` (hand-coded
  "end ≥ start", "one-of", conditional-required — these ARE modelable; §8 governs whether
  the constraint belongs in shared metadata).
- **View / Layout** — `view.currency @locale`; the **TS-only** `view.*` widget subtypes
  (text/dropdown/checkbox/password/…) for web consumers; `layout.dataGrid` (hand grid
  columns + hooks).
- **Template (prompt pillar)** — `prompt @payloadRef/@textRef/@responseRef/@requiredSlots/
  @maxTokens/@maxChars/@format/@model`, `output @kind=document|email + @subjectRef/
  @htmlBodyRef/@textBodyRef + parser`, `toolcall @toolName/@payloadRef` (§7).
- **Attr** — `attr.properties` (the sanctioned author key/value escape hatch — ad-hoc
  metadata stuffed in code/comments could ride it), `attr.filter/class` (preset filters /
  binding facets).
- **Common doc attrs** — `description/title/summary/notes/deprecated/replacedBy/seeAlso/
  aliases` (weak generated docs; deprecation modeled vs code-comment).
- **Cross-cutting** — `extends` (any depth, cross-package `::`) vs copy-pasted base blocks;
  the filter-operator + sort + pagination + `withCount` REST layer; `apiPrefix` /
  `columnNamingStrategy` single-source config; per-target output dirs.

The checklist also carries the §10b calibration flags inline (per-port codegen gaps, cut
subtypes, planned-not-shipped surfaces) so a check is never run where the capability
doesn't exist for that port.

## 5. Drift signatures (the highest-value findings; grep-then-verify)

Second-sources-of-truth that will (or do) drift. This axis usually finds the active bugs —
prioritize it.

1. **Hand-written validators shadowing a generated insert/contract schema** — same field
   set, stricter or looser (`required` where metadata is optional; added
   `.positive()`/`.url()`/`.min`/`.max`/enum the generated lacks). **Diff field-by-field;
   the divergence is the bug.** (Example: a hand validator marked fields `required` that
   metadata modeled optional → 400'd legitimate partial writes in production.)
2. **Hand-written field-by-field serialize/deserialize / DTO↔model / row mappers** — a
   ~100-line by-hand field map duplicates the model's field list and silently drops a
   field when the metadata grows one. Replace with `model_dump`/`model_validate` (or the
   port equivalent), preserving only non-mechanical bits (truncations, lenient fallbacks).
3. **camelCase↔snake_case / body↔column maps** hand-maintained beside a generated view
   that already renames.
4. **Comments admitting the drift:** "matching the X dataclass", "keep in sync with",
   "mirrors the Y schema". Grep them.
5. **Runtime schema patching:** `ALTER TABLE … ADD COLUMN IF NOT EXISTS`, `_ensure_schema()`,
   "create column on first write" — drift made executable; a loud signal the schema has
   N owners.
6. **N declarations of one shape:** the same entity as a Drizzle table + Zod schema +
   Pydantic model + hand dataclass. Count declarations; target is 1 (metadata) + N
   generated.

Per finding record: `file:line` → what → generated-equivalent exists? → recommendation
(alias to generated / delete / reconcile-then-consume).

## 6. Owned-codegen & scaffold-and-own assessment (the current model)

Reflect the *current* recommended model — own + customize + declarative templates — not
just consume-the-built-ins.

- **Posture finding.** If the scaffolded config still imports the **deprecated**
  `@metaobjectsdev/codegen-ts/generators` package export (or the port equivalent) instead
  of owned `codegen/generators/*`, recommend the scaffold-and-own migration (`meta init`
  copies the reference templates; import them locally).
- **Audit the owned generators** (`codegen/generators/*`): (a) do they regenerate clean?
  (b) have they **drifted from the current reference templates** — intentional
  customization (good) vs stale/accidental (a missed upstream fix)? (c) are they
  hand-rolling a `walk` that the new **declarative `scope` + `outputPattern`** could
  replace? (d) could a bespoke output shape be a **`--template-spec` / `templateGenerator`**
  rather than a forked generator?
- **The authoring ladder (recommend against this; mirrors codegen-concepts):**
  built-in fits → use it · close → **own a copy and customize** (the default) · new shape →
  **author a declarative template-spec / custom generator from the metadata** ·
  genuinely un-modelable → hand-write (and even then, import the generated types).
- **Generator-gap & tooling check.** Inventory available generators (built-in +
  owned/local): entity, query helpers, contract/validators, hooks, list (card/table?),
  forms, routes (CRUD? read-only-list?), prompt render/parser. Find the **missing**
  generators that block the biggest wins (a table-list sibling to card-list, a form over
  the insert schema, a read-only-list route mode). Recommend per gap: **own + customize a
  template** / **author a declarative template-spec** / **fix upstream** (PR) /
  **stopgap** (hand-author one artifact, documented) — by effort/longevity.
- **Projection views must be authored per entity** for the view-reading route/UI
  generators — cheap but required, a per-surface task.
- **Test the toolchain's edges before promising them.** Computed/derived view columns are
  a known soft spot: does `origin.aggregate` actually render in the *view DDL* (not only
  the contract)? does a filtered aggregate (`@filter` → `FILTER (WHERE …)`) render? do
  inverse-FK aggregates resolve the join? **Verify the DB artifact, not just the generated
  types** — the contract may claim a column the view DDL dropped.
- **Version skew is real.** Check the *actually-resolved* package versions (the CLI's own
  `node_modules` / the resolved Maven/pip/NuGet versions), not the declared ones. A fix
  present in source/main may be absent from what the project runs; consuming a fix means a
  coordinated lockstep version bump, not a single-file dist copy across a version boundary.

## 7. Prompt-pillar assessment

Prompts drift like data shapes, with no protection by default. The pillar models a prompt
as: a **typed payload projection** (inputs as a VO) + **external template text**
(provider-resolved) + **deterministic render** (Mustache; byte-stable so prompt-cache
prefixes don't break) + a declared **output contract with a generated parser** + a
**`meta verify` drift gate** (a renamed payload field fails the build).

Hunt these anti-patterns per prompt-construction site:

- **Inline prompt strings** (triple-quoted / template-literal constants in service code).
- **Untyped payloads** (`str.format(**dict)` / f-strings / `.format()` over an ad-hoc dict)
  — the payload should be an `object.value` projection whose fields declare `origin.*`
  (`passthrough` / `aggregate` / **`collection`** for nested child lists).
- **The silent-degradation hack** (`try/except KeyError` or `?? ''` around prompt
  formatting that degrades when a key is missing — the motivating failure the pillar
  prevents; flag every instance).
- **Hand-rolled output parsing** (regex / XML / ad-hoc JSON extraction instead of a
  declared `template.output` + generated `parse*`/`safeParse*`/`extract*` parser). NOTE:
  parser codegen ships TS/C#/Python/Kotlin; **Java hand-writes the Jackson one-liner** —
  don't flag that as a defect (§10b).
- **Engine-side formatting / whitespace** that breaks byte-identical render (locale/number/
  date formatting in the engine; missing `@format` escaper; no CSV/spreadsheet-injection
  guard for exports) — pre-format on the payload; prompt-cache exact-prefix hits depend on
  byte-stability.
- **`template.toolcall`** — LLM tool schemas hand-defined / re-registered per call instead
  of a modeled `toolcall @toolName/@payloadRef` (vendor identity stays in a provider, not
  the subtype; ADR-0011).
- **`@responseRef` + AI-trace** — hand-parsed LLM responses with no typed response shape;
  a trace store whose `voRequest`/`voResponse` jsonb columns are *authored* `field.object`
  (never loader-derived — the loader must not mutate the tree), with the vendor SDK client
  + pricing BYO (ADR-0024).
- **No prompt↔payload drift gate** (`meta verify --templates` not run) and **no `@maxChars`/
  `@maxTokens` budget** declared (size enforced ad-hoc).

Classify each prompt: fully-modeled / partial (text external, payload untyped) / fully
inline. Recommend the migration (typed payload VO → external provider-resolved text →
deterministic render → output parser → `verify --templates` gate), and note cross-consumer
prompt-sharing opportunities.

## 8. Semantic-constraint ratification (prevents over-modeling)

When folding a hand-written validator's constraints into metadata, **do not auto-add
metadata attributes** — per-constraint human judgment:

> A constraint enters **shared metadata** only if it is a **true cross-language domain
> invariant** (true in every language, layer, consumer). A one-consumer UI/policy
> preference stays in a **thin local refinement layer** wrapping the generated schema in
> exactly one place.

Cross-field rules **are** modelable — the validator vocabulary includes `comparison` /
`atLeastOne` / `requiredWhen` / `presentIff` — so a hand-coded cross-field check IS a
candidate. The ratification decides *which* belong in **shared** metadata, not whether
cross-field validation can be modeled at all.

Heuristics: distinguish **`required` from has-a-safe-default** (hand code conflates them;
the truer model is often `@default`, which *fixes* the over-requiring bug); check the
attr actually **generates in every layer** before modeling it (some don't render into the
validation schema, only the DB column); model **universal numeric/format invariants**
(non-negative count, positive rate, 0–23 hour, closed enum) — they generate + enforce
everywhere; model a **universal** cross-field invariant ("a discount can't exceed the
price") but **resist non-universal ones** ("start < end" when the window can legitimately
wrap); remember **a core metamodel attr ripples cross-port** (all ports' conformance +
drift gates) — for a one-consumer need, read the attr codegen-locally instead.

Output a **ratification table** per constraint: KEEP-IN-METADATA / LOCAL-REFINEMENT / DROP,
with rationale — explicitly **human-approved, not applied silently**.

## 9. The report (the deliverable)

A single written report file with these sections:

1. **Triage + census** — maturity (greenfield/partial/deep), owned-generators posture, the
   leverage numbers + ratio (partial/deep) or the shape inventory (greenfield).
2. **Coverage matrix** — entities modeled / with query helpers / view / route / UI;
   headline the lopsidedness.
3. **Per-surface classification** — tables for routes, web, validators/mappers, prompts,
   owned generators: surface → class → entity → metadata-exists? → notes (cite file paths).
4. **Drift findings** — prioritized by risk (active bugs first): `file:line` → what →
   generated-equivalent? → fix.
5. **Owned-codegen & generator gaps** — owned-generator drift; what's missing/broken in
   the toolchain that blocks candidates; own-vs-template-spec-vs-upstream-vs-stopgap per
   gap; **intra-port** version-skew warnings (never cross-port, §10b).
6. **Drift-gate adoption** (axis F) — is `verify` wired into CI/pre-commit? which subverbs
   (`--codegen`/`--templates`/`--db`); committed-codegen freshness gate; advisories
   suppressed?; `--no-verify` bypass; unaddressed loader `ERR_*`/warnings.
7. **Runtime-contract & authoring-correctness findings** (axes G + H) — runtime
   anti-patterns (module-global `db`, wire-canonicalize in the query path, runtime
   reflection, global registry, metadata-tree mutation, missing startup validator) and
   metadata-authoring defects (invented attrs, retired source-v2 forms, taxonomy impurity,
   copy-paste vs `extends`, YAML coercion, relative canonical refs, per-port migrate engine).
8. **Semantic-constraint ratification table** — the per-constraint decisions to approve.
9. **Prompt-pillar assessment** — per prompt: modeled / partial / inline; the migration.
10. **Prioritized roadmap**, tiered:
   - **Tier 1 — drift kill (no new tooling):** retire divergent validators/mappers/
     serializers. Removes active bug classes. Smallest blast radius. First.
   - **Tier 2 — clear wins with existing/owned generators:** surfaces that fit today once a
     view is authored.
   - **Tier 3 — new generators / projections:** biggest LOC win, gated on owning/authoring
     the missing generators (table-list, form, declarative template-spec).
   - **Tier 4 — dynamic-runtime / prompt-pillar / cross-port:** the deeper, higher-ceiling
     work.
   Each item: estimated hand-written LOC retired, prerequisite (view? generator? version
   bump?), and "**parity-gate before deleting hand-written code**."

Quantify total retirable LOC and the new durable spine (generators + views) it costs.

## 10. Guardrails (gotchas, as warnings in the skill)

- **Parity-gate every cutover.** Prove the generated replacement is behavior-equivalent
  against a running stack (e2e + contract tests) before deleting hand-written code.
  Generated schemas are often *looser*; tightening to the already-enforced rules is a
  no-op for valid data — but run the suites per surface.
- **Verify, don't assume.** Read the code behind a grep hit. "Dead" code may be unwired; a
  "duplicate" validator's *divergence* is the finding.
- **Characterize untested behavior-changing refactors.** Before replacing a hand mapper
  with `model_dump`, empirically diff old-vs-new round-trips; preserve non-mechanical bits.
  (`model_dump` surfaces latent type inconsistencies the hand mapper masked — treat as a
  finding, fix toward metadata authority.)
- **Verify the DB artifact, not just the types** — a computed column may be in the contract
  but dropped from the view DDL; the contract lies.
- **Public-repo hygiene when filing upstream** — genericize the consumer's project/client
  names + local paths before committing to the public metaobjects repo (a commit guard may
  block private names).
- **Consumption ≠ a dist copy across versions** — bump + rebuild the metaobjects packages
  lockstep and install; copying a source-built file into an older-version install fails on
  API skew.
- **Don't let one bespoke action block generating the entity** — generate the CRUD; mount
  the custom action hand-written alongside.
- **Stub surfaces are not wins** — demo-data routes/pages have nothing to replace.

## 10b. Calibration — port gaps & non-defects (do NOT score these as adopter fault)

A correct audit *never flags a capability that doesn't exist for the project's port/stack.*
These guards live in SKILL.md and (per-port) in the references; the agent consults them
before raising a finding. Mis-flagging a by-design gap is the audit's worst failure mode.

- **Per-port codegen gaps** (hand-code there is expected, not a defect):
  - **Filter-operator route codegen** is full only in **TS**; Java/Kotlin/C#/Python generate
    pagination/sort/`withCount` but **defer filter ops** — don't flag hand-added filter
    handling in those ports.
  - **Output-parser codegen** ships TS/C#/Python/Kotlin; **Java hand-writes** the Jackson
    parse — acceptable.
  - **Python** still hand-wires the FastAPI router (and the repository impl) around a
    generated `APIRouter`; relationship / non-`table` source-kind / `field.object flattened`
    codegen is partial.
  - **C#** has **no ObjectManager runtime tier** (EF Core *is* the runtime) — hand services
    over the generated `DbContext` are expected; NuGet may be consumed from source.
- **Cut subtypes** — `field.byte` / `field.short` / `field.class` are non-functional stubs,
  **removed**; never recommend them.
- **TS/web-only** — the `view.*` widget subtypes (text/textarea/dropdown/checkbox/password/…)
  exist only for TS/web consumers; scope those checks to TS adopters (only `view.base` /
  `view.currency` are cross-port-gated).
- **Planned, not shipped** — `api.*` / `operation.*` / `binding.*` (declared-API, FR-024) and
  **MCP exposure** of declared prompts/tools are NOT yet in the registry; their absence is
  not an adopter defect.
- **Cross-port version skew is by design** — TS/C#/Python on the `0.x` line vs Java/Kotlin
  on the `7.x` Maven line is correct; **never flag it**. (Flag only *intra-port* version
  drift — mixed `@metaobjectsdev/*` / `com.metaobjects:*` / `MetaObjects.*` versions within
  one port, or a runtime package in `devDependencies`.) The cross-port coordination point is
  the conformance CAPABILITIES manifest, not a shared number.
- **Stale upstream prose** — the README's "hand-write the Spring controller" note for
  Java/Kotlin is **out of date** (controllers ARE generated); trust the port docs +
  `meta gen --list`, not stale prose.

## 11. File structure & build

- **`agent-context/skills/metaobjects-audit/SKILL.md`** — port-agnostic spine: purpose +
  thesis (§1), the triage + phased **checklist** with the 8 axes (the agent makes todos
  from it; §2), classification scheme (§3) + candidacy heuristics (§4), drift signatures
  (§5) + owned-codegen assessment (§6) + prompt anti-patterns (§7) as grep-then-**verify**
  hunts, the semantic principle (§8), the **report template** (§9, the deliverable),
  guardrails (§10) + the **calibration / non-defect guards** (§10b). SKILL.md points to the
  capability checklist + per-port references, and **maps each recommended cutover to the
  right sibling skill** — author metadata → `metaobjects-authoring`; generate/own
  generators → `metaobjects-codegen`; routes/runtime/web → `metaobjects-runtime-ui`;
  prompts → `metaobjects-prompts`; wire drift gates + migrations → `metaobjects-verify`.
- **`agent-context/skills/metaobjects-audit/references/capability-checklist.md`** —
  port-agnostic: the **exhaustive** modelable-capability checklist (§4b) derived from the
  registry-conformance manifest, with each capability's audit hunt + its inline calibration
  flag. The completeness backbone; always installed (no stack gate).
- **`agent-context/skills/metaobjects-audit/references/{typescript,csharp,java,kotlin,python}.md`**
  — per-port specifics, stack-gated install (like the other skills): how to find generated
  dirs + run gen/verify in that port; the per-language drift signatures (`model_dump`/Zod/
  records/etc.); the **owned-generators** location + the deprecated-export name to grep; the
  version-skew check for that ecosystem (resolved CLI deps); and **that port's calibration
  gaps** (§10b — e.g. Java hand-writes the output parser; Python hand-wires the router; C#
  has no ObjectManager; non-TS ports defer filter-op codegen) so the audit doesn't
  mis-flag them.
- **Register** `metaobjects-audit` in `server/typescript/packages/sdk/src/agent-context/types.ts`
  `SKILL_NAMES`; confirm `assemble.ts` emits the new SKILL.md + all references (deploy-all);
  **regenerate** the 4 agent-context conformance fixtures
  (`bun scripts/regen-agent-context-conformance.ts`); verify **native per-port emit** (the
  Python/JVM/C# `agent-docs` paths bundle the same `agent-context/` tree — gated by
  `fixtures/agent-context-conformance/`). The always-on `AGENTS.md`/`CLAUDE.md` template
  lists the `metaobjects-*` skills — confirm the audit skill appears.
- **Content review** (the agent-context P0 lesson): the skill must cite only **real** APIs
  / commands / generator names / metamodel attrs per port — no invented `meta` flags,
  generator names, or attrs. The capability checklist is **generated from / diffed against**
  `fixtures/registry-conformance/expected-registry.json` so it can't claim a vocabulary the
  registry doesn't have. Cross-check commands against the live codegen/verify/authoring/
  prompts/runtime-ui skills + the CLI surface.

## 12. Out of scope

- The cutovers themselves (separate follow-on; the audit is read-only map + plan).
- A new CLI command (`meta audit`) — the skill is methodology + report, not tooling; a
  CLI surface could be a later enhancement if demand appears.
- Auto-applying semantic-constraint or drift fixes — all are human-approved.
- The optional Changesets/automation improvements to the skill's own delivery.

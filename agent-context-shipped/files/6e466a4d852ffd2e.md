---
name: metaobjects-audit
description: Use when assessing how well a project that already uses MetaObjects has adopted it — a first-pass or deep audit that finds hand-written code the metadata could own and produces a scored, prioritized adoption-audit report (JSON plus Markdown) covering codegen, runtime, drift gates and prompts. Read-only.
---

# MetaObjects adoption audit

Typed metadata is what lasts; generated code is replaceable. A hand-written layer the
metadata could own is a second source of truth for one fact, and it will drift. This audit
finds those second sources and proposes folding them into the model where that pays: the
generator plus its output and added metadata is fewer lines than the hand-written code it
replaces, more of that shape are coming, or silent drift is the risk. A one-off layer that
fails that cost test is acceptable, not a defect.

## Essentials

- **Read-only.** The deliverables are `.metaobjects/adoption-audit.json` and a rendered
  Markdown report. The audit never edits code and never authors metadata: each finding's
  `metadata_sketch` is a proposal for a human to review, and cutovers run through the other
  skills (the bridge at the end).
- **Metadata follows the code.** This is an existing project, so its code and live schema are
  the specification. Every `metadata_sketch` reproduces the code's native types, names and
  nullability (`field.uuid` where the code uses `UUID`; carry over `@column` / `@table` /
  `@required`), and every cutover leaves code the generator is not replacing alone: propose
  customizing the generator to match the existing shape before proposing edits to working
  call sites. When a choice is ambiguous, flag it for the human; do not pick the option
  with more churn. (`metaobjects-authoring`, "Adopting onto an existing codebase".)
- **Read the code behind every hit before raising a finding, and check
  `references/calibration.md` first.** A grep hit is a lead. Calibration lists the port gaps
  and non-defects that are never the adopter's fault. Under-flag: a false finding costs the
  report more trust than a missed one.
- **Parity-gate every cutover.** Prove the generated replacement behaves the same before
  hand-written code is deleted; generated schemas are often looser.
- **Check the database artifact, not only the types.** A contract can claim a computed
  column the view DDL dropped.
- **One bespoke action does not block generating the entity.** Generate the CRUD and mount
  the custom action beside it.
- **Check resolved package versions, not declared ones.** Consuming a fix means a coordinated
  version bump and rebuild, not a copied dist file.

## Reference files — open the one your task needs

| File | Open it when |
|---|---|
| `references/calibration.md` | Before raising any finding: it lists the port gaps and non-defects that are never the adopter's fault. |
| `references/surface-review-axes.md` | Working any axis (A–I) of Phase 1b. |
| `references/capability-checklist.md` | On every axis: the exhaustive list of what the metamodel can express, one hunt per capability. |
| `references/drift-signatures.md` | Hunting hand-written second sources of truth (validators, mappers, comments, views, JSON bags, physical-name literals, enum-member and event-name literals). |
| `references/prompt-anti-patterns.md` | Axis D: the project builds text sent to an LLM or parses a reply. |
| `references/vocabulary-hygiene.md` | Axis I: retired or deprecated authoring forms, custom vocabulary, vocabulary opportunities. |
| `references/requirements.md` | Axis E2: the project declares `requirement.*` nodes. |
| `references/typescript.md`, `java.md`, `kotlin.md`, `csharp.md`, `python.md` | The server port the project uses (only the ports in the project's stack are installed). |

## Phase 0: triage

- Is MetaObjects present? (A `metaobjects/` directory or other metadata sources; the
  `@metaobjectsdev/*` / `com.metaobjects:*` / `metaobjects` / `MetaObjects.*` dependencies.)
- Count metadata source lines and every `@generated` / `DO NOT EDIT` file in the repo.
- Run the owned-generators check and the version check below.
- Classify the project **Greenfield** (none or minimal), **Partial** or **Deep**, and take
  the matching path.

### Owned generators

Find which generators the project owns at `codegen/generators/*` (through `meta eject`, or
`meta init` on a CLI before 1.0.4) and which it imports from
`@metaobjectsdev/codegen-ts/generators`. Both are supported from 1.1. The import is the right
choice for a generator the project does not change, and is never a finding by itself.

Every port owns generators the same way. Run each port's listing (TypeScript
`meta eject --list --format text`, Python `metaobjects gen --list`, Java / Kotlin
`mvn metaobjects:eject -Dlist`, C# `dotnet meta gen --list`) and read each row for what it
proves:

| The listing says | What that proves | What to do |
|---|---|---|
| `identical to the reference` | The copy is unmodified. This is the only mark that proves it. | Duplication that falls behind the reference: recommend the package import. |
| `same content as the reference, your formatting`, or `DIFFERS` with `0 line(s) of your own` | No added or edited lines. Removed or reordered lines are not ruled out. | Confirm from the file's history (`git log -p -- codegen/generators/<name>.ts` shows no edit after the eject). A copy you cannot confirm is reported as "possibly customized: check its history", not as a copy to drop. |
| `DIFFERS` with lines of its own | Nothing by itself. The listing prints `DIFFERS` both for a deliberate customization and for a copy gone stale by version, and `M of your own` includes every line the reference has since removed or rewritten, which are older upstream lines. | Run the history check on every such row. Report two figures separately: lines behind the reference, and lines of the project's own that the history confirms. A copy stale by version is a finding (`owned-generator-stale`). |

- **Runtime adapters.** For `entity`, `routes` and `routes-hono`, "unmodified" holds only when
  every `codegen/runtime/` file the copy reaches is also marked identical: an edited adapter
  is a customization, and such a copy is not a finding. Those runtime rows appear only with
  `--format text` (or as the `runtimeCopy` array inside the row's `source` object in
  `meta gen --list --format json`); a listing with no runtime rows is not evidence that the
  adapter is unmodified.
- **A 1.0.x install.** An import of `entityFile` / `queriesFile` / `routesFile` / `barrel`
  fails to load there, because 1.0 removed those four and 1.1 restored them. That is an
  upgrade blocker, fixed by upgrading to 1.1 or by `meta eject <name>` if the project has to
  stay on 1.0.x.
- **One total across every port:** unmodified owned-generator lines over all owned-generator
  lines, where unmodified counts only copies proven unmodified. Report the proven copies
  together as one finding, `owned-generator-stock-copies`, listing each copy and its port's
  undo command.

### Cross-language version consistency

If the project uses MetaObjects in more than one language (a TypeScript web client with a
Java, Python or C# backend, say), list every MetaObjects package across every ecosystem (npm
`@metaobjectsdev/*`, Maven `com.metaobjects:*`, PyPI `metaobjects`, NuGet `MetaObjects.*`) and
record each resolved version.

**The version lines differ by ecosystem, so drift cannot be judged by eye.** npm, PyPI and
NuGet are on `0.x` / `1.x` and Maven on `7.x` / `8.x`: a `0.12` beside a `7.7` looks fine and
can be badly out of step. Compare instead:

- **The `metamodelVersion` each port reports** (the shared spec version on the registry
  manifest). A mismatch is real cross-language drift and a finding: the ports disagree on
  vocabulary or wire behavior.
- **Each port's release.** A match on `metamodelVersion` is not enough, because added
  vocabulary does not move it. Line up each ecosystem's version for the same CHANGELOG entry;
  a port on an older release is a finding when the model uses vocabulary that release lacks.
- **The latest release.** Also flag any port not on the latest release for its ecosystem.

This failure has been seen in practice: newest backend, stale client, invisible because the
numbers differ.

## Phase 1a: the Greenfield path

- **Shape inventory.** Catalog the modelable shapes: entities and tables, DTOs, validation
  schemas, routes, UI lists and forms, prompt sites.
- **Pick a wedge:** one real entity (single-column PK, standard CRUD) to model first.
- **From-zero roadmap:** `meta init` → model the wedge → `meta gen` the data layer → author a
  projection view → expand to routes and UI → add the prompt pillar where LLM calls exist.
  Choosing and owning generators from day one is part of the roadmap.

## Phase 1b: the Partial / Deep path

**Census.** Generated output line and file counts, plus metadata and owned-generator lines.
Compute the **leverage ratio**, `generated_lines / (metadata_lines + generator_lines)`; a
healthy one is a multiple (for example about 4.7k lines of model and generators to about
15.7k generated, 3.3×). Do not report a generated-share or leverage figure alone, or as a
target: pair it with the **net hand-written line change** (hand-written lines removed minus
generator and metadata lines added), because a share can rise while total hand-written code
grows.

**Coverage matrix.** Per entity, projection and value object: query helpers? view? routes?
UI? The gap between "modeled, with query helpers" and "has view, route and UI" is the
headline lopsidedness.

**Shape coverage census.** The coverage matrix lists modelled entities only, so a shape
nobody modelled never appears in it. Count the other side too. List every shape that crosses
a boundary: database tables and views, request and response bodies, queue and socket
messages, prompt inputs, LLM replies, and file formats the project reads or writes. For each
shape, record whether it is modelled, and for each layer that states it (DDL or migration,
ORM model, validator, DTO, client type, prompt payload, reply parser) whether that statement
is **generated**, **derived** from generated code (a type built from a generated type, a
`z.infer` of a generated schema), or **hand-declared**. Report
`generated or derived statements / all statements` and list the unmodelled shapes. A table
present in the database or the migrations with no entity or projection behind it is a
finding (`unmodelled-table`). Like the leverage ratio this is a measurement, never a target:
an unmodelled shape is a finding only where the cost test says modelling it pays, or it is a
table.

**Surface review.** The axes can be run independently. Work the full
`references/capability-checklist.md` on every axis; the hunt for each axis is in
`references/surface-review-axes.md`. For a "duplicate" validator, the place where it
diverges from the model is the finding.

- **A.** Codegen candidates — API / server routes · **B.** Codegen candidates — web / client
- **C.** Drift hotspot — validators, mappers, runtime models · **D.** Prompt pillar
- **E.** Owned generators and scaffold-and-own · **E2.** Capability ledger (`requirement.*`, opt-in)
- **F.** Drift-gate adoption — does it block? · **F2.** Over-generation and generated-but-bypassed (codegen waste)
- **G.** Runtime-contract anti-patterns · **G2.** `own*()` accessor discipline (a correctness defect, not advisory) · **G3.** Guarded status transitions (every write to a status-like enum column is conditional on the current value; the fix goes through the port's ORM with generated constants, never raw SQL)
- **H.** Authoring correctness / ADR conformance · **H2.** Wrong native type (`field.string` + `@dbColumnType: uuid`)
- **I.** Vocabulary hygiene / modernization (advisory, never a failing finding)

Then synthesize the findings into the tiered roadmap and write both artifacts.

## Classifying a surface (on codegen and on runtime)

| Class | Meaning | Action |
|---|---|---|
| **GENERATED** | Driven by metadata (regenerable). | Confirm it regenerates clean. |
| **OWNED-GENERATOR** | `codegen/generators/*` file the project owns. | Confirm clean regen; flag drift from reference template. |
| **CODEGEN CANDIDATE (high)** | Standard CRUD/list/form over a modeled or modelable entity. | Author the view + generate; parity-gate. |
| **CODEGEN CANDIDATE (partial)** | Generatable data layer, bespoke presentation. | Generate data layer; keep viz hand-written. |
| **DYNAMIC-RUNTIME CANDIDATE** | Behavior that could be metadata-driven at runtime. | Assess runtime-metadata feasibility. |
| **ACCEPTABLE (one-off)** | A hand-written layer the metadata could own, but an owned generator for it would cost more lines than it replaces, no more instances are expected, and nothing drifts silently (it reads typed generated properties). | Report as acceptable. Not a defect, not a recommendation to generate. Re-class if it recurs or drift appears. |
| **BESPOKE (keep)** | Genuine custom: irreducible SQL (recursive CTEs, window functions, set ops — NOT plain count/sum/avg rollups, which are `origin.aggregate` on a projection), graph, SSE, auth, search, viz. | Leave hand-written — still import generated types. |
| **VOCAB CANDIDATE (advisory)** | A recurring, closed hand-coded pattern (parallel integration modules / an ad-hoc string discriminator) that project-registered vocabulary — a custom subtype/attr via a provider — plus a small owned generator would own. | Propose the provider + `metadata_sketch`; apply the ADR-0037 ordered test; advisory only. |

**A hand-written component that derives from generated metadata cannot drift: flag it as
good.** A "bespoke" component hardcoding a shape the metadata knows is a hidden candidate.
A demo-data route has nothing to replace: classify it "candidate (future), not DB-backed".

## Owned generators and generator gaps

- **Audit each owned generator.** Does it regenerate clean? Has it drifted from the
  reference on purpose (good) or gone stale (a missed upstream fix)? Decide that from the
  copy's history, as in Phase 0, not from the listing's count. Does it hand-roll a walk that
  a declarative `scope` + `outputPattern` could replace? Would a bespoke shape be better as a
  `templateGenerator` than a forked generator?
- **The authoring ladder to recommend from:** a built-in fits → import it as shipped; close →
  eject it and customize the copy; a new shape → author a declarative template-spec or a
  custom generator from the metadata; cannot be modelled → hand-write, still importing the
  generated types.
- **Generator gaps.** Are missing generators blocking the biggest wins? Recommend per gap:
  own and customize, author a template-spec, fix upstream, or a stopgap. Cost-test every
  recommendation to generate (`metaobjects-codegen`, `references/owning-generators.md`): an
  owned generator is worth it only if generator plus output is smaller than the code it
  replaces, more instances are expected, or drift protection is the point. A layer that
  fails is ACCEPTABLE, and an owned generator larger than the code it replaced is itself a
  finding. A general-shape generator belongs in the library, not in each app.
- **An undeclared hand-written database view is invisible to `meta verify --db`.** A view
  that is neither modeled nor carried in the `source.rdb` `@sql` / `@unmanaged` escapes is
  reported as informational only, so a hand-written view standing in for an expressible
  `object.projection` or entity read-view can only be found here (drift signature 8 in
  `references/drift-signatures.md`). Once carried in `@sql` it is registered and
  drift-checked.

## Ratifying constraints before they enter the model

When folding hand-written validators into metadata, each constraint needs a human decision,
because a constraint in shared metadata reaches every port. It belongs there only if it is a
true cross-language domain invariant; one consumer's preference stays in a thin local
refinement layer.

Cross-field rules are modelable (`comparison` / `atLeastOne` / `exactlyOne` /
`requiredWhen` / `presentIff`); ratification decides which belong in shared metadata. Output
a **ratification table**: KEEP-IN-METADATA / LOCAL-REFINEMENT / DROP, with the rationale,
for a human to approve. Never apply it silently. Tell `required` apart from has-a-safe-default
(`@default` often fixes an over-requiring bug).

## Scoring: no single score, bands not decimals

1. **Headline maturity tier.** Greenfield → Partial → Deep → Exemplary, worst-of with
   prerequisite gating (a missing pillar cannot be averaged away), shown with the single
   next unmet check ("you're Partial; the next rung needs a blocking `verify` in CI").
2. **Per-pillar breakdown, never rolled into one number.** `pillar | tier | top gap` over
   codegen / runtime / drift-gate / prompts. This is the core deliverable.
3. **Binary CI drift gate**, prominent and separate: "Does `meta verify` drift detection
   block every route to production?" It is binary because the risk is. YES only when axis F
   scores the gate **BLOCKING**; RUNS BUT DOES NOT BLOCK and ABSENT both answer NO, with the
   reason (exit code swallowed, tolerated error count, a deploy path that skips it, no CI).
   Local hooks with no tracked installer do not count.
4. **Used as described.** One line, separate from the tier: does the project use what it
   adopted the way MetaObjects documents it? Built from four measurements, each shown with
   its numbers: generated artifacts consumed rather than bypassed (axis F2, `consumed /
   emitted` and the `generated-and-bypassed` count); the gate blocks (axis F score); prompt
   payload fields linked to entity fields (axis D, `linked / (linked + unlinked copies)`);
   and boundary shapes generated or derived (the shape coverage census). Render it as
   `Used as described: <band> — generated forms 5/12 consumed · gate RUNS BUT DOES NOT
   BLOCK · payload fields 6/10 linked · shapes 50% generated or derived`, banded by its worst
   part.

Coarse bands only (none / some / most / all), worst-of within a pillar. Lead with the gaps,
not the grade. Vocabulary hygiene (axis I) is advisory: it appears as modernization
opportunities in the roadmap and never gates a tier, because dated vocabulary that works is
not a defect.

**On a re-run, compare with the previous audit.** If `.metaobjects/adoption-audit.json`
already exists, read it before starting and keep it as the baseline. Match each earlier
finding to this run's by `id` plus location, and give every earlier finding a `status`:
**fixed** (the location no longer shows it; say what changed), **open** (still present,
carrying its original `first_seen`), or **deferred** (the project recorded a decision not to
fix it now, in a commit, an ADR, a tracked issue or a code comment, quoted as
`deferred_reason`). A finding that is still present with no recorded decision is open, never
deferred. New findings are `new`. Report the counts per status at the top of the report,
and show each scorecard line beside its previous value.

## The report

Two artifacts: `.metaobjects/adoption-audit.json` and the rendered Markdown.

**Markdown sections, Scorecard first:** 0. Scorecard (tier, pillar table, CI gate, used as
described; on a re-run, the fixed / open / deferred / new counts) · 1. Triage and census
(including the owned-generator unmodified-lines total and the shape coverage census) ·
2. Coverage matrix · 3. Per-surface classification tables · 4. Drift findings (active bugs
first) · 5. Owned generators and generator gaps · 6. Drift-gate adoption ·
7. Runtime-contract and authoring-correctness (axes G and H) · 8. Constraint ratification ·
9. Prompt-pillar assessment · 10. Prioritized roadmap: Tier 1 drift kill → Tier 2 existing
generators → Tier 3 new generators and projections → Tier 4 dynamic runtime, prompts,
cross-port. Each roadmap item: lines retired, prerequisite, and the parity gate to pass
before hand-written code is deleted.

**Each finding in `.metaobjects/adoption-audit.json`:**

| Field | Content |
|---|---|
| `id` | stable kebab id (e.g. `handwritten-crud-route`, `manual-zod-validator`, `enum-literal-spelling`, `unguarded-status-transition`, `owned-generator-stale`) |
| `title` | "you hand-wrote X that metadata can generate / model" |
| `pillar` | `codegen` / `runtime` / `drift` / `prompt` |
| `surface` | `entity` / `route` / `validator` / `repository` / `dto` / `hooks` / `prompt` / `migration` |
| `capability` | the capability-checklist capability this maps to (e.g. `field.currency`, `relationship.@through`) |
| `locations[]` | exact `file:line` spans |
| `impact` | LOC eliminated + N call-sites + drift-risk (high/med/low) |
| `effort` | `trivial` / `small` / `medium` / `large` |
| `confidence` | bias to under-flagging (false-positive rate >15% is a kill criterion) |
| `metadata_sketch` | metadata you'd author to replace it — **read-only proposal only; never applied** |
| `next_command` | the exact command / skill that performs the cutover (see bridge below) |
| `parity_gate` | the specific check proving behavior-equivalence |
| `tier` | 1–4 |
| `status` | `new` / `open` / `fixed` / `deferred` against the previous audit (`new` on a first run) |
| `first_seen` | date of the audit that first raised it (carried forward on re-runs) |
| `deferred_reason` | for `deferred` only: the recorded decision, quoted, and where it is recorded |

Fixed findings stay in the file with `status: fixed` for one run, so the next reader sees
what closed.

**Top-level fields**, beside `findings[]`:

| Field | Content |
|---|---|
| `audited_at`, `commit` | when the audit ran and the commit it read |
| `previous` | `audited_at` and `commit` of the baseline audit, or `null` on a first run |
| `tier`, `pillars[]` | headline tier and `{ pillar, tier, top_gap }` per pillar |
| `ci_gate` | `{ score: "BLOCKING" \| "RUNS_BUT_DOES_NOT_BLOCK" \| "ABSENT", exit_code, error_count, swallowed_at[], deploy_paths_skipping[] }` |
| `used_as_described` | `{ band, generated_consumed, generated_emitted, bypassed_count, gate_score, payload_fields_linked, payload_fields_unlinked, shape_statements_generated_or_derived, shape_statements_total, unmodelled_shapes[] }` |
| `owned_generators` | `{ unmodified_lines, total_lines, copies[] }`, one total across every port |
| `status_counts` | `{ new, open, fixed, deferred }` |

Within each tier, sort by impact ÷ effort (quick wins first). Tier 1 leads.

### From audit to action

The audit never edits code. The pattern for whoever acts on it is dry-run → review the diff →
apply, one surface at a time, one commit each.

- Propose metadata → `metaobjects-authoring`, with a human reviewing.
- Generate → `meta gen`; `meta gen --dry-run` is the review-the-diff step → `metaobjects-codegen`.
- Prove parity → `meta verify --codegen` is the drift gate → `metaobjects-verify`.
- Routes, runtime, web → `metaobjects-runtime-ui`.
- Prompts → `metaobjects-prompts`.

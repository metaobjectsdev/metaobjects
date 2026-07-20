# Advanced modeling series — rollout plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development or
> superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Design spec:** `docs/superpowers/specs/2026-07-19-advanced-modeling-series-design.md`

## STATUS — how to resume (updated 2026-07-20)

**Unit 1 (the canonical spine) is DONE.** Design + plan are approved and committed. Full detail:
`.superpowers/sdd/unit1-report.md`.

- ✅ Design spec written, reviewed, and **reconciled against the adjacent artifacts** (conformance
  corpora, the public reference application) — see the design's "four tiers" section. The reconciliation
  concluded the spine is justified and must be authored fresh, NOT derived: the corpora refuse the
  teaching job by contract, and the reference app covers only 2 of the 4 patterns (it has array-of-VO
  jsonb + prompt payloads, but **zero** projections and **zero** view/form/currency vocabulary).
- ✅ Maintainer decisions locked: `examples/` top-level · fast-lane drift gate inside a package suite ·
  **YAML** authoring · the public reference app may be named/linked.
- ✅ **Unit 1 built** — `examples/advanced-modeling/` (metadata + committed `src/generated/**` + README
  pattern index) + the drift gate (`server/typescript/packages/cli/test/integration/advanced-modeling-drift.test.ts`,
  joins the `cli` package's existing `bun test` suite → `ci-local.sh`'s `gate_conf_ts` / `ts-fast` lane).
  Recon (Step 1) surfaced 5 real gaps only once the full `meta gen` → `meta verify` pipeline actually ran
  (a stale doc claim + 4 codegen/CLI bugs, all fixed narrowly with existing-suite coverage staying green) —
  see the report's "What did not match reality" section and the example's own README "Gotchas".
- ⬜ **NEXT: Unit 2** (four developer deep-dives under `docs/features/advanced/`) — depends on Unit 1
  (done). See the "Unit 2 — developer deep-dives (SKETCH)" section below; every code block must quote
  the Unit 1 spine, never a hand-written parallel snippet.

**Context a fresh session needs:** the four patterns and the domain rationale are in the design spec;
the tier discipline + anti-drift rule are binding on every unit; the drift gate is a freshness /
CLI-composition smoke check and must never be described as a correctness gate.

**Goal:** Teach the four advanced modeling patterns (projections, entity views, value-objects-as-jsonb,
value-objects-as-LLM-payloads) from a single canonical worked example, and derive the developer
deep-dives, agent-context decision rules, and technical video scripts from that one spine.

**Architecture:** Hybrid, spine-first. Unit 1 builds the spine (`examples/advanced-modeling/`);
Units 2–4 derive surfaces from it. The spine is metadata + committed generated output + a drift
gate — **not** a runnable app.

## Global constraints

- **PUBLIC repo** — no **private** project/consumer names and no absolute home paths in any committed
  file. Note: the public reference application
  ([Draagon/wizardsofodd](https://github.com/Draagon/wizardsofodd), verified `isPrivate: false`) **may
  be named and linked** — it is already cited in committed `spec/roadmap.md`. Private adopters and
  internal project names remain forbidden. The example domain is generic (`acme::learn`).
- **Authoring format is YAML** (ADR-0006 sigil-free authoring surface), not canonical JSON — a
  teaching artifact must show what a human/agent actually authors.
- **Document what ships.** If the series needs vocabulary that does not exist, STOP and log an issue —
  do not invent metamodel attributes (ADR-0023).
- **Named constants / real syntax.** Every metadata snippet must actually load; the drift gate proves it.
- **No basics re-teaching.** Assume entities/fields/CRUD; link out.
- **Deep-dive code blocks quote the spine** — never hand-written parallel snippets.

## Unit order and dependencies

| Unit | What | Depends on |
|---|---|---|
| **1** | The canonical spine + drift gate | — |
| **2** | Four developer deep-dives | 1 |
| **3** | Agent-context decision rules | 1 (2 helps) |
| **4** | Technical video scripts + storyboards | 1, 2 |

Units 3 and 4 may run in parallel once 2 lands.

---

## Unit 1 — the canonical spine (DETAILED)

**Outcome:** `examples/advanced-modeling/` holds a course/program publishing model that exercises all
four patterns, with committed generated output and a CI gate proving `meta gen` reproduces it.

**Files:** (YAML authoring per the global constraint above)
- Create `examples/advanced-modeling/metaobjects/meta.catalog.yaml` — `Program`, `Purchase`, `ProgramSummary`.
- Create `examples/advanced-modeling/metaobjects/meta.content.yaml` — `Lesson`, syllabus value-objects.
- Create `examples/advanced-modeling/metaobjects/meta.prompts.yaml` — the payload VO + `template.output`.
- Create `examples/advanced-modeling/metaobjects.config.ts` — generator wiring (entity/queries/routes/form/barrel).
- Create `examples/advanced-modeling/.metaobjects/config.json`.
- Create `examples/advanced-modeling/README.md` — what each file demonstrates + how to regenerate.
- Create `examples/advanced-modeling/src/generated/**` — committed output.
- Wire the drift gate (see Step 6).

- [x] **Step 1: Recon the authoring surface before writing metadata.**
  Read `fixtures/conformance/` entries for the four patterns plus `docs/features/source-kinds.md`
  and `docs/features/templates-and-payloads.md` to confirm exact current syntax (`origin.*` attrs,
  `@storage: jsonb`, `template.output` attrs, `view.*` names). Do NOT write metadata from memory —
  the 0.19.0 line changed the view-attr home (`metaobjects-ui-web`). Record the confirmed syntax in
  the task report.

- [x] **Step 2: Author the catalog model (`meta.catalog.json`).**
  `Program` (entity): `id`, `title` (`view.textarea @rows`), `status` (`field.enum` → select),
  `priceCents` (`field.currency` + `view.currency`), `coverKey` (`field.string` + `view.image` with
  `@aspectRatio`/`@maxEdge`/`@store`/`@accept`/`@maxBytes`), `authorId`. `Purchase` (entity) with a
  relationship to `Program`. This covers **pattern 2 (entity views)** end to end.

- [x] **Step 3: Author the projection (`ProgramSummary` in `meta.catalog.json`).**
  `object.projection` over `Program` with `source.rdb @kind: view`, demonstrating **all** the
  origin kinds the series teaches: `origin.passthrough` (author name from a related entity),
  `origin.aggregate @agg: count` (lesson count), `origin.aggregate @agg: sum` + `@filter` (revenue
  from completed purchases only), and one `origin.computed @expr`. Include `identity.primary`
  extending the base entity identity. This covers **pattern 1**.

- [x] **Step 4: Author the jsonb value-objects (`meta.content.json`).**
  A `SyllabusSection` `object.value` (no identity, no source — purity per ADR-0028) referenced from
  `Program.syllabus` as `field.object @objectRef @storage: jsonb @isArray: true`, plus a single
  (non-array) `Instructor` profile VO on `Program`. This covers **pattern 3**, including the
  array-of-VO codec.

- [x] **Step 5: Author the LLM payload (`meta.prompts.json`).**
  A payload `object.value` projecting the subset of `Program` a description prompt actually needs,
  plus a `template.output` declaring the prompt (kind/payloadRef/textRef/format and the output
  contract). This covers **pattern 4** and demonstrates the payload-bloat-is-a-diff property.

- [x] **Step 6: Generate, commit output, and add the drift gate.**
  Run the CLI against the example (`meta gen`) and commit `src/generated/**`. Then wire a gate that
  regenerates and fails on any diff. **Follow the existing pattern** — inspect how the repo's current
  golden/drift gates are wired (`server/typescript/packages/codegen-ts/test/golden/`,
  `scripts/ci-local.sh`, `scripts/ci-affected-ports.sh`) and match it rather than inventing a new
  mechanism. Ensure the example is EXCLUDED from the Bun workspace globs if inclusion would pull it
  into package test runs.

- [x] **Step 7: Verify.**
  `meta gen` is idempotent (second run → no diff); `meta verify` passes; the generated form renders
  the expected controls (select / textarea with rows / currency / `<ImageUpload>`); the projection
  emits a view; the jsonb VO columns and the payload VO appear in output. Record evidence.

- [x] **Step 8: README + commit.**
  `README.md` maps each pattern → the file and lines that demonstrate it (this is the index the
  deep-dives, agent-context, and video scripts all cite). Commit.

**Size:** the largest unit — one focused session. Metadata authoring is small; the drift-gate wiring
and getting generation genuinely clean are the real work.

---

## Unit 2 — developer deep-dives (SKETCH)

Four decision-first guides under `docs/features/advanced/`, each: *the problem → the decision (and
when NOT to use this) → the spine's model, quoted → the generated result → the gotchas.*

- `projections.md` — projection vs query vs computed field; origin-kind selection; `@via`; read-only propagation.
- `entity-views.md` — the view-kind dispatch table; where presentation attrs live (`metaobjects-ui-web`,
  and why core owns zero view attrs); wire-vs-view divergence (currency minor units, image opaque keys).
- `value-objects-jsonb.md` — VO purity (ADR-0028); `@storage` flattened vs jsonb vs subdocument;
  single vs `@isArray`; what jsonb costs you at query time.
- `llm-payloads.md` — a prompt is code; typed payload projections; deterministic render + cache
  stability; `verify` drift; the output parser.

Cross-link from the existing scattered reference pages so the current docs funnel into these.

## Unit 3 — agent-context decision rules (SKETCH)

Decision rules (situation → pattern → spine slice to imitate), not prose, wired into the
`agent-context/` skills + llms surfaces. Targets the real failure mode: agents don't recognise the
trigger conditions. Must stay version-agnostic (no hardcoded versions). Verify against
`agent-context-conformance` before landing.

## Unit 4 — technical video scripts + storyboards (SKETCH)

One script per pattern (+ one "how they compose" capstone), derived from the spine so every demo is
real generated output. Technical register, not exec-level. **Scripts and storyboards only** —
production is out of scope. Delivered as markdown alongside the deep-dives.

---

## Resolved decisions (previously open)

- **`examples/` IS a new top-level directory.** Confirmed with the maintainer. Unit 1 Step 6 must
  still verify the example does not get pulled into the Bun workspace globs or the port CI lanes.
- **The drift gate joins the FAST lane, wired inside an existing package suite** (rather than as a
  standalone CI job) — cheap, catches breakage early, and reuses the established gate mechanism
  instead of inventing a new one.

## Tier discipline (from the design spec — enforce while building)

This series is the **pedagogical** tier. When a task here uncovers something:
- a **behavior** gap → it becomes a `fixtures/*-conformance/` entry, NOT an assertion in the example;
- a **teaching** gap → answer it in the example/deep-dive;
- a **missing pattern** → never add it to the frozen reference application for doc convenience.

The drift gate is a freshness + CLI-composition smoke check, **not** a correctness gate — the corpora
and golden tests own correctness. Do not describe it otherwise in any artifact this plan produces.

# Advanced modeling series — design

**Status:** proposed
**Date:** 2026-07-19

## Problem

MetaObjects documents its advanced modeling patterns as **scattered reference**: projections live
across `entities.md` / `source-kinds.md` / `relationships.md`, value-object jsonb storage across
`field-types.md` / `templates-and-payloads.md`, prompt payloads in `templates-and-payloads.md`, view
controls across `entities.md` / `field-types.md` / `image-upload.md`. Each page answers *"what is
this attribute?"*. None answers the question adopters and their coding agents actually get stuck on:

> *"I have this problem — which pattern do I reach for, and how do these patterns fit together?"*

The four patterns in scope are also the four where a wrong call is expensive to unwind:

1. **Projections** — `object.projection`, `source.rdb @kind: view`, the `origin.*` family
   (`passthrough`, `aggregate` incl. `@agg` + `@filter`, `computed @expr`, `first`), `@via`.
2. **Entity views** — the `view.*` control family driving generated forms (enum→select,
   `view.textarea @rows`, checkbox/radio, currency, `view.image`), plus `layout.dataGrid`.
3. **Value objects as jsonb columns** — `object.value` + `field.object @storage: jsonb`
   (single and `@isArray`), and the typed write/read codec.
4. **Value objects as LLM prompt payloads** — `template.output`, payload-VO projections,
   deterministic render, `verify` drift-checking, and the tolerant output parser.

## Decision 1 — architecture: hybrid, spine-first

Four audiences are in scope (adopting developers, coding agents, a dogfooded reference, and
prospects/GTM). Evaluated three shapes:

- **Canonical worked-example spine only** — coherent and demoable, but leaves the "how do I decide?"
  teaching implicit.
- **Four independent topic guides** — ships incrementally, but four disconnected toy examples teach
  the patterns in isolation, which is exactly the current failure mode, and gives GTM/dogfood nothing.
- **Hybrid (chosen)** — one canonical worked example as the spine, then per-topic deep-dives that
  zoom into slices of it.

**Chosen: hybrid, built spine-first.** The spine is the only artifact that serves dogfood, GTM, and
agent-context fixtures *simultaneously*, and it is what lets a deep-dive say "here is this pattern
**in a system that also has the other three**" — the interaction is the part that is currently
untaught. The deep-dives then cost far less to write because they cite a model that already exists.

## Decision 2 — domain: a course/program publishing platform

The domain must naturally require money, derived read-models, structured jsonb, images, and a
document/LLM surface — without inventing a new mental model for the reader.

**Chosen: a course/program publishing platform** (package root `acme::learn`). This is not a new
invention: `CLAUDE.md`'s file-organization guidance already uses Program / Purchase /
ProgramSummary / Subscriber / Video / Week, and `ProgramSummary` is already the repo's canonical
projection example. Reusing it means the series extends the vocabulary readers have already met.

The domain earns each pattern honestly:

| Pattern | How the domain requires it |
|---|---|
| Projections | `ProgramSummary` — lesson counts, enrollment counts, revenue sums (`@agg` + `@filter`), passthrough of the author's name |
| Entity views | `Program` authoring form — currency price, enum status, textarea summary, `view.image` cover art |
| VO as jsonb | `Program.syllabus` — an `@isArray` array of section value-objects; a single `Instructor` profile VO |
| VO as LLM payload | Generating a marketing description / lesson summary from a typed payload projection over `Program` |

Money and images are not decoration: `field.currency` and `view.image` are where the view layer and
the wire contract visibly diverge (minor units on the wire, an opaque storage key for images), which
is a teaching point the deep-dives need.

## Decision 3 — the spine's weight: metadata + committed output + a drift gate

The example is **authored metadata + a `metaobjects.config.ts` + committed generated output**,
verified by a `meta gen` → *no diff* drift gate. It is **not** a runnable application.

Rationale: a live app buys demo polish at the cost of a permanent maintenance tax (dependencies, a
server, its own CI lane) and would rot between releases. Metadata + committed output still delivers
what matters — it gives docs/agent-context/videos a real, current artifact to cite — at a fraction
of the upkeep.

**What the drift gate is and is not.** It is NOT a correctness gate for the four patterns: the
persistence/render conformance corpora and the codegen golden tests already gate that behavior, and
duplicating it here would violate the anti-drift rule below. Its honest value is narrower and still
worth having:

1. **Teaching-artifact freshness** — the committed output stops the docs from quoting a model that
   no longer generates, which is the failure mode that kills example-based documentation.
2. **CLI-path composition smoke** — it exercises the four patterns *together* through the real
   `meta gen` CLI path, which no existing gate does (the corpora are atomized by contract).

Claim it as exactly that. Do not market it as a regression gate.

## Decision 4 — authoring format: YAML

The spine's metadata is authored in **YAML**, not canonical JSON. Per ADR-0006, YAML is the
sigil-free authoring front-end and canonical JSON is the on-disk interchange format — a teaching
artifact must show the surface a human (or an agent) actually authors. This also matches the public
reference application's authoring style, so a reader moving between them sees one idiom.

## Where this sits — four tiers, and the rule that keeps them apart

The repo already has artifacts that look adjacent to this series. They are not interchangeable; each
tier refuses the others' jobs, and that refusal is load-bearing.

| Tier | Artifact | Job |
|---|---|---|
| **Normative** | `fixtures/*-conformance/` | Define behavior. Minimal, atomized, adversarial, cross-port byte-exact. |
| **Pedagogical** | `examples/advanced-modeling/` (this series) | Show the four patterns *composing* in one consumer-shaped model. |
| **Existential** | [wizardsofodd](https://github.com/Draagon/wizardsofodd) ([wizardsofodd.com](https://wizardsofodd.com)) | Live, deployed adopter proof that the model survives production. |
| **Machine-teaching** | `agent-context/` | Give coding agents the decision rules for reaching for a pattern. |

**Why the spine is not redundant with the other two** (checked, not assumed):

- **The corpora cannot teach.** Atomization is their contract — each fixture isolates one behavior on
  purpose, roughly half are `error-*` cases, they carry canonical JSON rather than the authoring
  surface, and none pairs a config with generated output. `codegen-conformance/README.md` even
  preserves a *rejected* corpus specifically to stop this kind of scope creep.
- **The reference application cannot be the spine.** Its metadata covers two of the four patterns
  (array-of-VO jsonb, prompt payloads) and carries **no projections and no view/form/currency
  vocabulary** — an exact half of the curriculum is absent. It is also feature-frozen and lives in
  another repo, so quoting it in docs invites quote-rot.

**Anti-drift rule — content doing another tier's job MOVES, it never duplicates:**

- A *behavior* gap the spine uncovers becomes a **fixture**, not an assertion in the example.
- A *teaching* gap is answered in the **example**, not by expanding a fixture's scope.
- A *missing pattern* is never added to the frozen reference application to make a doc convenient.

## Derivation model — one spine, four surfaces

```
  examples/advanced-modeling/   (the spine: metadata + generated output + drift gate)
            |
            +--> docs/features/advanced/*.md      deep-dives (adopting developers)
            +--> agent-context decision guidance  "which pattern do I reach for?" (coding agents)
            +--> CI drift gate                    dogfooded regression proof (us)
            +--> video scripts + storyboards      technical demo series (prospects/GTM)
```

Every surface cites the spine rather than inventing its own snippets, so a metamodel change updates
one model and the drift gate catches every doc that drifted from it.

**Per-audience framing:**

- **Adopting developers** — deep-dives are *decision-first*: each opens with the problem and the
  choice ("when is this a projection instead of a query?"), then shows the spine's model, then the
  generated result. The **jsonb** and **LLM-payload** deep-dives additionally link
  [wizardsofodd](https://github.com/Draagon/wizardsofodd) as *production proof* — those are the two
  patterns it actually runs in production (array-of-VO jsonb, deep prompt payloads), so the reader
  gets "here is the pattern, and here it is surviving in a live app." The projection and view
  deep-dives have no such link, because that app does not use those patterns — do not manufacture one.
- **Coding agents** — the agent-context contribution is **decision rules, not more prose**. Agents
  under-use these patterns because they don't recognise the trigger conditions, so the guidance is
  phrased as recognisable situations → the pattern to reach for → the spine slice to imitate.
- **Us** — the drift gate makes the spine a regression test for all four patterns.
- **Prospects/GTM** — technical (not exec-level) video scripts, derived from the spine so demos are
  real output. Scope is **scripts + storyboards only**; production is out of scope here.

## Scope boundaries (YAGNI)

**In scope:** the four patterns above; one canonical spine; four deep-dives; agent-context decision
rules; technical video scripts/storyboards.

**Explicitly out of scope:**

- A runnable/deployed example application, or any hosting.
- Video *production* (recording, editing, publishing) — scripts and storyboards only.
- Exec/business-level video content — that tier already exists and has a different register.
- New metamodel vocabulary. The series **documents what ships**; if it exposes a genuine gap, that
  gap is logged as its own issue, not fixed inside the series.
- Re-teaching basics (entities, fields, CRUD codegen) — the series assumes them and links out.
- Cross-port per-language walkthroughs. Examples are idiomatic to the TypeScript reference; a point
  is only made cross-port where the *metamodel* (not the codegen) is the subject.

## Risks

- **Spine rot.** Mitigated by the drift gate — a metamodel change that breaks the patterns fails CI.
- **Scope creep into a full app.** Mitigated by Decision 3 being explicit and load-bearing.
- **Deep-dives drifting from the spine.** Mitigated by requiring every code block to be a quotation
  of spine files rather than a hand-written snippet.

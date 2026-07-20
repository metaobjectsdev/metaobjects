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
the two things that matter — it **proves the patterns generate correctly** (CI fails if a release
breaks them) and gives docs/agent-context/videos a real artifact to cite — at a fraction of the
upkeep. This also makes the spine a genuine regression gate for the four patterns, which the repo
does not currently have in one place.

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
  generated result.
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

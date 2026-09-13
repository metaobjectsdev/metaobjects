# FR-043 — Feature and non-functional packages

**Status:** design sketch. Targeted post-1.0, as a later version or an adjacent
project (maintainer ruling, 2026-09-13). Not scheduled.
**Date:** 2026-09-13
**Depends on / relates to:** the opt-in codegen catalog
(`2026-09-12-opt-in-codegen-and-generator-catalog-design.md` §9), FR-023
(metadata dependencies), ADR-0034 (scaffold-and-own), the requirements pillar.

## 1. The idea

Ship *packages* an agent can pull into a project: not libraries of code, but
**declared design** — the requirements a capability must satisfy and the model
metadata it needs — which the agent then implements against and adapts.

The value is that it moves an LLM from "invent a design for subscriptions" to
"here is a considered design for subscriptions, with requirements that
`meta verify` will hold you to; adapt it." It accelerates the decision and the
design at once, and it gives the implementation something checkable to be
measured against — which is what the requirements pillar exists for.

Two flavours, by what they are *about*:

- **Feature packages** — about a capability the application HAS. Subscriptions,
  audit trails, LLM call tracing, soft delete. Predominantly metadata and
  functional requirements; cross-language by nature.
- **Non-functional packages** — about a property the application's CONSTRUCTION
  has. "This has an HTTP API tier." "This is drift-gated." These carry a
  generator selection plus the architectural requirements that tier implies;
  necessarily language-specific, because generators are.

## 2. This is not greenfield — one package already ships

`library/ai/llm-call.yaml` is a working instance of most of this, and any design
here must start from it rather than from a blank page.

**What it contains.** An abstract `object.entity` `LlmCallBase` in package
`metaobjects::ai` — eighteen fields modelling one LLM call: `traceId`, `spanId`,
`parentSpanId`, `sessionId`, `callType`, `system`, request/response model,
input/output tokens, `costMinor` as `field.currency`, `latencyMs`,
`finishReason`, `status`, `errorDetail`, `startedAt`, and `llmRequest` /
`llmResponse` as jsonb. Plus a concrete `LlmCall` extending it with a
`source.rdb` table and an `identity.primary`. That is exactly "the DB model for
the audit records", authored once and shipped.

**How an adopter opts in.** The loader's `libraries` option, by name, defaulting
to none: `libraries: ["ai"]` in `metaobjects.config.ts`, `libraries: [ai]` in the
Python/CLI config, `LoaderConfigurationBuilder.libraries([...])` on the JVM. The
nodes then resolve for `extends: "metaobjects::ai::LlmCallBase"`.

**How it reaches every port.** `library/` at the repo root is the source of
truth; each port carries a generated embedded copy — TS
`embedded-library.generated.ts`, Java `EmbeddedLibrary.java`, Python
`embedded_library.py` — and `ci-local.sh`'s `embedded-library drift` gate
regenerates and `git diff --exit-code`s it. TS resolves on-disk-first in a dev
layout and falls back to the embedded string when compiled.

**And it already carries codegen and runtime.** `trace-helper` emits a typed
`record<Entity>` per concrete entity that extends `LlmCallBase` *and* nests a
`template.prompt` with `@payloadRef`/`@responseRef`; it persists the base
envelope plus typed VO columns. The VO *shape* comes from the adopter's own
prompt declaration, not from the library — the library supplies the envelope.
Runtime support sits alongside (`buildLlmCallRow`; OMDB's `ai` package on the
JVM). It ships on TypeScript, Java and Python.

**Adding a second MetaObjects-authored library is already nearly free.** The TS
resolver derives its package set from the embedded module's keys precisely "so
adding a library file needs no edit here."

## 3. What the shipped instance proves, and the five things it lacks

Proven: cross-port authored-once metadata, opt-in by name with a default of
none, a drift gate keeping five ports honest, and a generator keyed to the
package's own shapes. The hard parts are done.

Missing, and this is the FR:

1. **Only MetaObjects can author one.** The mechanism reads this repo's
   `library/` tree and embeds it into the ports at build time. An adopter or a
   third party cannot publish a package.
2. **No requirements.** `library/ai` is entities only. The component that makes
   a package *design* rather than *schema* — `requirement.functional` /
   `requirement.architectural`, resolved-not-trusted via `@implementedBy` — is
   absent, and it is the reason to build this at all.
3. **No discovery.** Nothing lists what libraries exist. An agent cannot find
   `ai` without being told; `meta gen --list` enumerates generators, not
   packages.
4. **No copy-and-own.** A library can be extended and overlaid but not taken
   over. "Pull it in and modify it if you need to" has no mechanism.
5. **The coupling between a package and its generator is hard-coded.**
   `trace-helper` carries `const LLM_CALL_BASE = "LlmCallBase"` and matches on
   that name. A package should *declare* the generators it implies; a generator
   should not name a library's entity in its own source.

## 4. The corrected model: components, not disjoint kinds

The shipped instance falsifies a clean "feature packages have no code, NFR
packages do" split — `ai` is a feature package (tracing is a capability the app
has) that nonetheless ships a generator and runtime helpers. So a package is a
set of **components**, any subset of which may be present:

| component | cross-language | in `ai` today |
|---|---|---|
| model metadata | yes | ✅ `LlmCallBase`, `LlmCall` |
| requirements | yes | ❌ — the new part |
| generator selection | no, per-port | ✅ `trace-helper` (TS/Java/Python) |
| runtime helpers | no, per-port | ✅ `buildLlmCallRow`, OMDB `ai` |

Feature-vs-non-functional survives as **what the package is about**, and as a
strong tendency about which components appear — not as a structural constraint.
A feature package usually stops at metadata and requirements. A non-functional
package always reaches generators.

## 5. Mechanism: embed by default, eject to own

Three mechanisms now exist in this codebase and they are genuinely different.
Choosing correctly matters more than any other decision here:

| | semantics | right for |
|---|---|---|
| `libraries: [...]` | embedded, opt-in, not copied, drift-gated | using a package as authored |
| FR-023 `dependencies` | sync-and-pin: hash-locked, deliberately excluded from your codegen and ledger | sharing a model you do NOT own |
| `meta eject` (ADR-0034) | copy-and-own: it becomes your source, yours to edit | adapting something to your project |

FR-023 is the wrong fit and should not be stretched to cover this: a package's
requirements belong **in** your ledger — that is the point of pulling it in — and
its content is meant to be modified, which is the opposite of hash-pinned.

**Proposal: a package is used embedded, and ejected when you need to change it.**
That is `library` + ADR-0034 composed, and it is the pattern already proven for
generator templates: use the reference as shipped, `eject` when you want to own
it, with drift reported against the reference afterwards. The default stays the
cheap path; ownership stays available without a fork.

## 6. Relationship to the codegen catalog

The catalog design (`…-opt-in-codegen-and-generator-catalog-design.md`) reserves
exactly one thing for this: a catalog entry gains a `kind`, today always
`"generator"`. A package is a later `kind` in the same catalog, discovered by the
same `meta gen --list --format json`, referenced by the same ADR-0021 stable
names, with the same `requires` edges extended from generator→generator to
package→package. That closes gap 3 with no second system, and gap 5 by letting a
package declare `generators: ["trace-helper"]` instead of a generator naming a
library's entity in its source.

Nothing in that spec is built speculatively for this. The `kind` field is one
string.

## 7. Sketch of the work, in dependency order

1. **Requirements in a library.** Let `library/<pkg>/` carry `requirement.*`
   nodes, and settle whether an opted-in package's requirements enter the
   consumer's ledger by default (proposed: yes — that is the point) and how
   `@implementedBy` resolves across the boundary.
2. **Declared coupling.** A package manifest naming the generators and runtime
   packages it implies; `trace-helper`'s hard-coded `LlmCallBase` retired in
   favour of it.
3. **Catalog `kind`.** Packages appear in `--list`, with `--probe` reporting
   what a package would contribute to *this* model.
4. **Eject a package.** Copy-and-own for metadata, with drift reported against
   the shipped reference.
5. **Third-party authoring and distribution.** The largest piece, and the one
   that makes it a market surface rather than an internal accelerator. It
   should ride FR-023's deferred `npm`/`python` transports rather than inventing
   a parallel one.

## 8. Open questions

- **Does an opted-in package's requirements ledger become yours?** Proposed yes.
  It changes what `meta verify` reports on day one after opting in, which is
  either the feature or an ambush depending on how it is introduced.
- **What happens when a package is ejected and then the shipped one moves?**
  `eject --list` already has a staleness report for generator templates; the
  same shape probably works, but metadata drift is harder to summarise than a
  file hash.
- **Is `library/` the right home for third-party packages**, or does an
  adopter-authored package live somewhere else entirely and `library/` stay the
  MetaObjects-authored set?
- **How many packages justify the machinery?** One ships today. The honest
  trigger for building this is a second and third that a real project wanted,
  not a general mechanism built ahead of its users.

## 9. Why this is deferred

The transport is nearly free and the authoring is not. What nobody knows yet is
whether a well-written requirements set for a capability actually accelerates an
LLM or is prose it skims — and the project's own evidence on requirements says
the value came from executability, at n=1.

FR-041 is the instrument that can answer it: a package is precisely a
"more declared metadata" intervention, and measuring it needs the baseline that
benchmark has not yet produced. Building it first spends the measurement that
would justify it.

The maintainer's ruling (2026-09-13) is that this is a market-facing capability
worth having, delivered in a later version or as an adjacent project rather than
folded into the 1.0.x line.

# ADR-0025: Unified docs door — one command, two surfaces, one config

**Status:** Accepted
**Date:** 2026-06-06
**Extended by:** ADR-0027 (polyglot docs composition — the single api surface generalizes to a per-language `apiSurfaces[]` list)
**Extends:** ADR-0021 D1 (single docs door — now covers ALL docs, not just neutral)
**Revises:** ADR-0022 Part 3 (api-docs is the *api surface* of the docs door, not a
standalone `meta gen` generator)
**Relates to:** ADR-0020 (codegen tiering: Tier-1 per-port vs Tier-2 shared)

> This ADR does NOT rewrite ADR-0021 or ADR-0022. It refines one boundary they
> drew: documentation is unified behind a single command door with multiple
> surfaces. The tiering decision (ADR-0020) and the broader codegen + docs
> surface architecture (ADR-0022) stand; this ADR states how docs are *invoked,
> configured, and cross-linked*.

## Context

Two documentation producers grew up under two different models:

- **Neutral model docs** (entities, fields, constraints, identities, relationships,
  `template.output` contracts incl. the linked template-source section) were a
  **command** — `meta docs` — reached through the single docs door (ADR-0021 D1),
  language-neutral, one shared TS engine (Tier-2, ADR-0020).
- **The SDK/API reference** (the concrete symbols the codegen produced for *this*
  project, in the target language) was a **generator** — `apiDocsFile()` in
  `metaobjects.config.ts`, run via `meta gen` (ADR-0022 Part 3), per-port (Tier-1).

Two producer models meant two output configs and friction cross-linking the two
doc trees — and the asymmetry only worsens as the api surface fans out per port.
The right fix is to unify the *user-facing layer* (one door, one config block,
cross-links) while keeping the tiered engines underneath: the Tier-1/Tier-2 split
does not disappear, it moves *inside* the docs subsystem as two **surfaces**.

## Decision

**Documentation is ONE subsystem behind ONE per-port command door, ONE `docs:`
config block, producing N cross-linked surfaces in ONE output tree.**

### D1 — One door, per-port command

The docs door is a command on each port's existing CLI, exactly like
`gen` / `verify` / `agent-docs`:

- `meta docs` (TypeScript), and — as the api surface fans out — its per-port
  siblings `dotnet meta docs` (C#), `metaobjects docs` (Python),
  `metaobjects:docs` Maven goal (Java/Kotlin).

The **command (door) is per-port**. Underneath, the engines are tiered:

- The **model engine stays singular and shared** (Tier-2). Each port
  *invokes/embeds* the one shared engine; it is NOT reimplemented per language.
  Its output is language-independent and byte-identical across ports.
- The **api engine is per-port** (Tier-1), because it documents what *that* port's
  codegen produced and must be idiomatic in the target language (accurate by
  construction — it reuses the real generators' naming/signature logic).

### D2 — Two surfaces in one output tree

From the one `docs:` config, the door emits one or more **surfaces** under one
`outDir`:

- **`model` surface** (Tier-2 shared engine — today's `docsFile()`): metadata-alone
  capable, language-independent. Pages: `<outDir>/<Entity>.md`,
  `<outDir>/<Template>.md`.
- **`api` surface** (Tier-1 per-port — today's `apiDocsFile()`): the SDK/API
  reference. Pages: `<outDir>/api/<Entity>.md`, `<outDir>/api/README.md`,
  `<outDir>/api/AGENT-API.md` (the condensed agent-facing API reference).

A single unified landing index `<outDir>/README.md` links the model pages and an
"API reference" section linking the api pages.

The model surface emits ALWAYS (it needs only metadata). The api surface emits
when the gen config / generators are present and `api` is in the resolved
surfaces; with no config it is skipped with a friendly note.

### D3 — Cross-links between surfaces (the payoff)

The two surfaces are cross-linked in the one output tree:

- each **model** entity/template page links to its **api** page;
- each **api** entity page links back to its **model** page; template render
  helpers link back to the template's model page;
- the unified `<outDir>/README.md` cross-references both surfaces.

All hrefs are computed via the `docPageHref` / `docs-paths` semantics both surfaces
already share (with the api `subDir` folded in), so links resolve in both `flat`
and `package` layouts. Cross-link integrity is conformance-gated in both
directions and both layouts.

### D4 — api-docs demoted from the gen surface (mirrors `docsFile()`)

Consistent with how `docsFile()` was deprecated from the `meta gen` config surface
(ADR-0021 D1):

- `apiDocsFile()` remains an exported engine but is `@deprecated` for `meta gen`
  config use — it becomes the INTERNAL engine of the docs door's api surface,
  exactly as `docsFile()` is the internal engine of the model surface.
- A `meta gen` config still listing `apiDocsFile()` (or `docsFile()`) in its
  `generators` array is **warned and skipped** (no divergent second output path).
- The `meta init` scaffold no longer lists `apiDocsFile()` in `generators`; it
  emits a `docs:` config block instead. `meta docs` is the door.

### D5 — The cross-port contract

Built in TypeScript now (the only port where both surfaces exist). The following
are the **cross-port contract** for the eventual fan-out:

- the `docs:` config schema (`outDir`, `layout`, `baseUrl`, `surfaces`); per-surface
  option sub-blocks (e.g. `api`) are a reserved future slot, not yet in the type;
- the surface names (`model`, `api`);
- the output-tree layout (`<outDir>/` model + `<outDir>/api/` api + unified
  `README.md`);
- the cross-link path contract (via the shared `docs-paths` semantics).

Each port will expose a `docs` command emitting its api surface natively (Tier-1)
and the model surface via the ONE shared engine (Tier-2); the model surface output
is byte-identical cross-port and conformance-gated (as agent-context / generator
registry already are).

## Deferred decision (recorded)

**How a non-TS port reaches the shared model engine is NOT decided here** — it is
the key open item for the api-surface fan-out:

- **(a)** embed a compiled model-docs binary in each port (precedent: the
  `bun --compile` template/migrate binaries), or
- **(b)** invoke the TS CLI as a build tool, or
- **(c)** a thin port-native model-page emitter driving the shared canonical
  `templates/docs/`, guarded by a byte-identity gate (precedent: per-port codegen
  over shared neutral templates).

To be decided when the api surface fans out, not in this effort.

## Consequences

- Adopters get one docs config and one output tree; cross-linking model ↔ api is
  trivial and gated, not hand-maintained.
- The Tier-1/Tier-2 split (ADR-0020) is preserved — it lives *inside* the docs
  subsystem as the api vs. model surface, instead of being exposed as two separate
  producer models (a command vs. a generator).
- ADR-0021 D1's "single docs door" now covers ALL documentation, not just neutral
  metadata docs.
- ADR-0022 Part 3's `api-docs` is reframed as the **api surface of the docs door**,
  not a standalone `meta gen` generator — resolving the two-producer asymmetry it
  left open.
- The non-TS model-engine-reach decision is explicitly deferred, so the fan-out is
  sequenced rather than prejudged.

## Alternatives considered

- **Keep two producer models (status quo): a `meta docs` command + an
  `apiDocsFile()` generator.** Rejected: two output configs and brittle
  hand-maintained cross-links; the asymmetry compounds as the api surface fans out
  per port.
- **Collapse everything into `meta gen` generators (api-docs *and* model docs).**
  Rejected: model docs are Tier-2 neutral and must not ride the per-port Tier-1
  gen pipeline (the divergent-context risk ADR-0021 D1 closed). It would also
  re-open the D1 single-door decision.
- **Reimplement the model docs engine per port** so each port's `docs` command is
  fully native. Rejected: the Tier-2 trap (ADR-0020) — N× maintenance for
  language-neutral output; the model engine stays singular and shared.

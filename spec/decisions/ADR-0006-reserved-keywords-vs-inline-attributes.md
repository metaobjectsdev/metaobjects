# ADR-0006 — Metadata keys are bare: a closed reserved-keyword set + open inline attributes (no sigil)

**Status:** Proposed (2026-05-23)

## Context

A metadata node body mixes two kinds of keys: a small **closed** set of reserved structural
keywords (`name`, `package`, `extends`, `abstract`, `overlay`, `isArray`, `children`, `value`)
and an **open** set of inline attributes (`schema`, `objectRef`, `maxLength`, `payloadRef`, …).
The original design distinguished them with an `@` sigil on attributes (`@schema`), reserved
words bare.

Two problems killed the sigil:

1. **`@` is hostile to YAML.** `@` is a YAML reserved indicator, so `@schema:` can't be a plain
   key — every attribute would need quoting (`"@schema":`). Across the attribute-heavy source-v2
   and persistence designs that's relentless. (The incident that surfaced this: `@isArray`, a
   reserved word wrongly given the attr sigil.)
2. **The sigil is redundant.** The reserved keyword set is **closed and known to the loader**, so
   a bare key can *always* be classified — reserved vs attribute — without any marker. The `@`
   conveys no information the reserved-set membership doesn't already give the parser, any
   cross-language tool, or a human who knows the set. Once bare keys are accepted, `@` is pure
   ceremony.

Prior art: Kubernetes, Docker Compose, and GitHub Actions YAML all use **bare keys + a known
schema, no sigil** — the dominant pattern for schema-backed config.

## Decision

1. **Metadata keys are bare. There is no `@` sigil.** Identical in JSON and YAML.
2. **Reserved structural keywords are a closed, fixed set:** `name`, `package`, `extends`,
   `abstract`, `overlay`, `isArray`, `children`, `value`. (Canonical key order in
   `spec/wire-format.md`. Growing the set is an ADR-level change.)
3. **Any other bare key is an inline attribute.** Classification is reserved-set membership; the
   per-(type,subType) `AttrSchema` (ADR-0004) still types/validates declared attributes.
4. **An `@`-prefixed key is rejected** (`ERR_AT_PREFIX_KEY`): "metadata keys are bare; `@x` is not
   valid — write `x`." This catches legacy `@attr` authoring and the `@isArray`-style mistake.
5. **Arrays** are the bare reserved `isArray` (JSON) or the YAML `[]` key-suffix sugar
   (`field.object[]:` → `isArray: true`) — never a sigiled key.

## Consequences

- **Metamodel-wide `@`-purge migration** (mechanical but pervasive, all four ports):
  - Parsers classify a bare non-reserved key as an attribute (replacing the `@`-prefix loop) and
    reject `@`-prefixed keys.
  - Serializers emit attributes bare.
  - Every `expected.json` in the shared corpus is regenerated (all currently carry `@`).
  - All input fixtures, spec docs, and CLAUDE.md examples drop `@`.
- **The model simplifies:** no sigil, no `@<reserved>` footgun, no special reserved-attr error
  beyond the blanket "no `@` prefix" rule. JSON and YAML become the same (no YAML quoting).
- **An attribute cannot be named a reserved word** (it would *be* the reserved key) — the same
  constraint the old `@<reserved>`-ban imposed, now structural.
- **The canonical/wire form loses the explicit attribute marker.** Consumers rely on the closed,
  known reserved set (which every port already has). Judged an acceptable, marginal loss.
- **Back-compat:** documents using `@attr` stop loading (rejected). Intended — the corpus is
  migrated, and the metamodel is pre-1.0.

## Alternatives considered

- **Keep `@` on attributes (original).** Clean in JSON, hostile in YAML, and — once bare keys are
  accepted — redundant ceremony. Rejected.
- **Keep `@` in JSON, bare in YAML (per-format).** Inconsistent across the two renderings of one
  structure for no gain. Rejected.
- **Keep `@` everywhere but also accept bare.** The half-measure that exposed the redundancy:
  if bare works, `@` is strippable, so just strip it. Rejected in favor of fully purging.
- **`_`-prefix on reserved words (bare attrs).** YAML-safe and keeps a visual cue, but it marks
  the *frequent* set (`name`/`children` on every node) and uglifies the canonical form. Rejected.

## Realization status

- **Spec:** `spec/wire-format.md` updated to bare keys.
- **TypeScript / Python / C# / Java:** _pending_ — the `@`-purge rides the source-v2 rollout
  (shared corpus + TS reference first), since both touch the parser/serializer + the whole corpus.

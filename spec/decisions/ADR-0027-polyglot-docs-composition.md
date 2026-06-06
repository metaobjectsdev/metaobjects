# ADR-0027: Polyglot docs composition — per-language api surfaces, model once

**Status:** Accepted
**Date:** 2026-06-06
**Extends:** ADR-0025 (unified docs door) — generalizes its single api surface to a
per-language list so a polyglot solution gets one cross-linked doc tree.
**Relates to:** ADR-0020 (Tier-1 per-port vs Tier-2 shared).

> This is **SP-1** of a two-part program. SP-2 adds the Java api surface emitting
> into this contract (its own ADR/spec). This ADR records the composition contract;
> it does not build any non-TS surface.

## Context

A polyglot solution (e.g. TypeScript + Java over the same meta models) needs ONE
coherent doc tree: the **model docs once** (language-independent) + **one SDK/api
reference per language** (idiomatic), all cross-linked. ADR-0025 unified the docs
door but documented a single api surface. Generating the model docs once per
language would duplicate language-neutral output (the Tier-2 trap); documenting
only one language ignores the others.

## Decision

Documentation surfaces are declared as an explicit **per-language list** in the
`docs:` config:

```ts
docs: {
  outDir, layout, baseUrl,
  surfaces,                                  // model/api on-off selector
  apiSurfaces: [ { lang, subDir, baseUrl? } ] // default [{ lang:"ts", subDir:"api" }]
}
```

- **Model once, api per language.** The model surface (Tier-2 shared engine) is
  generated once; each entry in `apiSurfaces` is a per-language api surface
  (Tier-1) under its own `subDir`. The model page links **every** declared surface
  (`**API reference:** [TypeScript](api/ts/Order.md) · [Java](api/java/Order.md)`).
- **Explicit list, not auto/manifest.** This matches the proven pattern for
  one-model→many-language tooling — buf (`buf.gen.yaml` `plugins[]`, per-language
  `out:`) and Smithy (`smithy-build.json` projections/plugins) — and our own
  `generators[]`/`targets{}`. A multi-repo **manifest** (Backstage-catalog style)
  is a portal/federation layer ABOVE this; it is **deferred**. The internal
  resolver consumes a source-agnostic resolved surface list, so a manifest can feed
  the same contract later without reworking the generators.
- **Cross-link base: relative or `baseUrl`.** `apiSurfaceHref` returns a relative
  path when the surface is in the same tree (one-tree topology) and an absolute
  `baseUrl/page` when the surface declares a `baseUrl` (federated / separate repo).
  Same code path yields both topologies.
- **Per-port command, shared model engine** (inherited from ADR-0025). Each port's
  `docs` command emits the api surfaces whose `lang` it owns + links all declared;
  the model engine stays singular/shared (NOT reimplemented per language). For a
  polyglot TS+Java solution the model docs come from the TS toolchain once, so the
  deferred non-TS model-engine-reach decision (ADR-0025) is not on the critical path.

## Consequences

- A solution declares its languages once; the model page is solution-complete
  (links all surfaces) even though each port emits only its own api surface.
- One-tree (relative) and federated multi-repo (`baseUrl`) topologies are the same
  mechanism, differing only by whether a `baseUrl` is set.
- No model-doc duplication across languages; the Tier-2/Tier-1 split is preserved
  (model surface shared, api surfaces per-port).
- SP-2 (Java api surface) plugs into this contract by emitting into its `subDir`
  and cross-linking back to the shared model root.

## Alternatives considered

- **Per-language self-contained doc sets** (each language emits model + its api):
  rejected — duplicates the language-neutral model docs (drift + waste).
- **A solution manifest as the primary declaration** (Backstage-style): deferred —
  it is a federation/portal layer above per-project generation; the explicit
  config list is the right foundation, with the resolver kept manifest-ready.

## Scope

Built in TypeScript (the only port with both surfaces today). The `apiSurfaces`
schema, the model→multi-link rendering, `apiSurfaceHref`, and the multi-surface
cross-link conformance gate are TS-now; they are the cross-port contract for the
SP-2 fan-out.

# ADR-0003 — Metamodel constants colocation

**Status:** Accepted — 2026-05-23
**Applies to:** all language ports (TS, Java, Python, C#)
**Related:** ADR-0002 (Open-Closed typed nodes), ADR-0004 (provider-based registration);
`docs/superpowers/specs/2026-05-21-metadata-constants-colocation-design.md` (TS feature design);
CLAUDE.md "Coding discipline" + "Cross-language porting"; `spec/cross-language-porting-guide.md`

## Context

The project's coding discipline forbids inline metamodel string literals: type names,
subtype names, reserved JSON keys, special attribute names, and structural separators must
be **named constants** for compile-time typo safety. The question this ADR settles is
*where those constants live*.

The original TS shape put them all in a single `constants.ts` (518 lines), imported by 7
packages, with a parallel monolith for attribute schemas (`core-attr-schemas.ts`). C#
mirrored this with a 540-line `Constants.cs`. Concrete problems with the god-file:

1. **No locality.** Touching one concept (say, fields) meant editing the constants
   monolith, the parallel schema monolith, *and* the node class — three centralized files,
   none co-located.
2. **Blast radius.** The constants file is the root of the dependency tree; with lockstep
   versioning a one-line change forces a full-suite republish.
3. **Layering leaks.** Language-specific values (a Java-runtime strategy enum) lived in the
   TypeScript core, registered and enum-validated there — the TS core validating Java
   semantics.

Java never had this problem: type/subtype constants live **on the type class**
(`StringField.SUBTYPE_STRING`), and feature/concern constants live **in the feature
module**.

A correction worth recording, because it is a tempting wrong turn: constants are **not**
relocated to *downstream* packages. The CLAUDE.md "Cross-language porting" vocabulary
(filter operators, source/origin/layout subtypes, currency attrs, `@schema`) is
**cross-language core metamodel** — the loader validates it and conformance pins it.
Downstream codegen/runtime packages merely *consume* it. So colocation is **internal to the
metadata core**, grouped by concern; almost nothing leaves it.

## Decision

**Metamodel constants live with the node class / concern module that owns them. There is no
god constants file.**

The durable cross-language contract:

1. **Each concern owns its constants + attribute schema + node accessor, together.** Type
   and subtype name constants live on (or beside) the type class; a concern's attribute-name
   constants and attribute-schema inventory live in that concern's module. Touching "fields"
   is one folder, not three central files.
2. **Group by metamodel layer**, not by artifact kind: core domain (object, field, attr,
   validator, identity, relationship, query), persistence (source, origin, db), presentation
   (view, layout), and a small shared layer for genuinely structural keys (`name`,
   `package`, `extends`, the `@` prefix, the `::` separator, the fused-key form).
3. **A barrel preserves the convenient import surface.** Consumers may keep importing
   bare names from the package root; the barrel re-exports each concern's public constants.
   The colocated definition remains the single source of truth.
4. **No language-specific values in a cross-language core.** A value that only one language
   needs, and that no conformance fixture exercises, does not belong in the shared metamodel
   core.

This is wire-format and conformance neutral: the canonical serialized output is identical
regardless of *which module* defines a constant. It is a code-organization contract, not a
behavior change.

## Consequences

**Positive**
- Locality: a concern's vocabulary, schema, and behavior are edited together (reinforces
  ADR-0002's "1 class + 1 registration" property).
- Smaller blast radius: a concern-local change doesn't mutate a god-file at the root of the
  dependency graph.
- No layering leaks: a cross-language core can't accumulate one language's private values.
- New ports get a clear placement rule, removing "where does this constant go?" ambiguity.

**Negative / costs**
- More files (one constants module per concern instead of one big file). The barrel keeps
  the import surface flat, so consumers are unaffected.
- A discipline to maintain: the temptation to "just add it to the shared file" must be
  resisted; the porting guide and code review enforce it.

## Alternatives considered (rejected)

1. **Single god constants file (the original shape).** No locality, large blast radius,
   invites layering leaks. Rejected — this ADR exists to undo it.
2. **Relocate "feature" constants to downstream packages.** A misclassification: the
   cross-language vocabulary is core metamodel that downstream packages only consume.
   Rejected.
3. **No constants at all (inline literals).** Violates the project's typo-safety discipline.
   Rejected.

## Realization status

- **Java** — always colocated (constants on the type class). Reference shape.
- **TS** — refactored from the two monoliths into per-concern modules grouped by layer
  (`docs/superpowers/specs/2026-05-21-metadata-constants-colocation-design.md`).
- **C#** — **stale**: still has the `Constants.cs` monolith. Migrate when next touched; do
  not mirror it for new ports.
- **Python** — adopting colocation from the start; a package-root barrel preserves
  convenient imports.

## Conformance note

Constant *placement* is invisible to the corpus — conformance tests canonical *output*. The
cross-language vocabulary *values* (`"dataGrid"`, the filter operators, etc.) are pinned by
CLAUDE.md and the corpus and do not change under this ADR.

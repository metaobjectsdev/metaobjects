# FR5d — Reference-resolution errors (`extends` / `@via` / `@objectRef` / `@payloadRef`) (sketch)

**Status:** Design proposal — needs brainstorm before implementation
**Date:** 2026-05-25
**Scope:** Cross-language — all four ports' deferred-resolution + validation phases.
**Depends on:** [ADR-0009](../../../spec/decisions/ADR-0009-loader-error-envelope-and-source-on-node.md), FR5a, optionally FR5c.

## Goal

When a metadata reference fails to resolve, the error envelope uses
`format: "resolved"` and identifies both the **referrer** (which entity points at a
broken target) and the **target** (what was expected to exist):

```jsonc
{
  "code": "ERR_UNRESOLVED_SUPER",
  "message": "object 'myapp::content::Video' extends 'BaseEntity', but no object with that fqn was found",
  "source": {
    "format": "resolved",
    "files": ["metaobjects/meta.content.json"],
    "jsonPath": "$.metadata.root.children[0].object.entity.extends",
    "referrer": "myapp::content::Video",
    "target": "BaseEntity"
  }
}
```

Reference types in scope:

- `extends: "BaseEntity"` — object-level inheritance.
- `@via: "Program.weeks"` — dotted relationship path for projections.
- `@objectRef: "..."` — field-level object reference.
- `@payloadRef: "..."` — `template.prompt` / `template.output` linkage to a value-object.
- `@of: "Week.id"` — origin aggregate target.

## Why this is its own FR

Reference resolution runs after all files are loaded — the references are deferred
on purpose (per CLAUDE.md's loader pipeline notes). Errors raised at this phase need
extra context: the referrer's `source` is already populated (by parse), but the
"target was expected to be in scope" half requires its own attribution.

FR5d adds:

1. **`referrer` and `target` fields on `format: "resolved"`** — already in ADR-0009;
   FR5d populates them.
2. **New error codes (or refined messages) per reference type** — `ERR_UNRESOLVED_SUPER`,
   `ERR_UNRESOLVED_VIA_PATH`, `ERR_UNRESOLVED_OBJECT_REF`, `ERR_UNRESOLVED_PAYLOAD_REF`,
   `ERR_UNRESOLVED_AGGREGATE_OF`. Or consolidate to a single `ERR_UNRESOLVED_REFERENCE`
   with `subtype` discriminator.
3. **Suggestions on resolved errors** — `did-you-mean` for `extends` failures (Levenshtein
   over known object FQNs), `@via` path suggestions (e.g. suggesting `Program.weeks`
   when the user wrote `Program.week`).

## Open design questions

### 1. Granularity of error codes

Single `ERR_UNRESOLVED_REFERENCE` with discriminator, or per-reference codes
(`ERR_UNRESOLVED_SUPER`, `ERR_UNRESOLVED_VIA_PATH`, etc.)? Existing taxonomy leans
toward per-reference but adds maintenance surface.

### 2. Multi-hop suggestions

`@via: "Program.weeks.workouts.invalid"` — fails at `invalid`. Should suggestion
guide to the deepest valid prefix (`Program.weeks.workouts`)? That requires the
resolver to track which segment failed.

Recommendation hypothesis: **yes, deepest-valid-prefix is in the message**; suggestion
list adds Levenshtein over the valid leaves.

### 3. Source attribution for cross-file references

If `Video extends BaseEntity` and both are declared in different files, the
referrer's `source.files` is `[meta.content.json]` (Video's file) and the resolver
knows BaseEntity wasn't found in ANY file. Should the envelope also report which
files WERE searched (`searched: [...all loaded files]`)? Useful debug context but
verbose.

Recommendation hypothesis: **no by default; offer as a verbose mode**.

## Out of scope

- Pre-resolution lint (catching unresolved refs before the full graph is built).
- Auto-fix suggestions (rewriting metadata files to repair refs). Different feature.

## Tests + verification

- New `error-unresolved-*` fixtures exercising each reference type.
- Per-fixture `expected.json` declares `source.referrer` + `source.target`.
- Suggestions T2 — port-private tests for Levenshtein suggestions on resolved errors.

## Open questions

To be settled during brainstorm:

1. Single error code or per-reference codes.
2. Multi-hop `@via` suggestion shape.
3. Verbose "searched files" reporting.

# FR5c — Multi-file merge / overlay error attribution (sketch)

**Status:** Design proposal — needs brainstorm before implementation
**Date:** 2026-05-25
**Scope:** Cross-language — all four ports' overlay/merge phase.
**Depends on:** [ADR-0009](../../../spec/decisions/ADR-0009-loader-error-envelope-and-source-on-node.md), FR5a (envelope + source-on-node + `semantic_diff` operational).

## Goal

When the overlay-merge phase fails or produces diagnostic-worthy outcomes, the loader
emits envelope errors / warnings with `format: "merged"` and a `contributors[]` list
naming every file that contributed:

```jsonc
{
  "code": "ERR_MERGE_CONFLICT",
  "message": "attr '@kind' conflicts: file A declared 'dbTable', file B declared 'dbView' for object 'myapp::commerce::Program'",
  "source": {
    "format": "merged",
    "files": ["metaobjects/meta.a.json", "metaobjects/meta.b.json"],
    "jsonPath": "$.metadata.root.children[0].object.entity.children[0].source.@kind",
    "contributors": [
      { "file": "metaobjects/meta.a.json", "role": "overlay-base" },
      { "file": "metaobjects/meta.b.json", "role": "overlay-extension" }
    ]
  }
}
```

Plus the warning channel:

```jsonc
{
  "warnings": [
    {
      "code": "WARN_DUPLICATE_DECLARATION",
      "message": "duplicate declaration of myapp::commerce::Program with no semantic change",
      "source": {
        "format": "merged",
        "files": ["metaobjects/meta.a.json", "metaobjects/meta.b.json"],
        "jsonPath": "$.metadata.root.children[0].object.entity",
        "contributors": [
          { "file": "metaobjects/meta.a.json", "role": "overlay-base" },
          { "file": "metaobjects/meta.b.json", "role": "overlay-extension" }
        ]
      }
    }
  ]
}
```

## Why this is its own FR

The overlay-merge phase exists in every port (driven by the same-`package` + same-`name`
merge rule from `spec/metamodel.md`). Today's behaviour: last-writer-wins on attrs;
structural children accumulate; conflicts raise generic errors without file attribution.

FR5c brings the envelope to the merge phase. It needs:

1. **Merge phase tracks contributors.** Already foreshadowed by `semantic_diff`
   from FR5a. The merge code now records which file contributed which attr / child
   and stores `contributors[]` on the merged node's `source`.
2. **Errors raised during merge use the envelope.** Conflict cases (attr that can't
   be merged because both sides specify different non-overrideable values) raise
   with `format: "merged"`.
3. **`WARN_DUPLICATE_DECLARATION` actually fires.** FR5a created the warning code in
   ADR-0009 but doesn't have a fixture exercising it; FR5c adds the fixture(s).

## Open design questions

### 1. New error code(s) for merge conflicts

Today's loader has `ERR_MERGE_CONFLICT` (or per-port equivalent). FR5c may want to
split:

- `ERR_MERGE_CONFLICT_ATTR` — same attr declared with different values.
- `ERR_MERGE_CONFLICT_STRUCT` — incompatible structural changes (rare; e.g. one file
  declares `abstract: true`, another `abstract: false`).
- Just keep `ERR_MERGE_CONFLICT` and let the message disambiguate.

### 2. Order-dependence of overlay

The current spec says "last-writer-wins on attr conflicts." But the file load order
is implementation-defined (alphabetical? declaration-order? package-order?). If two
files conflict, the "winner" depends on load order, which is fragile.

FR5c brainstorm should decide: is load order specified, or does any conflict produce
an error regardless?

### 3. Per-attr vs per-node contributors

ADR-0009 says node-level contributors. FR5c may surface a request for "which file
last declared attr `@foo`" — i.e., per-attr provenance. If demand surfaces during
brainstorm, may motivate extending the diff algorithm.

## Out of scope

- Pre-emptive overlay-conflict prevention (CI-side lint that flags conflicts before
  merge runs). Different feature.
- Cross-package conflicts (two packages with the same FQN). Existing loader rejects;
  not in FR5c scope.

## Tests + verification

- New `error-merge-*` fixtures in the conformance corpus, exercising:
  - Conflict between two files (envelope error).
  - Duplicate declaration with no change (warning channel exercise).
  - Three-way merge (three files contributing same node).
- Conformance harness extension: assert `source.contributors[]` matches expected
  (sort-insensitive — contributor order isn't canonical).

## Open questions

To be settled during brainstorm:

1. Load-order spec (deterministic or implementation-defined?).
2. New error code(s) vs existing `ERR_MERGE_CONFLICT`.
3. Per-attr provenance — defer or include?

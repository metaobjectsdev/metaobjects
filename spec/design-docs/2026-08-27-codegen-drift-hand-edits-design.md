# `verify --codegen` must not convict a hand edit it told you to make

**Date:** 2026-08-27 · **Status:** designed · **Companion:**
[`2026-08-27-test-metadata-ruling.md`](2026-08-27-test-metadata-ruling.md)

## The defect

Two shipped guarantees contradict each other. Reproduced on a clean `0.24.2` external install:

```
meta gen                            src/generated/Bot.ts, merged        ← hand edit preserved
meta verify --codegen               ~ src/generated/Bot.ts (committed content differs from a
                                      fresh regen)
                                    Run 'meta gen' to regenerate, then commit the result.
                                    exit 1
meta gen && meta verify --codegen   exit 1                              ← the remedy is a loop
```

`meta gen` preserves hand edits through a three-way merge and reports `merged`. That is the
documented contract: *"Anything inside a generated file is fair game to hand-edit; three-way merge
preserves it."* `verify --codegen` then convicts the same file, and the fix it prints cannot work —
running `meta gen` merges and preserves the edit again, so the next run fails identically.

`computeCodegenDrift` regenerates with `mergeStrategy: "overwrite"` and `baseline: "fresh"` into a
throwaway gen-state directory, then byte-compares against committed output. Its own header states
the conflation:

> Any difference … is drift: either "metadata changed but `meta gen` wasn't re-run" **or** "a
> generated file was hand-edited".

Only the first is drift. The second is the workflow.

## Blast radius

Every project that hand-edits generated output — the sanctioned path — and runs `--codegen` in CI.
It is worst for `requirementTests()` stubs, which are worthless until hand-edited because the
assertion is the author's to write; and it is one of the three adjudicated reasons an adopter
abandoned building a requirement-test generator on top of this toolchain.

## The fix

`.gen-state/.hashes.json` already distinguishes these two cases and is **committed** while the
snapshot bodies are not — the split exists precisely so this question is answerable on a machine
that did not generate the output. Measured on the reproduction above:

| | value |
|---|---|
| `.hashes.json["src/generated/Bot.ts"]` | `b9ace714…` |
| `sha256(.gen-state` snapshot body`)` | `b9ace714…` — identical |
| `sha256(`file on disk, post-merge`)` | `5b11a40b…` — differs |

The manifest records **what the generator wrote**, not what the file became. So for a file whose
committed content differs from a fresh regen:

- `contentHash(fresh) === readGeneratedHash(genStateDir, relPath)` → the generator's contribution
  is unchanged since the last `meta gen`. The difference on disk is a preserved hand edit.
  **Not drift.**
- otherwise → regenerating would produce different generated content. **Drift**, exactly as today.

The question the gate can honestly answer is *"is the generated contribution current?"*, and that
is the question this computes.

### Scope

Only the `~` (content differs) branch changes. The two structural branches keep today's behaviour,
because neither is a hand edit:

- `committed but regen would not emit it` — an orphan. Still drift.
- `regen would emit it; not committed` — never generated. Still drift.

### Fail-closed on absent evidence

No recorded hash for the path → **drift**, as today. A project with no committed manifest keeps
its current semantics, and that case is already surfaced separately by `warnIfManifestIgnored`.
This matches `isPristineGenerated`'s existing rule: with no recorded hash nothing is proven, so
the answer is no.

### The real gen-state directory, not the temp one

`computeCodegenDrift` builds a temp gen-state to force full regeneration. That temp manifest is
useless for this decision — it describes the run that just happened. The comparison must read the
**project's** `.gen-state`, which the CLI already resolves.

## What this deliberately gives up

A hand edit that *contradicts* the metadata — deleting a generated validation, say — stops being
caught by `--codegen`. That is not a regression in coverage so much as an admission of what the
gate was ever able to do: it could not distinguish that edit from a legitimate one, so it failed
both, and a gate that fails the sanctioned workflow gets switched off. Hand-written logic inside
generated files is kept honest by the compiler and the test suite, which is the division the
product already states — *verify keeps the generated code honest; the compiler keeps your logic
honest.*

Recorded as a limit rather than hidden: if a project wants byte-exact generated output, the answer
is to not hand-edit it, and a future `--codegen --strict` could restore the old comparison. Not
built now — no one has asked, and an unused flag is its own cost.

## Testing

1. **Regression, from the reproduction.** Generate, append a line, `meta gen` (asserts `merged`),
   `verify --codegen` → clean, exit 0. This is the failing test that opens the work.
2. **Real drift still fails.** Change the metadata without re-running `gen` → `~` drift, exit 1.
3. **The remedy terminates.** After (2), `meta gen` then `verify --codegen` → clean. Today this
   loops forever on a hand-edited file; the assertion is that the printed instruction now works.
4. **Fail-closed.** Delete `.hashes.json`, hand-edit → drift, exit 1.
5. **Structural branches unchanged.** An extra committed file and a missing one both still drift.

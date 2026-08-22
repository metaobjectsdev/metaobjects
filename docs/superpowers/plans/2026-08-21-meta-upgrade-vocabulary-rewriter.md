# `meta upgrade` — a vocabulary rewriter driven by the retirement map

Retiring vocabulary currently costs every adopter a manual sweep. This adds `meta upgrade`,
which rewrites what can be rewritten and **refuses** what needs judgment, driven by the same
map the loader already uses to explain a retirement.

## The constraint that shapes everything

**The rewriter cannot use the loader.** Once an attribute is deregistered, metadata carrying
it fails the load — that is the entire point of the retirement. So load → transform →
canonical-serialize is impossible: the input does not load, and the canonical serializer
needs a loaded model.

It operates on the **raw document**. That is also what makes the upgrade path exist: an
adopter installs the new CLI, runs the fixer against metadata the new CLI *refuses*, and only
then does anything else work. A fixer needing a successful load would be a chicken-and-egg
with no exit.

Second-order: **surgical text edits, never parse-and-reprint.** Adopters author JSONC with
comments and meaningful key order; a round-trip through `JSON.parse`/`stringify` destroys
both. Same distinction the repo already draws between ts-poet (greenfield emit) and ts-morph
(in-place edit).

## One map, not two

`RETIRED_VOCABULARY` (shipped, `metadata/src/retired-vocabulary.ts`) already declares
`since` / `why` / `replacedBy` / `migration`, and the loader reads it to explain a failure.
The rewriter reads the **same** entries, so the message and the fix cannot drift: the error
says "use `@counterexample`" and the fixer writes `@counterexample` for the same reason.

## Mechanical vs judgment

Not every retirement is automatable, and the tool must not pretend:

| retirement | transform | automatable |
|---|---|---|
| `@violation` → `@counterexample` | key rename | yes |
| `@readOnly: true` → `@mutability: "readOnly"` | key + value | yes |
| `@verifiedBy` | drop the attr | yes |
| `@status: abandoned` | delete node / retype / fix residue | **no — judgment** |

`RetiredEntry` gains an optional `rewrite`. Present ⇒ the fixer applies it. **Absent ⇒ the
fixer refuses that node and prints the migration guide**, the same detect-and-refuse posture
used for the D1 primary-key move rather than emitting something un-appliable.

## Tasks

### 1. `rewrite` on `RetiredEntry`
`{ kind: "renameAttr", to }` · `{ kind: "dropAttr" }` · `{ kind: "renameAttrValue", toAttr, toValue }`.
Absent ⇒ judgment. Tests: every entry either carries a `rewrite` or names a `migration`;
no entry claims a rewrite it cannot perform.

### 2. The rewriter
`rewriteDocument(text, opts) → { text, changes[], refusals[] }`, pure, no filesystem.
- surgical: unchanged regions byte-identical, comments and key order preserved
- JSON and YAML (YAML authoring is sigil-free — a rename there is the bare key)
- reports every change with line numbers, and every refusal with its guide

### 3. `meta upgrade`
Dry-run + diff by DEFAULT (repo convention); `--apply` writes. `--to <version>` bounds which
retirements apply. Non-zero exit when refusals remain, so CI cannot call a partial upgrade
done.

### 4. Dogfood
Run it against this repo's own metadata and fixtures before shipping. Any refuse-case we hit
is one an adopter would have hit.

### 5. The rename — `@violation` → `@counterexample`
Five ports, spec files, embedded definitions, `expected-registry.json`, fixtures, docs,
skills, agent-context trees. **Breaking**, so it needs a MINOR and a `metamodelVersion` move.
`registry-conformance` fails any port that misses it — mechanical work with a hard backstop.

**Sequencing note:** `0.24.0-rc.5` is soaking. Tasks 1–4 are additive and land safely; task 5
is breaking and belongs to the next MINOR, not to 0.24.0.

## Verification

- the rewriter is proven on a document with comments, odd key order, and both formats
- a judgment case is **refused**, not silently skipped, and the exit code reflects it
- our own corpus round-trips: rewrite → load → canonical-serialize is byte-identical to
  loading the hand-migrated original
- the gate is proven able to fail

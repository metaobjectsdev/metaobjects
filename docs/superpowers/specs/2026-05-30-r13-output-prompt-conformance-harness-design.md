# R13 — Output-Format Prompt-Fragment Conformance Harness — Design

_Date: 2026-05-30. Status: approved (design). Backlog item: R13 (see `docs/superpowers/specs/2026-05-29-conformance-hardening-review.md`)._

## Problem

FR-010 shipped an **output-format prompt fragment** in all five ports: `OutputFormatRenderer.render(spec, overrides)` emits a comment-free instruction fragment teaching an LLM the exact shape to return, in three presentation styles (`guide` | `inline` | `exampleOnly`) across two formats (`json` | `xml`), driven by `@promptStyle` / `@example` / `@instruction` / `@enumDoc` on a `template.output` + its payload value-object.

The whole point of that fragment is **prompt-cache stability**: the rendered prefix must be byte-stable so exact-prefix prompt-cache hits are not silently broken — and it must be byte-**identical** across ports so a service written in one language emits a cache-compatible prefix to one written in another.

Today that guarantee is **not pinned by any shared corpus**. Each port's renderer is trusted to its own unit tests (`OutputFormatRenderer*Test`, `*OutputPromptGenerator*Test`). The `template-output-*` metamodel fixtures pin only the *declaration* (loader + serializer), not the rendered bytes. So cross-port byte-identity of the fragment is unverified — the exact property the feature exists to provide.

This is backlog item **R13** ("prompt-parser / prompt corpus"), and was a bounded deferral noted during FR-010 ("output-prompt verify-conformance corpus wiring").

## Goal

A strong, shared, cross-port conformance harness that pins the rendered output-format prompt fragment **byte-for-byte across all five ports**, plus a round-trip property tying the request side to the response (`recover`) side. Bundle the adjacent FR-011 loader gap: shared negative fixtures for the enum-coercion attribute validation.

## What this harness pins — and what it does not

**Pins:** given an identical spec descriptor, all five ports' `OutputFormatRenderer` produce **byte-identical** fragments for every (style × format) combination. That is the prompt-cache-stability guarantee.

**Does not pin (by design):** the metadata→spec *extraction* (walking a `template.output` + payload VO to build the `OutputFormatSpec`). That logic lives inside each port's codegen emitter (`OutputFormatSpecEmitter` and peers), which emits `new OutputFormatSpec(...)` as source text — there is no runtime metadata→spec builder, and extracting one across five ports would be a large refactor that risks regressing shipped FR-010 codegen. Extraction stays covered by the existing per-port codegen unit tests + FR-010 compile-run proofs. Because the emitted prompt class simply delegates to the engine, **engine byte-identity (this harness) + the existing "generated class delegates to the engine" compile-run proofs are transitively strong.**

This boundary is stated explicitly so the gate is not oversold — consistent with the lesson that "all corpora green" must mean what it says.

## Architecture

The harness is **descriptor-driven**, mirroring the existing `recover-conformance` corpus (which drives the `recover` engine from a serialized `RecoverSchema`). Each case serializes a spec descriptor; every port deserializes it into its native `OutputFormatSpec`, renders, and asserts byte-equality against checked-in expected output.

### Corpus layout — `fixtures/output-prompt-conformance/<case>/`

```
spec.json                  # cross-port oracle INPUT (the unified field descriptor)
expected.guide.txt         # byte-exact rendered fragment, style = guide
expected.inline.txt        # byte-exact rendered fragment, style = inline
expected.exampleOnly.txt   # byte-exact rendered fragment, style = exampleOnly
README.md                  # one paragraph: what this case exercises
```

`format` (`json` | `xml`) is a property of the case (fixed in `spec.json`), so each case is single-format. All three styles are rendered per case via the runtime style override, yielding three expected files.

### `spec.json` descriptor (the unified oracle input)

```jsonc
{
  "format": "json",            // "json" | "xml"
  "rootName": "SupportAnswer", // XML root tag / logical JSON root
  "roundTrip": true,           // optional; true only when EVERY field has an @example (gates the round-trip assertion)
  "fields": [
    {
      "name": "text",
      "kind": "STRING",        // STRING | INT | LONG | DOUBLE | BOOLEAN | ENUM | OBJECT
      "required": true,
      "array": false,          // optional, default false
      "example": "Your refund will appear in 3-5 days.",   // optional
      "instruction": "One or two sentences to the customer.", // optional
      "enumValues": null,      // string[] when kind = ENUM
      "enumDoc": null,         // { MEMBER: "doc" } when kind = ENUM
      "nested": null           // a nested { rootName, fields } object when kind = OBJECT
    }
  ]
}
```

One descriptor builds **both**:
- an `OutputFormatSpec` (consuming `example` / `instruction` / `enumValues` / `enumDoc` / `nested`) for rendering, and
- a minimal `RecoverSchema` (consuming `name` / `kind` / `required` / `enumValues` / `array` / `nested`) for the round-trip.

They are sibling descriptors; the superset avoids duplicate per-case files.

### Per-port harness (engine-level, all five ports)

For each case directory:

1. Parse `spec.json` → build the port's `OutputFormatSpec`.
2. For `style` in `{guide, inline, exampleOnly}`: `render(spec, style)` → assert the result is **byte-equal** to `expected.<style>.txt`. **Zero-drift: no ledger.** Any divergence fails the build.
3. **Determinism:** render a second time, assert identical to the first.
4. **Round-trip** (only when `spec.json` has `"roundTrip": true`): build a `RecoverSchema` from the same descriptor → `recover(expected.exampleOnly.txt)` → assert every declared field classifies **RECOVERED** (no `MALFORMED` / `LOST_REQUIRED` / `LOST_OPTIONAL`). This is the example↔recover skew guard: it catches a renderer that emits an example the `recover` parser cannot read back.

**Kotlin** reuses the shared JVM `render` engine (the same Java `OutputFormatRenderer` + `Recover` classes), so its harness drives those classes directly. This still runs the corpus end-to-end in the Kotlin module — closing, for this corpus, the "Kotlin runs only 2 of 6 corpora" gap. Engine output is byte-identical to Java by construction; the value is proving the corpus loads and the assertions execute in the Kotlin build.

### Why zero-drift is achievable here

Unlike `render-conformance` (which runs user templates through a Mustache engine and carries one ledgered standalone-comment divergence from Mustache.java), `OutputFormatRenderer` is **hand-written, comment-free, and builds strings directly**. There is no third-party templating engine in the path. The FR-010 renderers were authored per port specifically to be byte-identical, and `recover-conformance` already demonstrates byte-identical canonical values cross-port.

To keep zero-drift robust against the one known cross-runtime hazard — floating-point formatting (the R6 float-fidelity lesson) — **fixture example values are restricted to strings, integers, booleans, and dyadic decimals only**; no raw floats whose textual form differs across runtimes. This restriction is documented in the corpus README. If a genuine platform divergence ever surfaces, it is a renderer bug to fix, not a ledger entry.

## Case matrix

Approximately ten cases × three styles ≈ thirty expected files. Each case is a `spec.json` + three `expected.*.txt`:

| Case | Format | Exercises |
|---|---|---|
| `json-scalars` | json | string/int/bool/dyadic-double scalars; `@example` + `@instruction`; required + optional |
| `xml-scalars` | xml | same field set, XML rendering |
| `json-enum` | json | `field.enum` with `@enumValues` + `@enumDoc` + `@example` |
| `xml-enum` | xml | enum, XML |
| `json-array` | json | scalar array field |
| `json-nested` | json | nested `OBJECT` field (nested rootName + fields) |
| `xml-nested` | xml | nested object, XML |
| `optional-absent` | json | optional fields with no `@example`/`@instruction` (sparsity / skeleton behavior) |
| `instruction-fallback` | json | fields lacking `@instruction` (guide-style fallback) |
| `unicode-example` | json | multibyte `@example` value (byte-identity under UTF-8) |

`roundTrip: true` is set on the cases where every field declares an `@example` (at minimum `json-scalars`, `xml-scalars`, `json-enum`, `xml-enum`, `json-nested`, `xml-nested`, `unicode-example`).

## FR-011 attribute-validation negative fixtures (bundled scope add)

Three shared metamodel fixtures, added under `fixtures/conformance/`, exercising the FR-011 enum-coercion attribute validation that currently lives only in per-port loader unit tests:

| Fixture | Declares | Expected error |
|---|---|---|
| `error-enum-coerce-default-non-member` | `field.enum` with `@coerceDefault` value not in `@values` | `ERR_BAD_ATTR_VALUE` |
| `error-enum-default-non-member` | `field.enum` with `@default` value not in `@values` | `ERR_BAD_ATTR_VALUE` |
| `error-enum-normalize-bad-mode` | `field.enum` with `@normalize` not in `none` / `collapse` / `strip` | `ERR_BAD_ATTR_VALUE` |

These run on the existing metamodel-conformance loader runners (TS / C# / Java / Python). The Kotlin `metadata-ktx` facade is read-only and does not run the metamodel corpus, so it is out of scope for these fixtures — consistent with where the FR-011 validation actually executes.

Each fixture follows the existing `error-*` metamodel-fixture convention — an `input/meta.<name>.json` plus an `expected-errors.json` of the form:

```jsonc
{ "errors": [ { "code": "ERR_BAD_ATTR_VALUE",
                "source": { "format": "json", "files": ["meta.enums.json"],
                            "jsonPath": "$['metadata.root'].children[0]['object.entity'].children[1]['field.enum']" } } ],
  "warnings": [] }
```

The loader runners already parse this envelope generically (the `jsonPath` is per-fixture), so the new directories need **no runner change** — only authoring. (Note: missing `@values` is `ERR_MISSING_REQUIRED_ATTR`, already covered by `error-enum-missing-values`; all three FR-011 fixtures are *bad-value* cases → `ERR_BAD_ATTR_VALUE`.)

## Components / file inventory

- **Corpus (shared):** `fixtures/output-prompt-conformance/<case>/{spec.json, expected.*.txt, README.md}` + a top-level `README.md` documenting the descriptor schema and the no-float rule; three `fixtures/conformance/error-enum-*` fixtures.
- **TS (pilot):** `server/typescript/packages/render/test/output-prompt-conformance.test.ts` — descriptor parse → `OutputFormatSpec` → render × 3 styles → byte assert → determinism → round-trip via `recover`.
- **C#:** `csharp/MetaObjects.Render.Tests/OutputPromptConformanceTests.cs`.
- **Java:** `server/java/render/src/test/java/com/metaobjects/render/prompt/OutputPromptConformanceTest.java`.
- **Python:** `server/python/tests/render/test_output_prompt_conformance.py`.
- **Kotlin:** a runner in the Kotlin render/test module driving the shared JVM `OutputFormatRenderer` + `Recover` against the corpus.
- **Descriptor → spec builders:** a small per-port test helper that maps `spec.json` → the native `OutputFormatSpec` (and → `RecoverSchema` for round-trip). Test-only; not production code.

Each runner asserts a **corpus-count guard** (the number of case directories matches an expected constant) so a port silently skipping cases fails — the same guard `recover-conformance` runners carry.

## Testing strategy

The harness *is* the test. Validation that the harness itself is sound:
- The TS pilot authors the corpus and is the reference; expected files are generated by the TS renderer and then **independently reproduced** by each port's runner (a port that cannot reproduce them fails — that is the gate working).
- Determinism assertion (render twice) guards against accidental nondeterminism (map ordering, etc.).
- The round-trip assertion guards example↔recover skew.
- Corpus-count guards guard silent skips.
- Zero-drift (no ledger) guards against quiet divergence acceptance.

## Build order and merge strategy

TS pilot (corpus + reference assertions + round-trip) → C# → Java → Python → Kotlin port the runner against the shared corpus → FR-011 error fixtures (small; loader ports) → close-out (KNOWN_GAPS/roadmap/memory).

All work stays on **one branch with a single final merge** (as with FR-011): the shared corpus would red the other ports if the pilot merged alone. Each unit passes a spec-compliance + code-quality review gate before the final merge. Forward-only on `main`.

## Out of scope (explicit)

- Runtime metadata→`OutputFormatSpec` extraction (stays in codegen; covered by existing compile-run proofs).
- The codegen-emitted prompt class compile-run tier (already covered per-port by FR-010 proofs; the design pins the engine the class delegates to).
- Payload-VO codegen corpus (backlog item **R12** — separate future plan).
- Raw-float example values (excluded to preserve zero-drift).
- Kotlin metamodel-corpus participation for the FR-011 error fixtures (read-only facade).

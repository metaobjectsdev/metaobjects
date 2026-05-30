# FR-012 — Nested-Object Prompt Expansion — Design

_Date: 2026-05-30. Status: approved (design). Follows FR-010 (output-format prompt fragment) + R13 (output-prompt-conformance harness)._

## Problem

FR-010's `OutputFormatRenderer` turns an `OutputFormatSpec` into a prompt fragment that teaches an LLM the exact shape to return. It handles scalar and enum fields in three styles (`guide` / `inline` / `exampleOnly`) × two formats (`json` / `xml`). But it **does not expand nested objects or arrays** — an `OBJECT` field renders as a flat `{name}` placeholder, and array fields render the same flat placeholder. This was a documented bounded deferral that shipped in all five ports.

The R13 output-prompt-conformance harness surfaced the consequence: a **request/response asymmetry**. The tolerant `recover()` parser (FR-010 + FR-011) *does* handle nested objects and arrays-of-objects (dotted-path recovery `meta.score`, `items[i].label`) and scalar arrays. So today we can *parse* a nested answer but cannot *ask* for one — a model handed `"meta": "{meta}"` has no idea of the inner shape and will guess or return a string. For LLM structured output, nested objects and arrays are common, so this degrades real outputs.

## Goal

Make the prompt fragment teach the full nested shape — nested objects, arrays-of-objects, and scalar arrays — in all three styles × both formats, **byte-identical across all five ports**, with a cycle/depth guard. Close the request/response asymmetry. The R13 corpus is the byte-identity gate.

## Scope

In scope (all three, because `recover` already handles all three — anything excluded stays an asymmetry):
1. **Nested objects** — an `OBJECT` field expands its nested `OutputFormatSpec`'s fields.
2. **Arrays of objects** — an `OBJECT` field that is also an array (`array == true`) renders a one-element array whose element is the expanded object.
3. **Scalar arrays** — a non-object field with `array == true` renders a one-element array of the scalar.

Out of scope:
- The descriptor / metadata layer — the nested spec is **already** carried on `PromptField.nested`; the renderer simply does not recurse into it. No metadata change.
- The codegen-emitted prompt class — it delegates to the engine; engine byte-identity (this change, gated by R13) plus the existing FR-010 compile-run proofs are transitively sufficient.
- Changing `recover` — it already handles nested/array recovery (FR-011).

## Architecture

`PromptField` already has `nested: OutputFormatSpec | null` (non-null for `OBJECT`) and `array: boolean`. The renderer's three skeleton/content builders (`renderJsonSkeleton`, `renderXmlSkeleton`, `inlineContent`) and the `guide` prose field-list currently treat every field as a scalar leaf. The change threads an **indent level** (and a **cycle/depth guard**) through the recursion and dispatches on `kind == OBJECT` / `array`.

### Byte formats (the pilot defines the exact bytes; the R13 corpus snapshot-pins them)

Indentation: top-level fields render at the current 2-space indent; **each nesting level adds 2 spaces**.

**exampleOnly / skeleton:**

```
JSON                            XML
{                               <Review>
  "summary": "...",               <summary>...</summary>
  "meta": {                       <meta>
    "score": 5                      <score>5</score>
  },                              </meta>
  "items": [                      <items>
    {                               <label>...</label>
      "label": "..."              </items>
    }                             <tags>{tags}</tags>
  ],                            </Review>
  "tags": [
    "{tags}"
  ]
}
```

- **Nested object** (`OBJECT`, not array): `"name": {` newline, children at +2 indent, closing `}` at the field's indent. XML: `<name>` newline, children at +2, `</name>` at the field's indent.
- **Array of objects** (`OBJECT`, array): JSON `"name": [` newline, one expanded object element at +2 indent, `]`. XML: render the element ONCE (the expanded object wrapped in `<name>…</name>`).
- **Scalar array** (non-object, array): JSON `"name": [` newline, one scalar element at +2 indent, `]`. XML: render the element ONCE (`<name>value</name>`).
- **XML arrays** show a single representative element — XML cannot signal repeat-count without an arbitrary choice. JSON arrays use `[ … ]` brackets, which do signal array-ness. This asymmetry between formats is documented in the corpus README.
- Scalar/enum leaves are unchanged (numeric-vs-quoted decision, enum first-member, placeholder fallback all as today).

**inline:** identical structure to the skeleton, but leaf values are the inline placeholders (`{instruction}` / `true | false` / `A | B | C` enum choices). Object and array fields recurse the same way; their leaves use inline content.

**guide:** the prose field-list recurses using **dotted-path leaf names** so every nested field's instruction and enum-doc is still taught, followed (as today) by the appended `exampleOnly` skeleton (which now shows the full nested structure). Examples:
- nested object leaf: `- meta.score (required): 1-5.`
- array-of-object element leaf: `- items[].label (required): …`
- scalar array: `- tags (required): …` (the array-ness is shown in the skeleton)

The container `OBJECT` field is itself listed (`- meta (required)` with its own instruction if any) before its dotted leaves, so a container-level instruction is not lost. The exact prose byte-format is finalized by the pilot and snapshot-pinned.

### Cycle / depth guard

The recursion threads a guard:
- **Cycle:** if the nested `OutputFormatSpec` instance is already on the current recursion path, render the flat `{name}` placeholder (the pre-FR-012 behavior) instead of recursing. Prevents infinite recursion on a self-referential payload VO.
- **Depth:** a shared `MAX_NEST_DEPTH` constant bounds total nesting; beyond it, render the flat `{name}` placeholder. Prevents pathological output size.

The constant value is identical across ports (defined alongside the renderer). The guard is **unit-tested per port** (a self-referential or over-deep spec cannot be expressed in the finite JSON corpus descriptor, so it is not a corpus fixture — it is a hand-built-spec unit test in each port).

## Harness integration (the byte-identity gate)

The R13 `fixtures/output-prompt-conformance/` corpus is the cross-port gate. This change:
- **Regenerates** the affected expected files via the existing snapshot-generate flow (delete the file, re-run, eyeball, commit): `json-nested`, `xml-nested` (now expanded), and `json-array` (scalar array now expands to `[ "{tags}" ]`).
- **Flips `json-nested` / `xml-nested` back to `roundTrip: true`** — their `exampleOnly` fragment is now a real nested object/array, so `recover()` must round-trip it clean (no `MALFORMED` / `LOST_*`). This proves request and response now agree on nesting.
- **Adds two new cases:** `json-deep-nest` (object-within-object, ≥3 levels — exercises indentation depth + the guide dotted-path recursion) and `json-array-of-objects` (an `OBJECT` array field with example-bearing leaves, `roundTrip: true`). Bumps the corpus count guard from 10 to 12 in all five runners.
- Updates the corpus README's "Nested objects" section to describe expansion (replacing the "renders as a flat placeholder" note) and to document the XML-array single-element convention.

The 7 purely-scalar cases (`json-scalars`, `xml-scalars`, `json-enum`, `xml-enum`, `optional-absent`, `instruction-fallback`, `unicode-example`) are unaffected — they contain no `OBJECT` or array fields, so their expected bytes do not change.

## Components / files

Per port, the renderer (one file) gains recursion + the guard:
- TS: `server/typescript/packages/render/src/prompt/output-format-renderer.ts`
- Java (shared JVM engine — **Kotlin inherits it for free**): `server/java/render/src/main/java/com/metaobjects/render/prompt/OutputFormatRenderer.java`
- C#: `server/csharp/MetaObjects.Render/Prompt/OutputFormatRenderer.cs`
- Python: `server/python/src/metaobjects/render/prompt/output_format_renderer.py`

Plus, in each port, a unit test for the cycle/depth guard (hand-built self-referential / over-deep spec → asserts the flat placeholder fallback, never throws / never infinite-loops).

Corpus (shared): regenerated `json-nested` / `xml-nested` / `json-array` expecteds + flipped roundTrip flags; new `json-deep-nest` and `json-array-of-objects` case dirs; updated top-level README; count guard 10 → 12 in all five R13 runners.

## Build order & merge strategy

Single branch, single final merge (the shared corpus would red the other ports if the pilot merged alone):

1. **TS pilot** — implement renderer recursion + guard; regenerate affected corpus expecteds + flip roundTrip; add the two new cases; bump TS count guard to 12; cycle/depth unit test.
2. **Java** (Kotlin inherits the shared JVM engine — its R13 runner must reproduce, and its count guard bumps to 12).
3. **C#.**
4. **Python.**
   Each port: implement the renderer recursion + guard, bump its R13 count guard to 12, add its cycle/depth unit test, and its R13 runner must reproduce the regenerated/new bytes byte-for-byte. A divergence is a renderer bug to fix in that port — never a corpus edit or a ledger.
5. **Close-out** — roadmap + memory; final whole-branch review; merge forward onto the current `main` tip; remove the worktree.

Each unit passes a spec-compliance + code-quality review gate (subagent-driven), and each port's runner is tamper-tested to confirm the byte-gate has teeth.

## Testing strategy

- The R13 corpus IS the cross-port byte-identity test (zero-drift, no ledger). New/regenerated expecteds become the oracle once the TS pilot generates + a human eyeballs them.
- The round-trip skew guard on `json-nested` / `xml-nested` / `json-array-of-objects` (now `roundTrip: true`) proves the expanded fragment recovers clean — request/response agreement on nesting.
- Per-port cycle/depth unit tests prove the guard (never throws, never infinite-loops, falls back to the flat placeholder).
- Determinism + count-guard(12) assertions already in every runner.

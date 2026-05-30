# FR-010 C# output-format prompt renderer — known gaps & intentional cross-port divergences

Scope: `MetaObjects.Render/Prompt/` (artifact 1 — the "produce your answer like this" fragment).
The Java renderer (`server/java/render/.../prompt/OutputFormatRenderer.java`) is the reference; the
rendered fragment is a cross-port invariant, kept byte-identical to Java/Kotlin for all realistic
inputs.

## Bounded deferrals (parity with Java/Kotlin)

- **Nested-object expansion.** A `FieldKind.Object` field renders as a `"{fieldName}"` placeholder
  rather than expanding its nested `OutputFormatSpec`. Same deferral as Java/Kotlin.
- **Output-prompt verify-conformance corpus.** There is no shared golden-file corpus for the
  rendered fragment yet (each port asserts via mirrored unit tests). Cross-port corpus wiring is a
  bounded deferral tracked across all ports.

## Intentional, documented divergence (NOT a bug — C# is the more-correct side)

- **JSON numeric-vs-quoted on Java-style numeric literals.** The JSON skeleton renders a numeric /
  boolean field's example value *unquoted* only when it is a finite number (or `true`/`false`).
  Java uses `Double.parseDouble`, which *accepts* Java source-literal forms — a suffixed `"1.5d"` /
  `"3f"` or a hex-float `"0x1p4"` — and emits them **unquoted**, producing **invalid JSON** (a latent
  Java quirk). C# uses `double.TryParse(..., NumberStyles.Float, InvariantCulture)`, which *rejects*
  those forms and falls through to a **quoted, valid-JSON** string.

  This only triggers when an `@example` for a numeric field is itself a non-JSON numeric literal —
  a pathological authoring case. Realistic numeric examples (`"0.85"`, `"42"`, `"-3.5"`, `"1e3"`)
  render byte-identically unquoted in both ports, and `NaN`/`Infinity`/`±Infinity` render quoted in
  both. C# deliberately favors valid JSON over reproducing Java's invalid output.

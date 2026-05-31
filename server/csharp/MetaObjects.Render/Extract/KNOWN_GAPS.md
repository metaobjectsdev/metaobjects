# FR-010 C# extract engine — known gaps & intentional cross-port divergences

Scope: the tolerant `Extract` pipeline (`MetaObjects.Render/Extract/`). The Java engine
(`server/java/render/.../extract/`) is the reference; `fixtures/extract-conformance/` is the
cross-port oracle. All 10 corpus cases pass.

## Bounded deferrals (parity with Java/Kotlin)

- **Nested-object extract.** Only scalar / enum / scalar-array fields are extracted. A
  `field.object` (nested record) is not descended into. Same deferral as the Java and Kotlin
  ports (tracked there as Plan 2.1/3.1). Phase 3 codegen will reject / skip nested fields
  consistently rather than emit a partial mapping.

## Intentional, documented divergences (NOT bugs)

These differ from Java on inputs the corpus does not exercise. The cross-port contract pins
*classification + canonical value* (numeric within ±1e-9), **not** byte-identical native
formatting — see the FR-010 design spec and `fr-010-plan-decisions` memory.

- **Numeric suffix / exotic literals.** Java's `Double.parseDouble` accepts `"42f"`, `"42d"`,
  and hex-float literals (→ EXTRACTED). The C# parse (`double.TryParse`, invariant culture)
  rejects them → **MALFORMED**. The load-bearing behavior — finite-only acceptance and
  `NaN`/`±Infinity` → MALFORMED — is identical across ports. (See the cross-port note in
  `Coerce.cs`.)

- **Unicode whitespace.** `JsonForgivingReader` uses `char.IsWhiteSpace`; Java uses
  `Character.isWhitespace`. They disagree on NBSP (U+00A0), U+2007, U+202F. Only reachable when
  a value/key is padded with a non-ASCII space — outside corpus coverage.

## Resolved in this port (review-driven, before Phase 1 merge)

- `ExtractMap` numeric helpers gate on actual numeric types (mirroring Java `instanceof Number`):
  a non-numeric string or a boolean returns `null` instead of throwing / coercing. Preserves the
  never-throw contract once Phase-3 `extract()` codegen makes these helpers reachable.
- `ExtractMap.AsString` / `AsStringList` format numbers with `CultureInfo.InvariantCulture`,
  matching Java `String.valueOf` (locale-independent canonical value).

## FR-011 extract hardening — current state

- **Enum coercion pipeline.** Enum extraction runs a fixed ladder: exact → normalize (`@normalize`
  mode `none | collapse | strip`, default `strip`, per-field with an `object.value`-level default)
  → `@enumAlias` → `@coerceDefault` → MALFORMED. `@default` fills an absent enum (→ `DEFAULTED`,
  which satisfies `@required`); the `DEFAULTED` classification is now emitted.
- **Nested-object extract is now supported** uniformly at the engine level (dotted child paths,
  element-wise arrays) — this supersedes the FR-010 nested-object deferral recorded above for the
  *engine*. NOTE: the codegen schema-emitters still emit a scalar-STRING placeholder for nested
  object fields (a deliberate, cross-port-consistent codegen deferral), so nested extraction is
  reachable through a hand-built / engine-level schema but is not yet auto-emitted by codegen.
- **Fuzzy matching is deliberately DEFERRED.** A reserved no-op slot exists in the pipeline
  (between `@enumAlias` and `@coerceDefault`). If added later it must be guarded integer
  Levenshtein — never float / Jaro-Winkler — to preserve cross-port determinism.
- **`@normalize` `unicode` mode is intentionally NOT offered.** Normalization is ASCII-only (enum
  members are ASCII identifiers), so it is byte-identical cross-port. A full Unicode / NFKC_Casefold
  mode was rejected: cross-port byte-identity can't be guaranteed.
- **Known cross-port caveat (out of corpus).** The pre-normalization `trim` / `strip` step uses
  each language's native trim, which differs on *non-ASCII* leading/trailing whitespace under
  `collapse` mode — C# (`Trim()`) strips Unicode whitespace, Java trims only ≤U+0020. Unreachable
  via the ASCII-only conformance corpus and irrelevant under `strip` / `none` modes; enum members
  and typical LLM whitespace are ASCII. Documented for completeness (consistent with the existing
  `char.IsWhiteSpace` note above).

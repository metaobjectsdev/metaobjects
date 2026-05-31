# FR-010 TypeScript extract engine — known gaps & intentional cross-port divergences

Scope: the tolerant `extract` pipeline (`src/extract/`). The Java engine
(`server/java/render/.../extract/`) is the cross-port reference; `fixtures/recover-conformance/`
is the oracle. All 10 corpus cases pass.

## Additive capability (TS + C#, beyond Java/Kotlin)

- **Nested-object extract is implemented.** A `FieldSpec` with a non-null `nested` schema
  (built via the `object(...)` factory) is descended into and its sub-fields classified. The
  Java/Kotlin ports defer this (their codegen emits a scalar-STRING placeholder). The C# port
  also carries the OBJECT branch, so TS and C# agree. This is **dormant** under both the
  conformance corpus (no nested fixture; the runner's schema parser never sets `nested`) and the
  FR-010 codegen (Phase 3 emits the scalar placeholder for cross-port parity), so it changes no
  shared-corpus result. If a future shared fixture adds a nested case, Java/Kotlin catch up.

## Intentional, documented divergence (NOT a bug)

The cross-port contract pins *classification + canonical value* (numbers within ±1e-9), not
byte-identical native parsing.

- **Java-style numeric suffixes / hex-float literals.** Java's `Double.parseDouble` accepts
  `"42d"` / `"42f"` and hex-float forms (→ EXTRACTED); TS uses `Number(...)` + `Number.isFinite`,
  which rejects them → **MALFORMED** (same accepted divergence the C# port records). The
  load-bearing behavior — finite-only acceptance, `NaN`/`±Infinity` → MALFORMED — is identical.

- **JS-only radix-prefixed literals are GUARDED for parity.** `Number("0x10")` is `16` in JS, but
  Java/C# reject `0x..`/`0b..`/`0o..` → MALFORMED. `parseFiniteNumber` rejects these prefixes
  explicitly so TS matches Java/C# (→ MALFORMED) rather than over-accepting. (Not a divergence —
  noted here because the guard exists precisely to prevent one.)

## Bounded deferral (parity with all ports)

- Array-of-enum is not specialized (a scalar array extracts via `asStringList`).
- `asInt`/`asLong` both return `number | null` (JS has one number type) and truncate toward zero.

## FR-011 extract hardening — current state

- **Enum coercion pipeline.** Enum extraction runs a fixed ladder: exact → normalize
  (`@normalize` mode `none | collapse | strip`, default `strip`, per-field with an
  `object.value`-level default) → `@enumAlias` → `@coerceDefault` → MALFORMED. `@default` fills
  an absent enum (→ `DEFAULTED`, which satisfies `@required`); the `DEFAULTED` classification is
  now emitted by the engine.
- **Nested/embedded-object extraction is supported** uniformly at the engine level (dotted child
  paths, element-wise arrays) — this closes the FR-010 nested deferral noted above for the
  *engine*. NOTE: the codegen schema-emitters still emit a scalar-STRING placeholder for nested
  object fields (a deliberate, cross-port-consistent codegen deferral), so nested extraction is
  reachable via a hand-built / engine-level schema but is not yet auto-emitted by codegen.
- **Fuzzy matching is deliberately DEFERRED.** A reserved no-op slot exists in the pipeline
  (between `@enumAlias` and `@coerceDefault`). If added later it must be guarded integer
  Levenshtein — never float / Jaro-Winkler — to preserve cross-port determinism.
- **`@normalize` `unicode` mode is intentionally NOT offered.** Normalization is ASCII-only (enum
  members are ASCII identifiers), so it is byte-identical cross-port. A full Unicode / NFKC_Casefold
  mode was rejected: cross-port byte-identity can't be guaranteed.
- **Known cross-port caveat (out of corpus).** The pre-normalization `trim` / `strip` step uses
  each language's native trim, which differs on *non-ASCII* leading/trailing whitespace under
  `collapse` mode — TS strips Unicode whitespace, Java trims only ≤U+0020. Unreachable via the
  ASCII-only conformance corpus and irrelevant under `strip` / `none` modes; enum members and
  typical LLM whitespace are ASCII. Documented for completeness.

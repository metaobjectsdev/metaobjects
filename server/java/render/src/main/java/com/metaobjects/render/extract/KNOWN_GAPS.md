# Java extract engine — known gaps & intentional cross-port divergences

Scope: the tolerant `extract` pipeline (`com.metaobjects.render.extract`). This Java engine is the
cross-port reference (Kotlin reuses it directly via the shared JVM render engine);
`fixtures/recover-conformance/` is the oracle. All corpus cases pass.

## FR-011 extract hardening — current state

- **Enum coercion pipeline.** Enum extraction runs a fixed ladder: exact → normalize (`@normalize`
  mode `none | collapse | strip`, default `strip`, per-field with an `object.value`-level default)
  → `@enumAlias` → `@coerceDefault` → MALFORMED. `@default` fills an absent enum (→ `DEFAULTED`,
  which satisfies `@required`); the `DEFAULTED` classification is now emitted.
- **Nested/embedded-object extraction is now supported** uniformly at the engine level (dotted child
  paths, element-wise arrays) — this closes the FR-010 nested-object deferral that the Java/Kotlin
  ports carried, *at the engine level*. NOTE: the codegen schema-emitters still emit a scalar-STRING
  placeholder for nested object fields (a deliberate, cross-port-consistent codegen deferral), so
  nested extraction is reachable through a hand-built / engine-level schema but is not yet auto-emitted
  by codegen.
- **Fuzzy matching is deliberately DEFERRED.** A reserved no-op slot exists in the pipeline
  (between `@enumAlias` and `@coerceDefault`). If added later it must be guarded integer
  Levenshtein — never float / Jaro-Winkler — to preserve cross-port determinism.
- **`@normalize` `unicode` mode is intentionally NOT offered.** Normalization is ASCII-only (enum
  members are ASCII identifiers), so it is byte-identical cross-port. A full Unicode / NFKC_Casefold
  mode was rejected: cross-port byte-identity can't be guaranteed.
- **Known cross-port caveat (out of corpus).** The pre-normalization `trim` / `strip` step uses each
  language's native trim, which differs on *non-ASCII* leading/trailing whitespace under `collapse`
  mode — Java `trim()` removes only code points ≤U+0020, whereas TS / C# / Python strip the full
  Unicode whitespace set. Unreachable via the ASCII-only conformance corpus and irrelevant under
  `strip` / `none` modes; enum members and typical LLM whitespace are ASCII. Documented for
  completeness.

## Intentional, documented divergences (NOT bugs)

The cross-port contract pins *classification + canonical value* (numbers within ±1e-9), not
byte-identical native parsing. The sibling ports (TS / C# / Python) record their parsing
divergences against this Java reference:

- **Numeric suffix / hex-float literals.** Java's `Double.parseDouble` accepts `"42d"` / `"42f"`
  and hex-float forms (→ EXTRACTED); the data-oriented ports reject them → MALFORMED. The
  load-bearing behavior — finite-only acceptance, `NaN` / `±Infinity` → MALFORMED — is identical.
- **Whitespace trimming.** `Character.isWhitespace` / `trim()` recognize a narrower set than the
  other ports (see the cross-port caveat above). Only reachable when a value/key is padded with a
  non-ASCII space — outside corpus coverage.

# Java extract engine — known gaps & intentional cross-port divergences

Scope: the tolerant `extract` pipeline (`com.metaobjects.render.extract`). This Java engine is the
cross-port reference (Kotlin reuses it directly via the shared JVM render engine);
`fixtures/extract-conformance/` is the oracle. All corpus cases pass.

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
- **`strip` concatenates a delimited scalar — guarded at authoring time, not at coercion.**
  `strip` (the default) keeps only `[A-Z0-9]`, which is what makes `"SOCIAL-ATTACK"` match the
  member `SOCIAL_ATTACK`. The same erasure means a *delimited* value collapses into one token, and
  where a vocabulary contains a member equal to the concatenation of others that token coerces
  SUCCESSFULLY: `values = {READ, WRITE, READWRITE}`, input `"read|write"` → `READWRITE`, reported
  EXTRACTED (not MALFORMED) with a plausible wrong value. This is inherent to `strip` and cannot be
  fixed at coercion time — `"read-write"` legitimately means `READWRITE`, so the two readings are
  genuinely indistinguishable from the value alone. The collision IS detectable from metadata, so
  the **loader** warns the author instead: `WARN_ENUM_NORMALIZE_AMBIGUOUS`, emitted by all four
  loaders when a `field.enum`'s own `@values` contains a member that word-breaks into two or more
  other members and the effective mode is `strip`. `collapse` is immune (it folds only `[\s_-]+`,
  so a `|` survives and the value fails cleanly) and is the documented fix for a vocabulary that
  can receive delimited input. Corpus: `fixtures/conformance/warning-enum-normalize-ambiguous`
  (fires) and `enum-normalize-ambiguous-inherited-collapse` (must not fire — the field-tier and
  owning-object-tier resolution discriminator).

  **Two known precision limits of that guard** (identical in all four ports, so not a conformance
  divergence — a bounded detector, not a proof):
  (a) the word-break keeps the FEWEST-segment segmentation, so a member that also equals another
  member's stripped form suppresses the ≥2-segment check — `{READ, WRITE, READ_WRITE, READWRITE}`
  does NOT warn even though `"read|write"` → `READWRITE` is exactly the hazard;
  (b) the check is own-`@values`-only (so one hazard yields one warning at the declaring node), so
  an abstract enum that owns the `@values` while a *consumer* overrides `@normalize` to `strip`
  warns nowhere — the node with the hazardous mode owns no vocabulary.
  Both under-report; neither produces a false warning.

- **Splitting a delimited scalar into array elements is intentionally NOT offered** (no
  `@delimiter` attribute; `Extract.java`'s array branch wraps a non-list presence as a ONE-element
  array and will keep doing so). Raised by a downstream consumer whose LLM emitted `attr="A|B|C"`
  in an XML attribute. Rejected on four grounds: (1) no schema language makes "delimited scalar" a
  *data-model* property — the declarative forms that exist (XSD `xs:list`, OpenAPI `pipeDelimited`,
  Swagger `collectionFormat: pipes`) live at wire boundaries where real lists are physically
  impossible, as fixed closed styles, never a free delimiter character; everywhere else it is a
  code-level adapter; (2) the ecosystem moved the other way — OpenAPI 3 demoted delimited styles to
  non-default legacy, and LLM structured-output libraries moved to JSON-schema real lists; (3) no
  declarative system escapes an embedded delimiter (XSD's normative answer is "then you cannot use
  `xs:list`"), and CSV-style quoting fails this engine's cross-port byte-identity bar for the same
  reason Unicode `@normalize` was rejected above; (4) decisively — the generated output-format
  prompt emits every field as a child element or JSON array, so it could never have *instructed* a
  delimited attribute: such a value is model drift from a contract we never issued, i.e. a
  tolerance concern, not a shape to bless as declarable. ADR-0037 step 0 also fails the attribute:
  enum members match `^[A-Za-z_][A-Za-z0-9_]*$`, so a candidate split is checkable from existing
  `@values` — the only thing an attribute would add is free-string arrays with an author-chosen
  delimiter, which is exactly the unsafe domain. **The supported way to express a multi-valued
  response field is repeated elements / a JSON array plus `field.enum` + `isArray: true`,** which
  already gives per-element coercion with partial-array survival.

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

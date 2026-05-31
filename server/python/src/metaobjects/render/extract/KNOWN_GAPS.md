# FR-010 Python extract engine — known gaps & intentional cross-port divergences

Scope: the tolerant `extract` pipeline (`metaobjects/render/extract/`). The Java engine
(`server/java/render/.../extract/`) is the cross-port reference; `fixtures/recover-conformance/`
is the oracle. All 10 corpus cases pass.

## Additive capability (TS + C# + Python, beyond Java/Kotlin codegen deferral)

- **Nested-object extract is implemented** — a `FieldSpec` with a nested `ExtractSchema`
  (the `object_(...)` factory) is descended into, classifying sub-fields with dotted paths
  (`meta.n`). Mirrors the Java/C# `extract` OBJECT recursion. Dormant under the corpus (no
  nested fixture) and under FR-010 codegen (which emits a scalar placeholder for parity), so
  it changes no shared-corpus result.

## Intentional, documented divergences (NOT bugs)

The cross-port contract pins *classification + canonical value* (numbers ±1e-9), not byte-
identical native parsing.

- **Java-style numeric suffixes / hex-float literals.** Java's `Double.parseDouble` accepts
  `"42d"`/`"42f"` and hex-float forms (→ EXTRACTED); Python rejects them → **MALFORMED** (same
  accepted divergence the C#/TS ports record). The load-bearing behavior — finite-only,
  `NaN`/`±Infinity` → MALFORMED — is identical.

- **ASCII-numeric gate (parity guard, not a divergence).** Python's `int()`/`float()` accept
  underscore digit grouping (`"1_000"`, PEP 515), Unicode digits (`"１２３"`, `"٣"`), and radix
  prefixes (`"0x10"`) that Java/C# reject. `coerce` gates numeric strings on an ASCII-only
  pattern so these all classify **MALFORMED**, matching the strict cross-port behavior (C#).

- **NBSP-trailing numerics.** `"1 "` → Python `str.strip()` removes the NBSP (Unicode
  whitespace) leaving `"1"` → EXTRACTED, as does C# `Trim()`; Java `trim()` keeps it →
  MALFORMED. A pre-existing Java/C# disagreement on whitespace trimming; Python sides with C#.
  Not corpus-exercised.

## NIT (no cross-port consensus, no corpus case)

- **Out-of-int64-range integers** (e.g. `"9999999999999999999"`): Python has arbitrary-precision
  ints (EXTRACTED with the exact value); Java saturates to `Long.MAX_VALUE`, C# wraps on the
  cast. The three ports already disagree, so there is no single canonical value to match. No
  corpus int approaches 2^63. Left as-is.

## Python-specific defensive bound

- **JSON nesting depth cap (`_MAX_DEPTH = 100`).** Python's recursion limit is far below the
  JVM/.NET stack, so a pathologically deep input (hundreds of nested brackets) would raise
  `RecursionError` — violating the never-throws contract. Past the cap the container is skipped
  (string-aware, non-recursive) and recorded as garbled (→ MALFORMED). Far above any realistic
  payload nesting; the other ports rely on their larger native stacks instead.

## Bounded deferral (parity with all ports)

- Array-of-enum is not specialized (a scalar array extracts via `as_string_list`).
- `as_int`/`as_long` are identical (`Optional[int]`; Python has one int type), truncating toward zero.

## FR-011 extract hardening — current state

- **Enum coercion pipeline.** Enum extraction runs a fixed ladder: exact → normalize (`@normalize`
  mode `none | collapse | strip`, default `strip`, per-field with an `object.value`-level default)
  → `@enumAlias` → `@coerceDefault` → MALFORMED. `@default` fills an absent enum (→ `DEFAULTED`,
  which satisfies `@required`); the `DEFAULTED` classification is now emitted.
- **Nested/embedded-object extraction is now supported** uniformly at the engine level (dotted child
  paths via `meta.n`, element-wise arrays) — this is the general FR-011 form of the additive
  capability noted above, now matched across all engine ports. NOTE: the codegen schema-emitters
  still emit a scalar-STRING placeholder for nested object fields (a deliberate, cross-port-consistent
  codegen deferral), so nested extraction is reachable through a hand-built / engine-level schema but
  is not yet auto-emitted by codegen.
- **Fuzzy matching is deliberately DEFERRED.** A reserved no-op slot exists in the pipeline
  (between `@enumAlias` and `@coerceDefault`). If added later it must be guarded integer
  Levenshtein — never float / Jaro-Winkler — to preserve cross-port determinism.
- **`@normalize` `unicode` mode is intentionally NOT offered.** Normalization is ASCII-only (enum
  members are ASCII identifiers), so it is byte-identical cross-port. A full Unicode / NFKC_Casefold
  mode was rejected: cross-port byte-identity can't be guaranteed.
- **Known cross-port caveat (out of corpus).** The pre-normalization `trim` / `strip` step uses
  each language's native trim, which differs on *non-ASCII* leading/trailing whitespace under
  `collapse` mode — Python (`str.strip()`) strips Unicode whitespace, Java trims only ≤U+0020.
  Unreachable via the ASCII-only conformance corpus and irrelevant under `strip` / `none` modes;
  enum members and typical LLM whitespace are ASCII. Documented for completeness (consistent with
  the NBSP-trailing note above).

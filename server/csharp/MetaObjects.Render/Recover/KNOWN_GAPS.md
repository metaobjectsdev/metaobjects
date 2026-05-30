# FR-010 C# recover engine — known gaps & intentional cross-port divergences

Scope: the tolerant `Recover` pipeline (`MetaObjects.Render/Recover/`). The Java engine
(`server/java/render/.../recover/`) is the reference; `fixtures/recover-conformance/` is the
cross-port oracle. All 10 corpus cases pass.

## Bounded deferrals (parity with Java/Kotlin)

- **Nested-object recover.** Only scalar / enum / scalar-array fields are recovered. A
  `field.object` (nested record) is not descended into. Same deferral as the Java and Kotlin
  ports (tracked there as Plan 2.1/3.1). Phase 3 codegen will reject / skip nested fields
  consistently rather than emit a partial mapping.

## Intentional, documented divergences (NOT bugs)

These differ from Java on inputs the corpus does not exercise. The cross-port contract pins
*classification + canonical value* (numeric within ±1e-9), **not** byte-identical native
formatting — see the FR-010 design spec and `fr-010-plan-decisions` memory.

- **Numeric suffix / exotic literals.** Java's `Double.parseDouble` accepts `"42f"`, `"42d"`,
  and hex-float literals (→ RECOVERED). The C# parse (`double.TryParse`, invariant culture)
  rejects them → **MALFORMED**. The load-bearing behavior — finite-only acceptance and
  `NaN`/`±Infinity` → MALFORMED — is identical across ports. (See the cross-port note in
  `Coerce.cs`.)

- **Unicode whitespace.** `JsonForgivingReader` uses `char.IsWhiteSpace`; Java uses
  `Character.isWhitespace`. They disagree on NBSP (U+00A0), U+2007, U+202F. Only reachable when
  a value/key is padded with a non-ASCII space — outside corpus coverage.

## Resolved in this port (review-driven, before Phase 1 merge)

- `RecoverMap` numeric helpers gate on actual numeric types (mirroring Java `instanceof Number`):
  a non-numeric string or a boolean returns `null` instead of throwing / coercing. Preserves the
  never-throw contract once Phase-3 `recover()` codegen makes these helpers reachable.
- `RecoverMap.AsString` / `AsStringList` format numbers with `CultureInfo.InvariantCulture`,
  matching Java `String.valueOf` (locale-independent canonical value).

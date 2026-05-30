# FR-010 TypeScript recover engine — known gaps & intentional cross-port divergences

Scope: the tolerant `recover` pipeline (`src/recover/`). The Java engine
(`server/java/render/.../recover/`) is the cross-port reference; `fixtures/recover-conformance/`
is the oracle. All 10 corpus cases pass.

## Additive capability (TS + C#, beyond Java/Kotlin)

- **Nested-object recover is implemented.** A `FieldSpec` with a non-null `nested` schema
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
  `"42d"` / `"42f"` and hex-float forms (→ RECOVERED); TS uses `Number(...)` + `Number.isFinite`,
  which rejects them → **MALFORMED** (same accepted divergence the C# port records). The
  load-bearing behavior — finite-only acceptance, `NaN`/`±Infinity` → MALFORMED — is identical.

- **JS-only radix-prefixed literals are GUARDED for parity.** `Number("0x10")` is `16` in JS, but
  Java/C# reject `0x..`/`0b..`/`0o..` → MALFORMED. `parseFiniteNumber` rejects these prefixes
  explicitly so TS matches Java/C# (→ MALFORMED) rather than over-accepting. (Not a divergence —
  noted here because the guard exists precisely to prevent one.)

## Bounded deferral (parity with all ports)

- Array-of-enum is not specialized (a scalar array recovers via `asStringList`).
- `asInt`/`asLong` both return `number | null` (JS has one number type) and truncate toward zero.

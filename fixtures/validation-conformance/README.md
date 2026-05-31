# validation-conformance

A **behavioral** cross-port corpus for generated input validation. The metamodel
expresses field-input constraints two ways — field attrs (`@required`,
`@maxLength`) and explicit `validator.*` subtypes (`validator.{length,regex,numeric,array}`
with `@min` / `@max` / `@pattern`). Each port's codegen should enforce them in
its generated input-validation artifact (TS Zod `InsertSchema`, C# DataAnnotations,
Python Pydantic `Field`, Java/Kotlin jakarta.validation). This corpus pins the
canonical accept/reject behavior so the ports cannot silently drift.

## Shape

```
meta.json    # one entity `Account` (package acme::auth) exercising each constraint once
cases.json   # [{ name, payload, expectValid }] — single-source boolean verdicts
README.md
```

`meta.json` `Account` fields, one constraint each:

| field   | constraint                                              |
|---------|---------------------------------------------------------|
| `id`    | `field.long` + `identity.primary @generation=increment` (auto, excluded from insert) |
| `name`  | `field.string` `@required` + `@maxLength: 10`           |
| `code`  | `field.string` + `validator.length @min=3` + `validator.regex @pattern="^[A-Z]+$"` |
| `score` | `field.int` + `validator.numeric @min=0 @max=100`       |
| `tags`  | `field.string isArray` + `validator.array @min=1 @max=3` |

## Behavioral contract — payload → boolean verdict

Each port's runner builds the **generated** validation artifact for `Account`,
runs each `cases.json` payload through it, maps the native result to a boolean
`valid`, and asserts `valid === expectValid`. Verdict normalization per port:
Zod `safeParse().success`; jakarta `validator.validate(dto).isEmpty()`; Pydantic
construct-or-`ValidationError`; .NET `Validator.TryValidateObject`. The booleans
are single-source — all ports assert the same `expectValid`.

## Single-violation design

Beyond the `valid-baseline` (everything satisfied → `true`), every other case
violates **exactly one** constraint while keeping everything else valid. That
makes a simple boolean verdict gate each constraint individually: if a port fails
to enforce constraint X, its `violates-X` payload is wrongly accepted and only
that case fails — pointing straight at the unenforced constraint.

Cases: `valid-baseline` (true), then `name-missing`, `name-too-long`,
`code-too-short`, `code-pattern-mismatch`, `score-below-min`, `score-above-max`,
`tags-empty`, `tags-too-many` (all false).

## CI gate

All five port runners are wired into `.github/workflows/conformance.yml` (the
non-Docker conformance job) — TS/C#/Java/Python under the `conformance` matrix,
Kotlin under `conformance-kotlin` — so every PR and push asserts byte-identical
boolean verdicts across all five generated validation artifacts.

## Notes

- **Cross-engine-safe regex.** The `code` pattern `^[A-Z]+$` is a plain ASCII
  character class with anchors only — it behaves identically across the JS,
  Java, .NET, and Python regex engines. No PCRE-only constructs are used.
- **Numeric field is `int`.** jakarta `@Min`/`@Max` are long-valued; keeping
  `score` an int avoids decimal-string parsing nuance. A decimal-range case is a
  deferred enhancement.
- **Deferred richer verdict.** A per-field/per-constraint
  `expectViolations: [{ field, kind }]` is a deferred enhancement. The boolean
  verdict avoids per-port native-error mapping while still pinning each
  constraint via the single-violation design.

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
| `code`  | `field.string` + `validator.length @min=3` + `validator.regex @pattern="[A-Z]+"` (un-anchored on purpose — see the full-match pin below) |
| `score` | `field.int` + `validator.numeric @min=0 @max=100`       |
| `tags`  | `field.string isArray` + `validator.array @min=1 @max=3` |
| `label` | `field.string` + `@maxLength: 8` + `validator.length @max=4` (both length bounds on one field — see the strictest-wins pin below) |
| `note`  | `field.string` `@required` + `validator.length @min=0` (an explicit opt-out of the FR-036 Pin 1 implicit floor — see the authority pin below) |

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
`tags-empty`, `tags-too-many` (all false). Every payload also carries a valid
`note` (`"ok"`) so these cases keep violating exactly one constraint (single-
violation design, below) — `note`'s own constraint is exercised by the
`note-*` pin cases.

FR-036 pin cases (the two semantic pins + the length-precedence pin):

- `name-empty` (`""` → **false**) and `name-whitespace` (`"   "` → **true**) pin
  **required string = non-empty** (FR-036 Ruling 1): a `@required` string rejects
  `null`/`""` but *accepts* whitespace-only. No port may trim (`@NotBlank`,
  `[Required]`-default) or emit nothing for a required string.
- `pattern-unanchored` (`code="xxABCyy"` → **false**) pins **`validator.regex`
  `@pattern` = full-match** (FR-036 Ruling 2): the whole value must match the
  authored (un-anchored) `[A-Z]+`. Ports whose regex primitive searches
  (JS `RegExp.test`, Pydantic `pattern=`) must anchor as `^(?:…)$`; `matches()`
  (jakarta) / `[RegularExpression]` (.NET) are already full-match.
- `both-length-ok` (`label="1234"` → **true**) and `both-length-bounds`
  (`label="12345"` → **false**) pin **`@maxLength` × `validator.length @max`
  precedence = strictest-wins**: effective max = `min(@maxLength, validator.max)`
  (here `min(8, 4) = 4`), so a 5-char value is rejected even though `@maxLength`
  alone (8) would admit it.
- `note-empty-allowed` (`note=""` → **true**) and `note-missing` (`note`
  absent → **false**) pin **an explicitly authored `validator.length @min` is
  AUTHORITATIVE over the FR-036 Pin 1 implicit non-empty floor** (#224 /
  ADR-0044): `note` is `@required` with an explicit `validator.length @min: 0`,
  so the empty string is accepted (the opt-out) while the field must still be
  *provided* — `@required`'s NOT NULL half is untouched by the opt-out, so an
  absent `note` is still rejected. No port may apply the Pin 1 floor (min 1)
  when an author has explicitly said `@min: 0`.

## `field.uri` / `field.inet` strict contract (#234, ADR-0037 — Contract A)

`Account` carries two OPTIONAL fields — `website` (`field.uri`) and `sourceIp`
(`field.inet`) — pinning the canonical STRICT accept/reject set. Optional so every
pre-#234 case (which omits them) is untouched.

- **`field.uri` = an absolute URI carrying a scheme** (WHATWG / Zod `.url()` /
  Pydantic `AnyUrl`-aligned). ACCEPT `https://a.com`, `ftp://…`, `mailto:a@b`,
  `urn:isbn:…`, and leading/trailing-whitespace-padded (WHATWG trims). REJECT a
  scheme-less/relative reference (`example.com`, `/path`), garbage (`not a url`),
  and an empty authority (`http://`).
- **`field.inet` = an IPv4 or IPv6 LITERAL only** — no hostnames (**never a DNS
  lookup**), no CIDR (`1.2.3.4/24`), no padding, no out-of-range octet
  (`256.1.1.1`). ACCEPT `192.168.0.1`, `::1`, `2001:db8::1`.

Deliberately UNPINNED gray zone (parser-specific, excluded from the probe set,
like the corpus already does for regex/length): a raw space in a URI *path*
(`https://a.com/a b` — WHATWG percent-encodes, `java.net.URI` throws); and
value-normalization-on-accept differences (e.g. Pydantic appends a trailing
slash). The corpus pins a FINITE probe set, never total accept-set equality.

**Verdict normalization for native-typed fields.** TS binds `field.uri`/`field.inet`
to a plain `string` + a separable Zod check, so `safeParse().success` already fuses
bind + validate. The other ports bind to a NATIVE type (Pydantic `AnyUrl`/
`IPvAnyAddress`; Java/Kotlin `java.net.URI`/`InetAddress`; C# `System.Uri`/
`IPAddress`) whose parser IS the validator — a malformed value fails to *bind*.
So the rule is:

> `valid := (the payload binds to the port's generated wire-input artifact) AND
> (the artifact's declared validator reports no violations)`. **A bind failure IS
> an invalid verdict** — semantically honest: a request whose body fails to
> deserialize returns 400 exactly as a validation failure does.

Python fuses both (Pydantic construct-or-`ValidationError`); the Java/Kotlin/C#
runners wrap the bind step so a native-parse failure maps to `valid=false`.

## CI gate

All five port runners are wired into `.github/workflows/conformance.yml` (the
non-Docker conformance job) — TS/C#/Java/Python under the `conformance` matrix,
Kotlin under `conformance-kotlin` — asserting byte-identical boolean verdicts
across all five generated validation artifacts.

That workflow runs on release tags and on `workflow_dispatch`, not on every PR
(pull requests get the leak scan only, for hosted-minutes cost). Push-to-`main`
coverage comes from the self-hosted `local-ci.yml`, and `scripts/ci-local.sh`
reproduces the gate locally. See [`docs/CONFORMANCE.md`](../../docs/CONFORMANCE.md).

## Notes

- **Cross-engine-safe regex.** The `code` pattern `[A-Z]+` is a plain ASCII
  character class — it behaves identically across the JS, Java, .NET, and Python
  regex engines. No PCRE-only constructs are used. It is deliberately left
  **un-anchored** in the metadata so the `pattern-unanchored` case can convict
  the full-match pin: a searching engine accepts `"xxABCyy"`, a full-match engine
  rejects it. Every port must render full-match semantics (see the pin cases).
- **Numeric field is `int`.** jakarta `@Min`/`@Max` are long-valued; keeping
  `score` an int avoids decimal-string parsing nuance. A decimal-range case is a
  deferred enhancement.
- **Deferred richer verdict.** A per-field/per-constraint
  `expectViolations: [{ field, kind }]` is a deferred enhancement. The boolean
  verdict avoids per-port native-error mapping while still pinning each
  constraint via the single-violation design.

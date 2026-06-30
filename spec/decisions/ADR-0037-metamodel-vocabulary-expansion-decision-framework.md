# ADR-0037: Metamodel vocabulary expansion — the decision framework

## Status

**Accepted** (2026-06-30).

## Context

When a new concept needs to enter the metamodel, there is a recurring choice: should it be a **subtype**, an **attribute**, a **string format**, a **derived value** (no vocabulary at all), or the **physical escape hatch**? We kept making this call ad-hoc and getting it wrong — proposing `field.localDateTime` when `@localTime` was right, listing `uuid` as a `@format` when it is a subtype. The governing principles already existed but were scattered across ADR-0013 (physical vs logical), ADR-0023 (derive, don't invent), ADR-0001 (build-time native binding), and the "base type + semantic tag beats type proliferation" throughline — so nothing forced a consistent answer.

This ADR consolidates them into **one ordered decision procedure**. It is the governance rule for ANY metamodel vocabulary expansion — by core contributors and by adopters who register their own providers. It introduces no new vocabulary; it decides how new vocabulary is shaped.

## Decision — the ordered test

To express a new concept **X**, apply these in order. **The first that matches decides.**

### 0. Derivable from existing metadata? → derive it; add NOTHING. (ADR-0023)
If X can be computed from the existing subtype + attributes (`isArray`, `@maxLength`, …) + structure (`identity.reference`, relationships) + naming, **generate it in codegen — do not add vocabulary.** Adding an attr/subtype for something the metadata already implies is the cardinal error.
- `text[]`/`uuid[]` ← `field.string`/`field.uuid` + `isArray`. `varchar(n)` ← `@maxLength`. FK columns ← `identity.reference`. Validator chains ← field constraints.

### 1. Physical-only? → the `@dbColumnType` escape hatch. (ADR-0013)
**The physical-vs-logical test: does X change the field's native type or its meaning?**
- **No — it's a pure DB-storage detail, logical type and native binding unchanged** → it is the narrow physical passthrough (`@dbColumnType`), used sparingly for genuine DB-specific needs the metamodel doesn't model (the jsonb open-bag; exotic Postgres types like `tsvector`). NOT first-class vocabulary.
- **Yes — it changes the native type or the meaning** → it is logical; go to step 2.

### 2. Logical: a different KIND of value, or the SAME kind with a modifier?
- **Different kind of value → SUBTYPE.** A distinct semantic concept, typically with its own native type and/or column type, not reducible to "an existing type plus a property."
  - Test: it reads as *"a different sort of thing,"* and binds to a native type that is **not** the base type's.
  - `field.uuid` (native `UUID`/`Guid`/`uuid.UUID` + `uuid` column), `field.currency` (money, integer minor units), `field.enum` (closed symbol set), `field.decimal` (exact, distinct from float), `field.bytes` (binary).
- **Same kind of value, orthogonal modifier → ATTRIBUTE.** Still fundamentally the base type, just constrained or configured.
  - Test: it reads as *"a `<base>` that is also / happens to be X."*
  - `@maxLength` (a string, bounded), `@precision`/`@scale` (a decimal, sized), `@format` (a string, shaped), `@localTime` (a timestamp, zone-flagged), `@currency`/`@locale` (a currency, configured).

### 3. Inside "attribute": shape the value-space.
- **Closed enum** → register with `allowedValues` (cross-port byte-gated, ADR-0036 Wave 1).
- **Boolean modifier** → default **false/absent = the common case**; the flag marks the **exception** (`@localTime: true` = the rare naive timestamp). Never a default-true opt-out.
- **Open / format-validated** (ISO 4217, BCP 47) → no `allowedValues`; validated by format.

## The format-vs-subtype rule (a worked instance of step 2 — because we got it wrong)

A semantic **string format** (email, url, hostname, ipv4, ipv6) is the **same kind** of value — a string, `varchar` storage, native type `string` in every port — so it is a modifier → **attribute** (`@format`), never a subtype.

**Do not be misled by JSON-world tools** (JSON Schema, Zod, class-validator) that call `uuid` and `date-time` "formats." They do so only because JavaScript/JSON has no native UUID or instant type — to them everything is a string. MetaObjects binds metadata→native types across five languages (ADR-0001), so the operative test is:

> **Does X have a distinct native type across the ports?** If yes → SUBTYPE. If no (it's a `string` everywhere, just validated) → attribute (`@format`).

`uuid` → distinct native type (`UUID`/`Guid`) → **`field.uuid` subtype**. `email` → `string` everywhere → **`@format` attribute**. The rule in one line: **format = string-shape validation with the native type unchanged; subtype = a distinct native type.**

## Consistency corollaries

- **Base type + semantic tag beats type proliferation.** Never mint a sibling type for a property — there is no `field.shortString`/`field.longString`; that is `@maxLength`. Collapsing distinct native types into one (the OpenAPI-Generator trap) is the opposite failure — avoid both.
- **Orthogonal modifiers live on the base type**, not a new subtype (`@localTime` on `field.timestamp`, not `field.localDateTime`).
- **Same concept → same attr name; never same-name-different-meaning.** When an existing attr name means something else on another type (the `@format` on `template.*` = output format), give the new one a distinct name rather than overload it.
- **Every new first-class element requires** a registered provider + a `registry-conformance` fixture (ADR-0023 strict provenance), and — for closed enums — `allowedValues` in the gate (ADR-0036).

## Worked examples (the decisions this framework reproduces)

| Concept | 0: derivable? | 1: physical? | 2: kind vs modifier | Result |
|---|---|---|---|---|
| array of string | **yes** (`isArray`) | — | — | derive `text[]` — no vocabulary |
| `varchar(n)` length | **yes** (`@maxLength`) | — | — | derive |
| jsonb open bag | no | **physical** (string native) | — | `@dbColumnType: jsonb` |
| UUID | no | logical (UUID native) | different kind | **subtype** `field.uuid` |
| money | no | logical | different kind | **subtype** `field.currency` |
| binary | no | logical (bytes native) | different kind | **subtype** `field.bytes` |
| email / url | no | logical (validation) | same kind (string) + modifier | **attribute** `@format` |
| naive timestamp | no | logical (LocalDateTime native) | same kind (date+time) + modifier | **attribute** `@localTime` |
| decimal precision | no | logical | same kind (decimal) + modifier | **attribute** `@precision`/`@scale` |

## Consequences

- Vocabulary expansion becomes a **procedure, not a guess** — reducing type proliferation, same-name overloads, and wrong subtype/attribute calls.
- It binds **core contributors and adopters with custom providers** alike. The `metaobjects-audit` skill checks new/custom vocabulary against this framework (advisory), and the agent-context surfaces carry it so every adopter extending the metamodel applies the same rule.
- This ADR is the source of truth; ADR-0013/0023/0001 remain the underlying principles it sequences. ADR-0036's per-decision calls (`field.uuid` over `@format:uuid`, `@localTime` over `field.localDateTime`) are instances of this framework.

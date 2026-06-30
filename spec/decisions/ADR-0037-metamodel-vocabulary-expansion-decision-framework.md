# ADR-0037: Metamodel vocabulary expansion — the decision framework

## Status

**Accepted** (2026-06-30). Revised same day to make the subtype test **behavioral** (own native type **or** behavior **or** attributes — not merely "distinct native type") and to charter **`@kind`** as the one structural-variant-within-a-subtype axis. This split the "string formats" set: `url`/`uri` and `ip` are subtypes (they have native types + behavior), only `email`/`hostname` are `@stringFormat` validated strings.

## Context

When a new concept needs to enter the metamodel, there is a recurring choice: should it be a **subtype**, an **attribute**, a **string format**, a **derived value** (no vocabulary at all), or the **physical escape hatch**? We kept making this call ad-hoc and getting it wrong — proposing `field.localDateTime` when `@localTime` was right, listing `uuid` as a `@format` when it is a subtype. The governing principles already existed but were scattered across ADR-0013 (physical vs logical), ADR-0023 (derive, don't invent), ADR-0001 (build-time native binding), and the "base type + semantic tag beats type proliferation" throughline — so nothing forced a consistent answer.

This ADR consolidates them into **one ordered decision procedure**. It is the governance rule for ANY metamodel vocabulary expansion — by core contributors and by adopters who register their own providers. It introduces no new vocabulary; it decides how new vocabulary is shaped.

## Decision — the ordered test

**The guiding question is always semantic behavior, not surface storage.** Don't ask "is X a string / a number / a date?" — ask "**what does X *do*?** Does it need its own behavior, attributes, or native type (then it's a *thing* — a subtype)? Is it a structural variant of an existing thing (a *kind*)? Or does it just modify, validate, or configure an existing type (an *attribute*)?" Shape follows behavior. The steps below operationalize that question; apply them in order — **the first that matches decides.**

### 0. Derivable from existing metadata? → derive it; add NOTHING. (ADR-0023)
If X can be computed from the existing subtype + attributes (`isArray`, `@maxLength`, …) + structure (`identity.reference`, relationships) + naming, **generate it in codegen — do not add vocabulary.** Adding an attr/subtype for something the metadata already implies is the cardinal error.
- `text[]`/`uuid[]` ← `field.string`/`field.uuid` + `isArray`. `varchar(n)` ← `@maxLength`. FK columns ← `identity.reference`. Validator chains ← field constraints.

### 1. Physical-only? → the `@dbColumnType` escape hatch. (ADR-0013)
**The physical-vs-logical test: does X change the field's native type or its meaning?**
- **No — it's a pure DB-storage detail, logical type and native binding unchanged** → it is the narrow physical passthrough (`@dbColumnType`), used sparingly for genuine DB-specific needs the metamodel doesn't model (the jsonb open-bag; exotic Postgres types like `tsvector`). NOT first-class vocabulary.
- **Yes — it changes the native type or the meaning** → it is logical; go to step 2.

### 2. Is X its own *thing* (a subtype), a *variant* of a thing (`@kind`), or a *modifier* of one (an attribute)?

**2a. Its own thing → SUBTYPE.** X warrants a subtype when it has **any** of: a **distinct native type** in the target languages, its **own behavior/logic**, or its **own attributes** worth carrying. The subtype is the metamodel's *extension point* — the only shape that owns custom codegen, custom validation, and custom child attributes. The test is **behavioral, not storage-based**: a value that happens to serialize as a string is still a subtype if the *concept* has a native type or behavior.
  - `field.uuid` (native `UUID`/`Guid`), `field.currency` (money, minor-unit arithmetic), `field.decimal` (exact), `field.bytes` (binary), `field.uri` (native `URI`/`Uri`; parses scheme/authority/path), `field.inet` (native IP type; version/CIDR; PG `inet`).
  - Litmus: *"would I want to attach behavior or extra attributes to this later?"* If plausibly yes → subtype. (A `field.uri` can grow a `@requireAbsolute` attr; an `@stringFormat: email` can't grow anything — it's a leaf constraint.)

**2b. A structural variant *within* a subtype → `@kind`.** When a subtype has variants that change the *generated shape* but share its native type and behavior, discriminate them with the `@kind` attribute (its value-set is scoped per type/subtype and byte-gated). `@kind` is the metamodel's one **structural-variant axis** — reserved for exactly this, never a catch-all.
  - `source.rdb @kind` = table/view/materializedView/storedProc/tableFunction; `template.output @kind` = document/email; (planned) `field.uri @kind` = url/urn (a URL locates, a URN names — both URIs); `field.inet @kind` = ipv4/ipv6.
  - A variant qualifies for `@kind` only if it lives **inside** a subtype that already earned its place by 2a. `@kind` on a plain `field.string` is wrong — a plain string isn't a behavioral subtype, so there's nothing for the kinds to be *kinds of*.

**2c. Otherwise X modifies/constrains/configures an existing type → ATTRIBUTE.** X is not its own concept — it adjusts one. Pick the attribute shape by what X is:
  - **Boolean exception-flag** (the common case is *absent*) → boolean attr; the flag marks the exception. `@localTime`, `@unique`, `@required`. Never a default-true opt-out.
  - **Closed set of choices** → enum attr with `allowedValues` (cross-port byte-gated, ADR-0036 Wave 1).
  - **Validation constraint** that narrows the value without changing its type/structure → a validation/format attr. `@stringFormat` (email/hostname), `@maxLength`. The thing being validated stays a plain `<base>`; there is no behavior to own (or it would be 2a).
  - **Configuration value** (sizing, locale, precision) → a typed attr. `@precision`/`@scale`, `@currency`/`@locale`. Open/format-validated configs (ISO 4217, BCP 47) carry no `allowedValues`.

## The format-vs-subtype rule (a worked instance of step 2 — because we got it wrong, twice)

The set of "string formats" the JSON-world lumps together (uuid, url, email, hostname, ipv4, ipv6) **does not survive the behavioral test — it splits.** Run each through 2a ("own native type or behavior?"):

| "format" | native type in the ports? | own behavior? | → |
|---|---|---|---|
| uuid | `UUID`/`Guid`/`uuid.UUID` | — | **subtype** `field.uuid` |
| url / uri | `URI`/`Uri`/`urllib` | scheme/authority/path, absolute-vs-relative | **subtype** `field.uri` (+ `@kind` url/urn) |
| ipv4 / ipv6 | `InetAddress`/`IPAddress`/`ipaddress` (+ PG `inet`) | version, subnet/CIDR | **subtype** `field.inet` (+ `@kind` ipv4/ipv6) |
| email | none (string) | none | **attribute** `@stringFormat: email` |
| hostname | none | none | **attribute** `@stringFormat: hostname` |

**Do not be misled by JSON-world tools** (JSON Schema, Zod, class-validator) that call all of these "formats." They do so only because JavaScript/JSON has *no native types* for any of them — to them everything is a string. MetaObjects binds metadata→native types across five languages (ADR-0001), so the question is behavioral:

> **Does the concept have a native type or its own behavior?** Yes → **subtype** (and structural variants of it → `@kind`). No → it's a plain validated string → **attribute** (`@stringFormat`).

The one-line rule: **`@stringFormat` is for a plain string that just needs validating; a subtype is for a concept with a native type or behavior of its own; `@kind` distinguishes variants *inside* such a subtype.** Email is a validated string. A URL is a thing.

## Consistency corollaries

- **Base type + semantic tag beats type proliferation.** Never mint a sibling type for a mere *property* — there is no `field.shortString`/`field.longString`; that is `@maxLength`. Collapsing distinct native types/behaviors into one (the OpenAPI-Generator trap) is the opposite failure — avoid both.
- **`@kind` is the one structural-variant axis — keep it chartered.** Use `@kind` only for variants *within* a subtype that earned its place by 2a (source kind, template kind, uri url/urn). Do **not** let `@kind` become a catch-all discriminator: it must never absorb a distinct-native-type concept (that's a subtype), a boolean flag (`@localTime`), or a validation constraint (`@stringFormat`). A `@kind` whose value-set is "anything" tells a reader nothing — the value of a name is self-documentation, which a chartered `@kind` keeps and a catch-all loses.
- **Self-documentation over economy.** Prefer a specific, named attribute (`@localTime`, `@stringFormat`, `@unique`) over folding several concerns into one generic attr. A name should tell you what it does without a per-type lookup table. The *primary* universal discriminator is already `type.subType`; don't invent a second one.
- **Same concept → same attr name; never same-name-different-meaning.** When an existing attr name means something else on another type (`@format` on `template.*` = output/serialization format), give the new one a distinct name (`@stringFormat`) rather than overload it.
- **Every new first-class element requires** a registered provider + a `registry-conformance` fixture (ADR-0023 strict provenance), and — for closed enums (including every `@kind` value-set) — `allowedValues` in the gate (ADR-0036).

## Worked examples (the decisions this framework reproduces)

| Concept | 0: derivable? | 1: physical? | 2: native type / behavior? | Result |
|---|---|---|---|---|
| array of string | **yes** (`isArray`) | — | — | derive `text[]` — no vocabulary |
| `varchar(n)` length | **yes** (`@maxLength`) | — | — | derive |
| jsonb open bag | no | **physical** (string native) | — | `@dbColumnType: jsonb` |
| UUID | no | logical | native `UUID`/`Guid` | **subtype** `field.uuid` |
| money | no | logical | minor-unit behavior | **subtype** `field.currency` |
| binary | no | logical | native `bytes` | **subtype** `field.bytes` |
| URL / URI | no | logical | native `URI`/`Uri` + parse behavior | **subtype** `field.uri` (+ `@kind` url/urn) |
| IP address | no | logical | native IP type + CIDR | **subtype** `field.inet` (+ `@kind` ipv4/ipv6) |
| DB-object kind (table/view) | no | — | structural variant *within* `source.rdb` | **`@kind`** on source |
| email / hostname | no | logical | none (plain validated string) | **attribute** `@stringFormat` |
| naive timestamp | no | logical | boolean exception-flag | **attribute** `@localTime` |
| decimal precision | no | logical | config of a decimal | **attribute** `@precision`/`@scale` |

## Consequences

- Vocabulary expansion becomes a **procedure, not a guess** — reducing type proliferation, same-name overloads, and wrong subtype/attribute calls.
- It binds **core contributors and adopters with custom providers** alike. The `metaobjects-audit` skill checks new/custom vocabulary against this framework (advisory), and the agent-context surfaces carry it so every adopter extending the metamodel applies the same rule.
- This ADR is the source of truth; ADR-0013/0023/0001 remain the underlying principles it sequences. ADR-0036's per-decision calls (`field.uuid` over `@format:uuid`, `@localTime` over `field.localDateTime`) are instances of this framework.

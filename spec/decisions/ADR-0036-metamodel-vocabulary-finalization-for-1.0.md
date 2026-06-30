# ADR-0036: Metamodel vocabulary finalization for 1.0 — adopter-driven first wave

## Status

**Accepted** (2026-06-30). Companion to ADR-0035 (the 1.0 stability commitment): ADR-0035 is the *policy* (what semver covers; version unification); this ADR records the concrete *metamodel vocabulary* decisions that ADR-0035's "metamodel freeze" requires.

This ADR scopes the **first wave** — the decisions driven by what two production adopters (a ~120-file JVM adopter and a Python adopter) actually use, so their continued work builds on the final shapes rather than soon-to-change ones. The broader vocabulary review and gap analysis (timestamp/escape-hatch research, field-type/validator/UI/relationship gap studies) feed a later wave; only the adopter-blocking and breaking-to-retrofit items are decided here.

## Context

1.0 freezes the registered type/subtype/attribute vocabulary; after it, a breaking change requires 2.0. The pre-1.0 consolidation window is the only time to make breaking vocabulary moves. Scanning the two adopters' real metadata made the priorities unambiguous:

| Pattern in adopter metadata | JVM adopter | Python adopter |
|---|---|---|
| `field.timestamp` total / **`@dbColumnType:timestamp_with_tz`-annotated** | 214 / **162** (76%) | 29 / **18** (62%) |
| `@dbColumnType: uuid` (string-native over a uuid column) | **262×** | 0 (uses `field.uuid`) |
| `@dbColumnType: jsonb` | 70× | 32× |
| `@dbColumnType: uuid_array` / `text_array` | 5× total | 0 |
| email / url / slug string fields | yes | few |
| **two relationships to the same target entity** (same-pair) | — | **8 entities** |

The throughline (confirmed by a cross-framework study of 11 ORMs/IDLs): **base type + semantic tag/strategy beats type proliferation**, governed by the **physical-vs-logical test** — *does it change the native type or the field's meaning?* If yes, it is logical and belongs in real (registered, validated, conformance-gated) vocabulary, not in the physical `@dbColumnType` escape-hatch string.

## Decision

### 1. Timestamp → instant-by-default, naive via the `@localTime` attribute

`@dbColumnType: timestamp_with_tz` fails the physical test — timezone-awareness changes the native type in every port (`Instant`/`DateTimeOffset`/aware `datetime` vs `LocalDateTime`/`DateTime`/naive). It is logical vocabulary, not a physical knob. But it is the **same kind** of value (a date+time) with one orthogonal property (does it carry a zone), so by [ADR-0037](ADR-0037-metamodel-vocabulary-expansion-decision-framework.md) it is an **attribute, not a subtype**:

- **`field.timestamp` = instant / tz-aware** — the default and common case → `timestamptz`; native `Instant` (Java/Kotlin) / `DateTimeOffset` (C#) / aware `datetime` (Python) / ISO-8601 string with `Z` (TS).
- **`@localTime: true`** on `field.timestamp` = naive wall-clock — the narrow exception → `timestamp without time zone`; native `LocalDateTime` / `DateTime(Unspecified)` / naive `datetime` / string. A boolean attribute, default false/absent (so the common case needs nothing).
- **`@dbColumnType: timestamp_with_tz` is retired** — the ~180 adopter annotations simply drop (a bare `field.timestamp` is now what they wanted); only genuinely-naive fields gain `@localTime: true` (many bare timestamps that were naive-by-accident are latent bugs the flip fixes).

Rationale: aware-by-default is the unanimous best-practice (Postgres "Don't Do This", Ecto, Django 5.0). `timetz` is discouraged and `date` is inherently naive, so the distinction applies only to `timestamp`. The attribute is the right shape (not a subtype) because timezone-awareness is an orthogonal modifier of one base type — the same shape as `@maxLength` on a string — not a different *kind* of value the way `field.uuid` is (ADR-0037, step 2). _Earlier drafts proposed a `field.localDateTime` subtype; that was corrected to the attribute under the ADR-0037 framework — the per-port native-binding conditional already exists, and a subtype would over-weight a rare modifier into a sibling type._

### 2. Semantic string formats — split by behavior (per ADR-0037)

The "string formats" set does not survive the [ADR-0037](ADR-0037-metamodel-vocabulary-expansion-decision-framework.md) behavioral test (own native type / behavior → subtype; plain validated string → attribute), so it splits three ways:

- **`field.uri` subtype** — `url`/`uri` have a native type (`URI`/`Uri`/`urllib`) and behavior (scheme/authority/path, absolute-vs-relative), so they are a subtype, with **`@kind` = `url` | `urn`** distinguishing the structural variants (a URL locates, a URN names). Native binding + parse behavior per port.
- **`field.inet` subtype** — `ipv4`/`ipv6` have a native type (`InetAddress`/`IPAddress`/`ipaddress`) and a Postgres-native `inet`/`cidr` column, so they are a subtype, with **`@kind` = `ipv4` | `ipv6`**.
- **`@stringFormat` attribute** on `field.string` — only the genuinely behavior-less, native-type-less validated strings: **`email | hostname`** (additive — more can be added later). The canonical matcher per format lives in each port (conformance-gated), *not* author `validator.regex` (cross-language regex engines diverge and break byte-identity). Named `@stringFormat` (not `@format`) to avoid colliding with the existing `template.* @format` (output format) — ADR-0037's no-overload corollary. Codegens idiomatically (Zod `z.email()`, Jakarta `@Email`, PG `CHECK`/`citext`).

`uuid` is **not** in this set — it is already the `field.uuid` subtype (native UUID type), the original instance of this same rule.

### 3. Multi-edge-same-pair navigation → `@relationName`, fail-closed

When an entity declares two relationships to the same target (the same-pair case — e.g. `sender` + `recipient` both → `User`), generated navigation names collide. Add a **`@relationName`** attribute on `relationship.*` that names the navigation/inverse explicitly. **1.0 codegen errors (`ERR_AMBIGUOUS_RELATION`) on unnamed same-pair edges** rather than silently colliding — a later rename of generated nav properties would be breaking in adopters' repos, so the ambiguity must be surfaced at build time now. (Confirmed live: one adopter has 8 such entities.)

### 4. Finish the `@dbColumnType` slim — keep `uuid`

The earlier "slim-and-derive" landed the *derive* half (native `text[]`/`uuid[]` from `isArray`, `text` as the no-`maxLength` default) but not the *slim* half. Complete it:

- **Remove** `uuid_array`, `text_array` (derivable from `isArray`), the JVM-only `text` value, and the Kotlin `@kind:text` hack from all five ports' enforced value-sets. (One adopter migrates 5 array sites to `isArray`; trivial.)
- **Keep `@dbColumnType: uuid`** as a supported, non-deprecated escape — "string-native type over a uuid column" is a legitimately different choice from `field.uuid` (String vs native UUID), and one adopter relies on it 262×. `field.uuid` is the documented default path; the string-escape keeps working — no forced migration.

### 5. Closed-value-set conformance gate (the enforcement mechanism)

`registry-conformance` byte-matches structure (types/subtypes/attr-names) but **not** the legal value lists — which is exactly how the slim half-landed unnoticed across ports. Emit each attribute's `allowedValues` into the registry manifest and **byte-gate it across all five ports**. Land this *with* decisions 2 and 4 so the new `@format` set and the slimmed `@dbColumnType` set are provably identical cross-port. This is the mechanism that makes every other vocabulary guarantee enforceable.

## Consequences

- Decisions 1 and 4 are **breaking** and must land inside the consolidation window; 2, 3, 5 are additive (3 adds a build-time error only for already-ambiguous models).
- Each ships cross-port with a `registry-conformance` fixture (ADR-0023 strict provenance).
- Adopters migrate once, to the final shapes: drop ~180 `timestamp_with_tz` annotations, add `@localTime: true` to genuinely-naive timestamps, move 5 array fields to `isArray`, and name same-pair relationships. `@dbColumnType:uuid` and `@dbColumnType:jsonb` continue working unchanged.

## Deferred to a later wave (recorded so they are reservations, not gaps)

`field.json` (the jsonb open-bag already works — sugar), `field.bytes` (the one genuine missing type — no adopter need yet), `@onDelete: set-default`, additional filter operators (`notIn`/`ilike`/`between`), polymorphic associations (reserve as out-of-scope), ordered relationships, all `view.*`/`layout.*` UI vocabulary (incl. cutting the dead `view.*` constants), and the db-physical attr-naming + base-attr-inheritance unification. None blocks the two adopters; all are additive or decidable before the freeze.

## Implementation waves

1. **Wave 1 — gate + slim** (decisions 5 + 4): lower-risk, mechanical; the gate enforces the slim.
2. **Wave 2 — timestamp** (decision 1): the native-type-changing split; shared persistence/api fixtures + ADR-0019 temporal clause updated.
3. **Wave 3 — `@format` + `@relationName`** (decisions 2 + 3): additive, each gated.

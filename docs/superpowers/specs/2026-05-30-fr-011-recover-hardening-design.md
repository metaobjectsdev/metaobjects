# FR-011 — Recover hardening: enum coercion pipeline + nested-object recovery

_Design doc. 2026-05-30. (Rescoped from an earlier "tolerant ingestion engine" draft — see History.)_

## Context

FR-010 shipped a tolerant `recover()` parser for fluid/hallucinated **LLM output**, in all 5 ports,
living in the render/prompt pillar (`render/recover/`). It works, but recovering enum values is
weak: even when you tell an LLM the valid members, it emits casing/spacing/separator variants and
outright hallucinations, which today fall straight to MALFORMED. This FR hardens the enum-recovery
path and closes the nested-object gap — improvements to the **existing LLM-output feature**, in place.

**Deliberately NOT generalizing.** An earlier draft proposed decoupling the engine into a standalone
general-purpose `ingest` package and adding a declarative payload-mapping layer (ESB/iPaaS style).
That was over-reach: the engine has exactly one real consumer (LLM output), so decoupling is 5-port
churn for no second consumer, and a general inbound-JSON/XML mapping engine is far more than the
current need justifies. See **Out of scope**.

## Goals

1. **Enum coercion pipeline** so variant/hallucinated enum values resolve robustly and safely:
   `exact → normalize → @enumAlias → @coerceDefault → MALFORMED`, with `@default` filling absent
   values and the reserved `DEFAULTED` classification finally emitted.
2. **Configurable normalization** via a `@normalize` attr (ASCII-only modes; per-field + a
   value-object-level default).
3. **Nested / embedded-object recovery** — close the FR-010 deferral, uniform across ports.
4. **Expand the conformance corpus** for the above.

Stays where it is — `render/recover/` per port. No package move; `recover()` API unchanged.

## Out of scope (deliberately)

- **Decoupling into a general `ingest` package** — premature abstraction; one consumer today.
- **The `unicode` normalization mode** — full Unicode NFKC_Casefold can't be guaranteed byte-identical
  cross-port (ICU-class divergence), and enum members are ASCII by definition, so it's unneeded.
  ASCII modes only.
- **Fuzzy matching** — deferred (a future nice-to-have). The pipeline reserves a clean, non-breaking
  slot for it (between `@enumAlias` and `@coerceDefault`); if real typo-class misses appear, add a
  **guarded integer Levenshtein** there (≤1 + clear margin + normalized-length ≥5, `tolerance=loose`
  only — never a float/Jaro-Winkler variant, to preserve cross-port determinism). Not built here.
- **Declarative payload mapping** (source paths, multi-source, runtime-injectable mapping, CDM) —
  this is consumer-specific transformation work, best done **custom in the adopter** (single language,
  full control; lean on a path-extraction lib like JMESPath for the primitive; target the metaobjects
  value-object as the canonical model). A general config-driven mapping/ingestion product, if it ever
  earns its keep, belongs in the **commercial layer (metaforge)**, not the Apache-2.0 core.
- **General scalar-coercion breadth** (locale numbers, date-format soup, currency/units) and a
  production observability/drift-metrics layer — those only mattered for the abandoned general-ingestion
  ambition.
- A Turing-complete transform DSL — the existing `onField` hook covers rare bespoke compute.

## Enum coercion pipeline

Resolution order for an enum value during recover, given the field's resolved normalization mode `M`:

1. **exact** match against `@values` → `RECOVERED`.
2. **normalized** match using mode `M` (both input and members normalized by `M`; skipped when
   `M = none`) → `RECOVERED` (a `normalize` coercion logged).
3. **`@enumAlias`** (explicit synonyms, properties map) — runtime aliases win over schema; alias keys
   are normalized by `M` before comparison; a hit → `RECOVERED` (alias coercion logged).
4. *(reserved slot — fuzzy, not built; see Out of scope)*
5. **`@coerceDefault`** (new attr) — a present-but-uncoercible value falls back to this member →
   `DEFAULTED` (coercion logged). If absent, fall through.
6. **MALFORMED**.

**Absent** (missing) field: filled by **`@default`** (existing attr) if declared → `DEFAULTED`; else
`LOST_OPTIONAL` / `LOST_REQUIRED` by `@required`. A `DEFAULTED`-via-`@coerceDefault` value satisfies
`@required` (it's a valid member). Rationale for two attrs: `@default` = "value when none supplied";
`@coerceDefault` = "value when supplied-but-garbage" — the LLM omitting a field vs hallucinating one
may warrant different fallbacks. A present-uncoercible value does **not** borrow `@default` (only
`@coerceDefault`), keeping the two independent.

### Normalization modes (`@normalize`)

Closed-enum attr, ASCII-only (enum members are ASCII → every mode is a pure `[A-Za-z0-9]` transform,
**byte-identical cross-port** with zero locale/Unicode machinery — sidesteps the Turkish-İ/locale and
Unicode-version traps entirely):

- **`none`** — exact only (skip step 2).
- **`collapse`** — ASCII case-fold (`a–z`↔`A–Z`) + trim + collapse runs of `[\s_\-]+` to one `_`.
  `"in progress"`/`"In-Progress"` → `IN_PROGRESS`; `"inprogress"` stays distinct.
- **`strip`** *(default)* — ASCII case-fold + strip everything except `[A-Z0-9]`. Separator/
  punctuation/whitespace-insensitive: `"in progress"`/`"In-Progress"`/`"inprogress"`/`"in progress!"`
  → `INPROGRESS`. Most forgiving. (Load-time warning if two members collide under `strip`.)

Mode resolution (the codegen schema-emitter bakes the resolved `M` into the `FieldSpec`):
field-level `@normalize` → owning `object.value`-level `@normalize` (object default) → global default
**`strip`**.

## Nested / embedded-object recovery

Close the FR-010 deferral uniformly. A `FieldSpec` of kind `Object` carries a nested schema; the
extract stage descends into it, classifying sub-fields with **dotted child paths** (`meta.score`,
`items[0].label`). Object-given-where-scalar → MALFORMED; scalar-given-where-object → MALFORMED.
Arrays of objects recover element-wise (partial-MALFORMED keeps good elements — same rule as scalar
arrays). Replaces the current per-port divergence (TS/C#/Python partially support, Java/Kotlin defer)
with one corpus-pinned behavior.

## Metamodel attrs

- **`@coerceDefault`** (NEW) — on `field.enum`. String member symbol; must be one of `@values`
  (loader-validated → `ERR_BAD_ATTR_VALUE`). Drives step 5. Generic name (not enum/LLM-specific).
- **`@normalize`** (NEW) — closed enum `none | collapse | strip` (loader-validated). On `field.enum`
  (per-field) and `object.value` (default for its enum fields). Resolved field → object → global `strip`.
- **`@default`** (EXISTING) — its enum value also serves as the *absent*-fill during recover; documented
  dual role (DB/codegen default + recover absent-fill).
- **`@enumAlias`** (EXISTING, FR-010) — alias keys now normalized by the field's mode `M` (step 3).
- All registered identically across ports.

## Tiers (cross-language-porting)

- **Tier 1 (INVARIANT — corpus-pinned, byte-identical):** per-field classification + `empty`; the
  resolution order; the `none`/`collapse`/`strip` normalization rules (pure ASCII); the
  `@coerceDefault`/`@default`/`@enumAlias`/`@normalize` vocabulary + the field→object→global mode
  resolution; nested dotted-path classification; existing strip/locate/read/coerce behavior;
  MALFORMED/TRUNCATED sentinels.
- **Tier 2 (idiomatic):** enums/dataclasses/records per language; internal mechanism.

## Conformance corpus expansion

Add to the shared `fixtures/recover-conformance/` (existing 10 cases stay green):

- **Enum pipeline:** normalized-variant per mode (`strip`: `"in progress"`/`"inprogress"`; `collapse`:
  `"in progress"` but NOT `"inprogress"`; `none`: exact-only); field-level vs object-level `@normalize`
  resolution; `@enumAlias` synonym; `@coerceDefault` fallback (→ DEFAULTED); `@default` absent-fill
  (→ DEFAULTED); required-field-with-`@coerceDefault` satisfies required.
- **XML breadth:** nested element, repeated→array, attribute-vs-element, more malformations (only 1
  XML case of 10 today).
- **Nested objects:** clean nested, partial-nested (some sub-fields MALFORMED), array-of-objects.
- **Multi-malformation:** one input combining fence + preamble + trailing-comma + off-vocab enum,
  asserting per-field independence.

The corpus is the oracle: never edit a fixture to match a port; escalate a suspected-wrong fixture.

## Testing strategy

1. Shared conformance corpus (above) — the cross-port oracle.
2. Per-stage unit tests per port (coerce incl. each `@normalize` mode + `@coerceDefault`; nested extract).
3. **Executable proofs** — TS/Python import-and-run, C#/Java/Kotlin compile-and-run — invoking the
   generated parser on dirty input (e.g. an off-vocab enum → `DEFAULTED` end-to-end).
4. Loader-attr tests for `@coerceDefault` + `@normalize` registration + bad-value rejection.
5. **Recommended (cheap, high-value):** a small **differential/property fuzz** check — feed random
   inputs to all ports, assert (a) never-throws and (b) identical classification cross-port. This
   validates the never-throws + byte-identical guarantees better than curated fixtures alone.

## Cross-port rollout

**Pilot: TypeScript** (reference port; freshest engine). Then port C# / Java / Kotlin (JVM-shared) /
Python, each gated on the shared corpus. Per-unit review + simplify before each merge; forward-only
merges; push for durability. (Established FR-010 workflow.)

## Resolved design decisions (brainstorming 2026-05-30)

- Pipeline = exact → normalize(`M`) → `@enumAlias` → `@coerceDefault` → MALFORMED; `@default` fills absent.
- New attrs **`@coerceDefault`** (present-but-garbage fallback) + **`@normalize`** (`none|collapse|strip`,
  default `strip`, with object-level default). `@default` handles absent.
- **No decouple** — stays in `render/recover/`. **No `unicode` mode.** **Fuzzy deferred** (reserved slot).
- Nested-object recovery in-scope and uniform.
- TS pilot.
- The declarative payload-mapping layer is **not** OSS-core (consumer-custom; commercial-metaforge if scaled).

## History

Rescoped 2026-05-30 from a broader "tolerant ingestion engine" draft (decouple + general framing +
`unicode` mode + fuzzy + a follow-on FR-012 declarative-mapping layer). A staff-level review concluded
the general-ingestion ambition was unjustified by current demand (one LLM consumer + one adopter intake
need), so the scope was cut to the high-value, low-risk core that improves the shipped LLM feature in
place. The mapping layer is consumer/custom (or commercial) work, not the OSS core.

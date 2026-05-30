# FR-011 — Tolerant ingestion engine (decouple + nested + enum coercion pipeline)

_Design doc. 2026-05-30._

## Context

FR-010 shipped a tolerant `recover()` parser for fluid/hallucinated LLM output, in all 5 ports,
living inside the **render/prompt** pillar (`render/recover/`). In use it became clear the engine
is **not LLM-specific** — `recover(text, schema)` doesn't care whether `text` came from a model, a
flaky webhook, a legacy feed, or a user paste. Only two of its stages (strip ```` ``` ```` fences,
locate JSON amid prose) are LLM-flavored, and both no-op on clean input. Everything else (forgiving
read, type coercion, range clamp, classification) is generic **lenient inbound-data parsing**.

This FR generalizes and hardens that engine. It is **Spec A** of a two-spec arc:

- **FR-011 (this doc) — Tolerant ingestion engine:** decouple the engine into a standalone
  `ingest` package; fix nested/embedded-object recovery; complete the enum coercion pipeline
  (normalize / alias / fuzzy / `@coerceDefault`); expand the conformance corpus.
- **FR-012 (follow-on) — Declarative payload mapping:** map arbitrarily-shaped JSON/XML payloads
  into the canonical value-object via a restricted dotted/bracketed source-path grammar, with a
  **runtime-injectable mapping** (built from a DB / UI), multi-source merge, default = structural
  mirror. The ESB/iPaaS "canonical data model" pattern. Built on FR-011. **Out of scope here.**

The motivating insight (validated against ESB/iPaaS practice — Boomi, MuleSoft DataWeave, JOLT,
JSONata): the payload **value-object is the canonical data model**; ingestion maps/coerces messy
inbound data *into* it. LLM output and structured-but-differently-shaped API payloads are two
*input profiles* of one ingestion machinery.

## Goals

1. **Decouple** the tolerant-parse engine out of `render` into a standalone, general-purpose
   `ingest` package — LLM handling becomes one input profile, not the core.
2. **Close the nested-object recovery gap** (deferred in FR-010; ports currently diverge).
3. **Complete the enum coercion pipeline** so hallucinated/variant enum values resolve robustly:
   `exact → normalize → @enumAlias → fuzzy(opt-in) → @coerceDefault → MALFORMED`, with `@default`
   filling absent values and the reserved `DEFAULTED` classification finally emitted.
4. **Expand the conformance corpus** (XML breadth, nested, arrays, multi-malformation) so the
   cross-port guarantee tightens.

## Non-goals (this FR)

- The declarative payload **mapping** layer (FR-012) — source paths, multi-source merge, runtime
  mapping injection, structural-mirror-vs-overlay. FR-011 keeps the FR-010 assumption that the
  payload **mirrors the VO structure**; remapping is FR-012.
- Moving `render`/prompt-fragment generation (artifact 1) — that stays in the render pillar; only
  the *parse/coerce* side moves to `ingest`.
- A Turing-complete transform DSL (arithmetic/conditionals/concat). The existing `onField` hook
  covers rare bespoke compute; richer transforms are explicitly rejected (the JSONata/DataWeave
  trap — un-portable, perf-costly, breaks zero-dependency + byte-identical conformance).
- General string/number alias support beyond enums + the existing boolean forms (YAGNI; revisit if
  a concrete need appears).

## Architecture

### The `ingest` package

A new standalone package per port — `@metaobjectsdev/ingest`, `MetaObjects.Ingest`,
`com.metaobjects.ingest`, `metaobjects.ingest` (Kotlin reuses the JVM `ingest`). It houses the
tolerant parse + coerce + classify engine now, and will house the FR-012 mapping layer later
("inbound data ingestion" home).

**Dependency direction:** `render` (prompt construction) **depends on** `ingest` for the shared
`Format` / `FieldKind` value types and to drive the render→recover round-trip in `verify`. `ingest`
does NOT depend on `render`. The prompt-*fragment* generator (artifact 1) stays in `render`.

**The pipeline** (unchanged stages, regrouped):

```
ingest(text, schema, opts?) -> Outcome        # the general entry (today's recover())
  stage 1  strip       — fence removal              ┐ LLM input profile
  stage 2  locate      — find the JSON/XML payload  ┘ (no-op on clean structured input)
  stage 3  read        — forgiving JSON / XML reader (trailing commas, unclosed tags, TRUNCATED)
  stage 4  extract     — pull field values per schema (NOW: descend into nested objects)
  stage 5  classify    — RECOVERED / DEFAULTED / LOST_OPTIONAL / LOST_REQUIRED / MALFORMED + empty
  stage 6  coerce      — canonicalize each value (enum pipeline, numeric clamp, bool forms, etc.)
  stage 7  report      — per-field outcome + coercion log
```

`recover()` is **retained as an alias/entry** for back-compat and as the LLM-profile name; the
canonical general name is `ingest()` (exact public naming finalized in the plan, but `recover()`
must keep working — it's shipped).

### Decouple migration (low-risk)

The only consumers of the FR-010 recover engine are **internal** (the render round-trip) and
**generated codegen we control** (the `recover()`-emitting generators, days old, pre-GA). So:

1. Move `render/recover/*` → `ingest/*` per port; update internal imports.
2. `render` imports the shared `Format`/`FieldKind` from `ingest`.
3. Update the codegen emitters (`RecoverSchemaEmitter`, the output-parser generators) to emit the
   new `ingest` import paths.
4. No back-compat shim required (no external adopter has generated recover code yet at pre-GA). If
   a port wants belt-and-suspenders, a thin re-export from the old location is allowed but not
   required.

TS pilots the decouple (cleanest in the package-per-feature layout); the other ports follow against
the shared corpus.

### Nested / embedded-object recovery

Close the FR-010 deferral uniformly. A `FieldSpec` of kind `Object` carries a nested schema; the
extract stage descends into it, classifying sub-fields with **dotted child paths** (`meta.score`,
`items[0].label`). An object-given-where-scalar-expected stays MALFORMED; a scalar-given-where-
object-expected is MALFORMED. Arrays of objects recover element-wise (partial-MALFORMED keeps good
elements — same rule as scalar arrays). This replaces the current per-port divergence (TS/C#/Python
partially support it, Java/Kotlin defer) with one corpus-pinned behavior.

### Enum coercion pipeline

Resolution order for an enum value during ingest, given the field's resolved **normalization mode
`M`** (see below) and the runtime **tolerance `T`**:

1. **exact** match against `@values` → `RECOVERED`.
2. **normalized** match using mode `M` (both input and members normalized by `M`; skipped when
   `M = none`) → `RECOVERED` (a `normalize` coercion logged).
3. **`@enumAlias`** (explicit synonyms, properties map) — runtime aliases win over schema; alias
   keys are normalized by `M` before comparison; a hit → `RECOVERED` (alias coercion logged).
4. **fuzzy** — enabled only when `T = loose`. **Guarded integer Levenshtein** on the `M`-normalized
   forms: accept the **uniquely nearest** member with edit distance ≤ 1 **and** a clear margin (the
   runner-up's distance ≥ best + 2), **and** only for members whose normalized length ≥ 5 (short
   members never fuzzy-match). Integer distance → deterministic, byte-identical cross-port. A hit →
   `RECOVERED` (fuzzy coercion logged). Off by default (`T ≠ loose`).
5. **`@coerceDefault`** (new attr) — a present-but-uncoercible value falls back to this member →
   `DEFAULTED` (coercion logged). If absent, fall through.
6. **MALFORMED**.

Absent (missing) field: filled by **`@default`** (the existing attr) if declared → `DEFAULTED`;
else `LOST_OPTIONAL` / `LOST_REQUIRED` by `@required`. Rationale: `@default` *is* "value when none
supplied"; `@coerceDefault` is "value when supplied-but-garbage" — distinct because the LLM omitting
a field vs hallucinating one may warrant different fallbacks. A present-uncoercible value does **not**
borrow `@default` (only `@coerceDefault`), keeping the two semantics independent.

### Normalization modes (configurable via `@normalize`)

Normalization is selectable, not fixed, via a closed-enum **`@normalize`** attr. The three modes:

- **`none`** — exact only; skip step 2 (strictest).
- **`collapse`** — ASCII case-fold (`a–z`↔`A–Z` only) + trim + collapse runs of `[\s_\-]+` to a
  single `_`. Preserves separator boundaries. `"in progress"`/`"In-Progress"` → `IN_PROGRESS`;
  `"inprogress"` stays distinct.
- **`strip`** *(default)* — ASCII case-fold + strip everything except `[A-Z0-9]`. Separator/
  punctuation/whitespace-insensitive: `"in progress"`/`"In-Progress"`/`"inprogress"`/`"in progress!"`
  → `INPROGRESS`. Most forgiving. (Load-time warning if two members collide under `strip`.)
- **`unicode`** — Unicode caseless match (NFKC_Casefold-style) for non-ASCII input/diacritics.

`collapse` and `strip` are **pure ASCII transforms → Tier-1 byte-identical** across all 5 ports.
`unicode` is **best-effort** per each port's standard Unicode facilities; because implementations
diverge (ICU-class differences), `unicode`-mode results are **NOT part of the byte-identical
cross-port conformance assertion** — they're tested per-port for reasonableness only. Pick `unicode`
only when a field genuinely has Unicode-domain input; ASCII enum members rarely need it.

**Resolution of the mode for a field** (the codegen schema-emitter bakes the resolved `M` into the
`FieldSpec`): field-level `@normalize` → owning `object.value`-level `@normalize` (the
**object-level default** for its enum fields) → global default **`strip`**.

### Metamodel attrs

- **`@coerceDefault`** (NEW) — on `field.enum` (extensible to other constrained kinds later). String
  member symbol; must be one of `@values` (loader-validated → `ERR_BAD_ATTR_VALUE`). Drives step 5.
  Generic name (not enum/LLM-specific) so it reads as an input-coercion concern.
- **`@normalize`** (NEW) — closed enum `none | collapse | strip | unicode` (loader-validated). On
  **`field.enum`** (per-field) and on **`object.value`** (the default for the object's enum fields).
  Resolution: field → owning object → global default `strip`. The codegen schema-emitter bakes the
  resolved mode into the `FieldSpec`. Generic name; honored for enums in FR-011, extensible later.
- **`@default`** (EXISTING) — its enum value now also serves as the *absent*-fill during ingest. No
  new attr; documented dual role (DB/codegen default + ingest absent-fill).
- **`@enumAlias`** (EXISTING, FR-010) — unchanged; alias keys normalized by the field's mode `M` (step 3).
- Fuzzy matching has no attr — it's gated by the runtime `tolerance = loose` (RecoverOptions), off by default.
- All registered identically across ports.

## Tiers (cross-language-porting)

- **Tier 1 (INVARIANT — corpus-pinned):** per-field classification + `empty`; canonical value
  (numeric ±1e-9); the **resolution order**; the **`none`/`collapse`/`strip` normalization rules**
  (pure ASCII → byte-identical); the **guarded integer-Levenshtein fuzzy** (algorithm + ≤1 + clear-
  margin + min-length-5 guard, deterministic); `@coerceDefault`/`@default`/`@enumAlias`/`@normalize`
  vocabulary + the field→object→global mode resolution; nested dotted-path classification; the
  strip/locate/read/coerce observable behavior; MALFORMED/TRUNCATED sentinel effects.
- **Tier 2 (idiomatic / best-effort):** the `ingest` package internals + module layout; the
  `recover()`↔`ingest()` naming; enums/dataclasses/records per language; opt-in-fuzzy plumbing.
  **The `unicode` normalization mode is explicitly best-effort and NOT in the byte-identical
  conformance assertion** (per-port Unicode facilities diverge); `collapse`/`strip` are the
  cross-port-guaranteed modes.
- **Tier 3:** conformance-runner plumbing; the executable-proof harness.

## Conformance corpus expansion

Add to the shared `fixtures/recover-conformance/` (renamed/aliased to ingest-conformance if the API
rename lands; the existing 10 cases stay green):

- **Enum pipeline:** normalized-variant per mode (`strip`: `"in progress"`/`"inprogress"`; `collapse`:
  `"in progress"` but NOT `"inprogress"`; `none`: exact only); field-level vs object-level `@normalize`
  default resolution; `@enumAlias` synonym; fuzzy-typo (loose-only, incl. a short-member NON-match and
  a close-members tie NON-match to pin the guards); `@coerceDefault` fallback (→ DEFAULTED); `@default`
  absent-fill (→ DEFAULTED). (`unicode`-mode cases are per-port-only, not in the cross-port assertion.)
- **XML breadth:** nested element, repeated→array, attribute-vs-element, mixed-content, more
  malformations (currently only 1 XML case of 10).
- **Nested objects:** clean nested, partial-nested (some sub-fields MALFORMED), array-of-objects.
- **Multi-malformation:** a single input combining fence + preamble + trailing-comma + off-vocab
  enum, asserting per-field independence.

The corpus is the oracle: never edit a fixture to match a port; escalate a suspected-wrong fixture.

## Testing strategy

1. Shared conformance corpus (above) — the cross-port oracle.
2. Per-stage unit tests per port (strip/locate/readers incl. no-hang & TRUNCATED / coerce incl.
   normalize+fuzzy+`@coerceDefault` / nested extract / recover-map).
3. **Executable proofs** — TS/Python import-and-run, C#/Java/Kotlin compile-and-run — invoking the
   generated parser on dirty input (e.g. an off-vocab enum → DEFAULTED end-to-end).
4. Loader-attr tests for `@coerceDefault` registration + bad-value rejection.
5. `mypy --strict` / `tsc` / `TreatWarningsAsErrors` clean per port.

## Cross-port rollout

**Pilot: TypeScript** (reference port; freshest engine; cleanest decouple). Then port C# / Java /
Kotlin (JVM-shared) / Python, each gated on the shared corpus. Per-unit review + simplify before
each merge; forward-only merges; push for durability. (Established FR-010 workflow.)

## Bounded deferrals

- **Payload mapping** (source paths, multi-source, runtime-injected mapping) → **FR-012**.
- Alias/`@coerceDefault` for non-enum constrained fields (numeric domains, etc.) — name is general,
  but only enums honored in FR-011.
- Array-of-enum specialization beyond scalar-array handling.

## Resolved design decisions (from brainstorming 2026-05-30)

- Pipeline = exact → normalize(mode `M`) → `@enumAlias` → fuzzy(guarded Levenshtein, `tolerance=loose`)
  → `@coerceDefault` → MALFORMED; `@default` fills absent.
- New attr **`@coerceDefault`** (general, not `@enumDefault`); `@default` handles absent.
- Normalization is **configurable** via **`@normalize`** (`none|collapse|strip|unicode`), per-field
  with an `object.value`-level default; global default `strip`. `collapse`/`strip` are ASCII →
  Tier-1 byte-identical; `unicode` is best-effort (excluded from the cross-port byte assertion).
- Fuzzy **included** as guarded integer Levenshtein (≤1, clear margin, normalized-length ≥5),
  gated by `tolerance=loose`, off by default — chosen over Jaro-Winkler to avoid float cross-port
  nondeterminism. Researched 2026-05-30.
- **Full decouple** into the **`ingest`** package; render depends on ingest.
- Nested-object recovery is in-scope and uniform.
- TS pilot.
- FR-012 mapping uses a restricted dotted/bracketed grammar + a runtime-injectable mapping.

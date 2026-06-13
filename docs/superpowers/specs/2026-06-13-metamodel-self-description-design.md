# Provider definitions as declarative data + metamodel docs for LLMs (design)

_Status: DESIGNED (brainstormed + approved 2026-06-13). FR-033 (GH #23)._

## 1. Problem

Two coupled problems, one root cause.

**(a) The metamodel definition is hand-coded five times.** Each port hand-codes
its providers — the vocabulary (type/subtype/attr names), the declarative
constraints (`required`, `valueType`, `allowedValues`, bounds), in
`field-schema.ts` / `FieldSchema.java` / `FieldSchema.cs` / … . `registry-
conformance` then gates that the five hand-coded copies stay identical. That is
five copies of the same declarative data, kept in sync by a gate — the exact
duplication metaobjects exists to eliminate. It is also why descriptions never
got shared: there was no single place to put them.

**(b) The metamodel's meaning is invisible to the LLM.** Per-attribute
descriptions exist only in TS (inline in the schemas); type/subtype *purpose* and
*rules of use* are undocumented; the registry manifest captures
`name`/`valueType`/`isArray`/`required` but **no descriptions**. So an LLM
authoring metadata has no accurate, consistent source for "what is `field.currency`
for, what attrs does it take, and what are the rules."

The root cause is the same: the **declarative metamodel definition lives as code,
duplicated per port**. Fix the root — make the declarative definition *data,
single-sourced* — and descriptions ride along, consistency becomes
by-construction, and docs become derivable.

## 2. Decision — provider definitions become declarative data files

A provider's **declarative** definition becomes a JSON file (or files) the
provider *reads* to register itself, instead of hand-coded schema. The file
describes everything declarative about that provider's metamodel **plus** the
descriptions and rule prose:

- type/subtype vocabulary the provider owns;
- each attribute: `valueType`, `isArray`, `required`, `allowedValues`, `default`,
  bounds;
- **descriptions** (type/subtype purpose, per-attr meaning);
- **rule prose** — human/LLM-readable documentation of the complex rules
  ("an M:N `@through` junction must declare two `identity.reference` children");
- optional `example` and `whenToUse`.

```
spec/metamodel/<provider>.json          ← GLOBAL/core declarative definition (shared, neutral, the spine)
        │
        │  a provider reads ≥1 file, overlay-merged:
        │    global (spec/metamodel) + optional language-specific (local port repo)
        ▼
server/<lang>/.../metamodel/<provider>.<lang>.json   ← LANGUAGE-SPECIFIC overlay (additions only in this port)
        │
        ▼  embedded at build (per port), read at provider registration
  each port's provider registers vocab + constraints + descriptions into its LIVE registry
        │
        ▼  each port DUMPS "registry-with-descriptions"  ── one artifact, two consumers ──┐
        │                                                                                  │
        ▼                                                                                  ▼
  registry-conformance gate                                              ONE neutral Tier-2 doc engine (TS ref)
  (expected-registry.json grown to carry the full declarative           renders TIERED markdown:
   schema + description + provider per entry):                            metamodel/INDEX.md           (one-liners + links)
   • the embedded files didn't drift                                      metamodel/providers/<id>.md  (full attr + rule detail)
   • every entry is declared AND described (strict provenance)                       │
   • core entries identical cross-port (all read the same global file)               ▼
   • language-specific entries asserted per-port                          fed to the `metaobjects-authoring` skill
```

### 2.1 The data/code boundary (metaobjects has no custom DSL)

- **In the files (data):** vocabulary, declarative attr constraints
  (`required`/`valueType`/`allowedValues`/`default`/bounds — what the loader
  already enforces generically from the schema today), descriptions, rule *prose*,
  examples.
- **Stays as per-port code:** **imperative validation** (cross-node rules — M:N
  junction structure, `@symmetric`-only-on-self-join, origin-path resolution, the
  read-only cross-attr rules) and **codegen/runtime behavior**. The file *describes*
  a complex rule in prose so the LLM and humans see it; the existing validation
  pass keeps *enforcing* it. The file is **not** an executable rules language —
  that is the DSL trap the project explicitly avoids.

This boundary is the load-bearing decision: the file owns the **declarative
definition + rule documentation**; code owns **enforcement + emission**.

### 2.2 File layering (global + language-specific)

- **Global/core files** live in the **centralized specs area**
  (`spec/metamodel/<provider>.json`) — shared, language-neutral, identical for all
  five ports.
- **Language-specific files** live in the **local port repo**
  (`server/<lang>/…/metamodel/<provider>.<lang>.json`) — additions that exist only
  in that port (a TS-only D1 dialect attr, a JVM binding facet — the set
  `registry-conformance` already treats as excluded/per-port).
- A provider **reads ≥1 file**: its global definition, plus optionally its
  language-specific overlay. They **merge with the same overlay / last-writer-wins
  semantics the metadata loader already uses** for instance metadata — the local
  file *adds* subtypes/attrs and their descriptions; it must not contradict the
  core (the gate catches drift). A module shared by a *subset* of ports ships its
  own file, embedded only in the ports that include the module — same mechanism,
  smaller scope.

### 2.3 Why this is the metaobjects answer

- **Single source of truth.** The declarative metamodel is authored once
  (per provider, globally), not five times. The `registry-conformance` gate stops
  policing five hand-kept copies and instead verifies the embed didn't drift —
  consistency becomes *by construction*.
- **Format = JSON.** Interchange data, parsed natively in all five ports with zero
  deps (ADR-0006: JSON is the interchange form). Sibling of `expected-registry.json`
  (same `type.subType` keys). Escape hatch if prose ever grows rich: author YAML →
  lower to JSON at build (YAGNI today).
- **Embed at build, never runtime-load** (ADR-0001) — reuses the proven
  template/agent-context embedding pattern → AOT-safe. Reading an embedded JSON
  definition to build the registry is not reflection.
- **Strict provenance preserved** (ADR-0023) — the provider still owns and
  registers its vocabulary; it just reads the definition from data instead of
  hardcoding. The gate additionally *requires* a description per entry.
- **Dogfooding** — the metamodel is itself declared as metadata-shaped data and
  merged with the same overlay rules; docs are derived, not hand-written.

## 3. Data model — the declarative provider file + the registry dump

Each provider file declares, per **type/subtype** and per **attribute**:

| Field | Required | In file? | Meaning |
|---|---|---|---|
| name (type.subType / attr) | yes | yes | the vocabulary key |
| `valueType` / `isArray` / `required` | yes (attrs) | yes | declarative constraint (loader-enforced) |
| `allowedValues` / `default` / bounds | no | yes | declarative constraint (loader-enforced) |
| `description` | **yes** (gate-enforced) | yes | one-line "what it is" — the only field `INDEX.md` shows |
| `rules` (prose) | no | yes | documentation of complex rules (enforced in code) |
| `example` / `whenToUse` | no | yes | shown only in the provider detail page |
| `provider` | yes (derived) | — | owning provider id (groups doc pages); derived from which file declared it |

The **registry dump** is `expected-registry.json` grown to carry these fields. It
is a **single artifact with two consumers**: the `registry-conformance` gate
*and* the doc engine. Richness lives in the **tiering, not the data**: every entry
needs the required one-liner (gate-enforced, shown in `INDEX.md`);
`rules`/`example`/`whenToUse` surface only when the LLM follows a link into the
provider page — keeping default context lean.

## 4. Registration mechanism

At build, each port embeds its provider files (global + any language-specific) as
generated constants (the template-embedding pattern). At provider registration,
the provider:

1. reads its embedded global file + optional language-specific file;
2. overlay-merges them (last-writer-wins on attr conflicts; subtypes/attrs
   accumulate — the existing merge semantics);
3. registers each type/subtype/attr with its constraints **and** its description
   into the live registry (a `description` slot, plus optional `rules`/`example`/
   `whenToUse`, is added to the registry node — metamodel-about-the-metamodel,
   distinct from and unrelated to the instance-level `commonAttrs` doc layer).

Imperative validation passes and codegen are unchanged — they read the registered
vocabulary as today; they simply no longer *define* it.

## 5. Conformance — `registry-conformance` extended

The existing gate (each port emits its registry manifest, byte-matched to
`expected-registry.json`) is extended so the manifest carries the full declarative
schema + descriptions:

1. **Embed integrity + no-drift:** each port's emitted registry (built from its
   embedded files) matches the expected manifest — proving the embedded copy of
   each global file is the committed one and the merge is correct.
2. **Coverage (strict provenance for docs):** every registered type/subtype/attr
   MUST have a non-empty `description`. A new entry with no description fails CI —
   mirroring ADR-0023.
3. **Core identity:** core entries are byte-identical across all five ports (true
   *by construction* — all five read the same global file).
4. **Language-specific:** the per-port excluded/composed set carries its
   description in that port's manifest section; presence asserted, not cross-port
   identity.

`expected-registry.json` is regenerated from the TS reference's live registry
(built from the global files), so its core descriptions equal the global files' —
but it remains the gate *target*, not the source the ports embed, so the check is
not circular: each port re-derives its registry from *its* embedded files and is
asserted equal.

## 6. Doc-gen — one neutral engine, tiered output

A neutral Tier-2 doc engine (TS reference — the tier the existing `meta docs`
model engine uses, ADR-0020/0022) consumes the registry dump and emits:

- **`metamodel/INDEX.md`** — every `type.subType`, its one-line description, a link
  to its provider page. Small, context-cheap, always-on for the LLM.
- **`metamodel/providers/<provider-id>.md`** — full detail for that provider's
  vocabulary: each subtype and attr with `valueType`/`required`/constraints/
  `description`, plus `rules`/`example`/`whenToUse` where present. The LLM follows
  a link here only when it needs depth — the on-demand-fragment pattern the
  `metaobjects-*` skills already use.

Cross-port: **core** pages are byte-identical (neutral, rendered once); each
port's dump additionally yields its **language-specific** provider pages. A native
per-port renderer is a follow-on (the polyglot-docs deferral, ADR-0027); until
then the neutral TS engine renders any port's dump. Surface: a `meta docs
--metamodel` subcommand (TS) emits the reference; output byte-gated like the other
docs corpora.

## 7. LLM delivery

The generated `metamodel/` markdown is wired into the agent-context the
`metaobjects-authoring` skill ships (via `meta init` / the agent-context
assembler): `INDEX.md` referenced always-on, provider pages pulled on-demand.
That is the concrete answer to "give Claude Code better info about the metamodel"
— accurate-by-construction, context-tiered, identical wherever the core metamodel
is.

## 8. Out of scope / boundaries

- **Instance-level documentation** (`description`/`title`/`notes` on a user's
  field/entity — the existing `commonAttrs` layer) is unchanged and separate.
- **No imperative-rule DSL.** Complex validation stays as per-port code; the files
  document those rules in prose only (§2.1).
- **No behavior change to codegen/runtime.** The declarative-as-data move is
  additive: providers read their definition instead of hardcoding it; everything
  downstream reads the same registered vocabulary.

## 9. Sequencing + open items (settle at planning)

1. **Migration order.** Stand up the file-driven mechanism on **one core provider**
   first (TS reference), prove the gate + doc-gen, then convert the remaining core
   providers, then fan out the read-the-file mechanism to the other four ports.
   Convert provider-by-provider; the gate stays green at each step.
2. The exact embedded-file layout + the provider's read/merge API in each port
   (ergonomic in all five).
3. Whether `example` snippets are loader-validated at doc-gen time (so a doc
   example can't be invalid metadata) — desirable; confirm cost.
4. The native per-port metamodel-doc renderer (vs. TS-neutral-only) — deferred,
   tracked with the polyglot-docs follow-on.
5. Whether to also publish the metamodel reference to `metaobjects.dev/llms.txt`.

# Metamodel self-description for LLMs (design)

_Status: DESIGNED (brainstormed + approved 2026-06-13). Not yet numbered as an FR._

## 1. Problem

An LLM (Claude Code) authoring metadata needs to know **what each metadata
type/subtype is for and what every attribute means** — `field.currency` stores
money as integer minor units; `@scale` drives the NUMERIC scale; `source.rdb`
`@kind` selects table/view/storedProc. Today that knowledge is:

- **Per-attribute descriptions exist only in TS**, inline in the schema files
  (e.g. `field-schema.ts`: `"Maximum character length … (drives VARCHAR(n))"`),
  with no guarantee the other four ports carry the same text (or any).
- **Type/subtype *purpose* descriptions don't exist** anywhere.
- **`registry-conformance` gates the vocabulary** (every port's `type.subType` +
  attr names byte-match `expected-registry.json`) but captures only
  `name`/`valueType`/`isArray`/`required` — **no descriptions**.

So the metamodel's own meaning is undocumented, unshared, ungated, and invisible
to the LLM. This is the metaobjects philosophy applied to its **own** metamodel:
make the descriptions the durable spine, derive the docs, and conformance-gate
the consistency.

## 2. Decision (the net shape)

```
spec/metamodel-descriptions.json          ← SOURCE: core descriptions (hand-authored, neutral)
        │  embedded at build (per port)        + language/module-specific descriptions live IN the provider
        ▼
  each port attaches descriptions to its LIVE registry at provider registration
        │
        ▼
  each port DUMPS "registry-with-descriptions"  ── one artifact, two consumers ──┐
        │                                                                         │
        ▼                                                                         ▼
  registry-conformance gate                                          ONE neutral Tier-2 doc engine (TS ref)
  (expected-registry.json grown to carry                            renders TIERED markdown:
   description + provider per entry):                                 metamodel/INDEX.md            (one-liners + links)
   • every entry MUST have a description (strict-provenance for docs) metamodel/providers/<id>.md   (full attr detail)
   • core descriptions byte-identical cross-port
   • language-specific asserted per-port                                       │
                                                                              ▼
                                                          fed to the `metaobjects-authoring` skill
                                                          (INDEX always-on; provider pages on-demand)
```

Four settled decisions, with rationale tied to metaobjects principles:

1. **Source of truth = a shared file embedded per port** (not in-code-×5, not
   doc-gen-only). Single source → core consistent *by construction*. Reuses the
   proven embed-at-build pattern (templates, agent-context) → AOT-safe (ADR-0001).
2. **Format = JSON.** Descriptions are *interchange* data, not authored
   instance-metadata (ADR-0006: JSON is the interchange form). Parsed natively in
   all five ports, zero deps; it is a sibling of `expected-registry.json` (same
   `type.subType` keys). Escape hatch if prose ever grows rich: author YAML →
   lower to JSON at build (YAGNI today — descriptions are 1–3 sentences).
3. **Specificity = provider-owned, three scopes.** Description ownership tracks
   *vocabulary* ownership (ADR-0023: every entry traces to a registering
   provider). **Core** providers (all five ports) attach from the shared embedded
   file. **Language-specific** vocabulary (a TS-only D1 attr, a JVM binding facet
   — what `registry-conformance` already *excludes*) carries its description
   in-code in the provider. **Library/module-specific** vocabulary shared by a
   *subset* of ports ships its own descriptions fragment, embedded only in the
   ports that include the module. One mechanism, three scopes — strictly better
   than "every port loads common + specific," which can't express
   "consistent across the 3 ports that ship this module."
4. **Docs = derived from the LIVE registry (accurate-by-construction), tiered.**
   The doc-gen reads the registry *dump*, never the descriptions file directly
   and never provider source. The dump comes from walking the live registry, so
   in-code descriptions flow through for free and the docs cannot list a type
   that isn't registered (no drift — the sin `meta verify` exists to prevent).

## 3. Data model — the registry dump (the grown manifest)

`expected-registry.json` grows from `{ type, subType, attrs:[{name, valueType,
isArray, required}] }` to carry descriptions and provenance. Each **type/subtype**
and each **attr** gains:

| Field | Required | Meaning |
|---|---|---|
| `description` | **yes** (gate-enforced) | one-line "what it is" — the only field `INDEX.md` shows |
| `provider` | yes | the registering provider id (groups the provider detail pages) |
| `example` | no | tiny snippet, shown only in the provider detail page |
| `whenToUse` | no | short intent / "use this not that", provider detail page only |
| `deprecated` / `replacedBy` | no | lifecycle, surfaced in docs + a deprecation note |

The **richness lives in the tiering, not the data**: every entry needs the
required one-liner (gate-enforced, shown in `INDEX.md`); `example`/`whenToUse` are
optional and surface only when the LLM follows a link into the deeper provider
page — keeping default context lean.

## 4. Source files + attach mechanism

- **`spec/metamodel-descriptions.json`** — the single hand-authored source for
  **core** descriptions, keyed by `type.subType` and `type.subType@attr`. Neutral
  (no language-specific phrasing). Embedded into each port at build as a generated
  constant (the existing template-embedding pattern), with a byte-identity gate
  proving the embedded copy matches the source.
- **Core providers** attach descriptions at registration by looking up the
  embedded source by `type.subType`/`@attr`. They do **not** hardcode strings (that
  would be the duplication-×5 anti-pattern).
- **Language/module-specific providers** declare their descriptions **in-code** at
  registration (they are the sole owner; nothing to share — or, for a module
  shared by a subset, the module ships its own embedded fragment).
- The registry node gains a `description` slot (+ the optional fields) per
  type/subtype/attr, populated at registration. This is metamodel-about-the-
  metamodel; it never touches instance metadata and is distinct from the existing
  `commonAttrs` doc layer (`description`/`title`/`notes` on instance nodes).

## 5. Conformance — `registry-conformance` extended

The existing gate (each port emits its registry manifest, byte-matched to
`expected-registry.json`) is extended so the manifest carries descriptions:

1. **Coverage (strict-provenance for docs):** every registered type/subtype/attr
   MUST have a non-empty `description`. A new subtype or attr with no description
   fails CI — exactly mirroring ADR-0023's "every attr traces to a provider."
2. **Core identity:** for the shared/core entries, the `description` is
   byte-identical across all five ports (true *by construction* — all five embed
   the same source file; the gate proves the embed didn't drift).
3. **Language-specific:** entries that `registry-conformance` already treats as
   per-port (the excluded/composed set) carry their description in that port's own
   manifest section; the gate asserts presence, not cross-port identity.

`expected-registry.json` is regenerated to include descriptions (the core ones
joined from `spec/metamodel-descriptions.json` via the TS reference's live
registry). It remains the gate target — not the source the ports embed — so the
check is not circular: each port re-derives its registry from *its* embedded copy
and is asserted equal.

## 6. Doc-gen — one neutral engine, tiered output

A neutral Tier-2 doc engine (TS reference, the same tier as the existing `meta
docs` model engine — ADR-0020/0022) consumes the registry dump and emits:

- **`metamodel/INDEX.md`** — every `type.subType`, its one-line description, and a
  link to its provider's detail page. Small, context-cheap, always-on for the LLM.
- **`metamodel/providers/<provider-id>.md`** — full detail for the vocabulary that
  provider owns: each subtype, each attr with `valueType`/`required`/`description`
  and (where present) `example`/`whenToUse`. The LLM follows a link here only when
  it needs depth — the same on-demand-fragment pattern the `metaobjects-*` skills
  already use (`references/<token>.md`).

Cross-port: the **core** pages are byte-identical (neutral, rendered once);
each port's dump additionally yields its **language-specific** provider pages. A
**native per-port renderer** is a follow-on (the same deferral the polyglot
api-docs carry — ADR-0027); until then the neutral TS engine renders any port's
dump. Surface: a `meta docs --metamodel` subcommand (TS) emits the reference; the
output is byte-gated like the other docs corpora.

## 7. LLM delivery

The generated `metamodel/` markdown is wired into the agent-context the
`metaobjects-authoring` skill ships (via `meta init` / the agent-context
assembler): `INDEX.md` is referenced always-on, the provider pages are pulled
on-demand. This is the concrete answer to "give Claude Code better info about the
metamodel" — accurate-by-construction, context-tiered, and identical wherever the
core metamodel is.

## 8. Out of scope / boundaries

- **Instance-level documentation** (`description`/`title`/`notes` on a user's
  field/entity — the existing `commonAttrs` layer) is unchanged and separate.
- **No behavior change.** Descriptions are metadata-about-the-metamodel; they never
  drive codegen or runtime (so embedding-not-runtime-loading keeps it AOT-safe and
  is purely additive).
- **No new authoring DSL.** The source is a flat JSON map; the docs are generated.

## 9. Open items (settle at planning)

1. Exact shape of the per-port "language-specific provider declares descriptions
   in-code" API (a `description`/`whenToUse` slot on the provider's
   type/subtype/attr registration calls) — confirm it is ergonomic in all five
   ports.
2. Whether `example` snippets are validated against the loader at doc-gen time
   (so a doc example can't be invalid metadata) — desirable (accurate-by-
   construction), confirm cost.
3. The native per-port metamodel-doc renderer (vs. TS-neutral-only) — deferred,
   tracked with the existing polyglot-docs follow-on.
4. Whether to also publish the metamodel reference to `metaobjects.dev/llms.txt`
   alongside the agent-context wiring.

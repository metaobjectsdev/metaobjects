# FR-004 — Cross-language prompt construction: typed prompt value-objects, a Mustache render engine, provider-resolved prompt text & render conformance

**Date:** 2026-05-22
**Status:** Design (north-star; implementation plan deferred until FR-003 lands)
**Target version:** `7.0.0` (developed as `7.0.0-SNAPSHOT`; consumes FR-003 projections — see *Dependencies*)
**Scope:** Make LLM prompt construction a first-class MetaObjects capability. Declare a prompt's **input payload** as a projection value-object (Layer 1, reusing FR-003), declare the prompt's **text + composition** as first-class `prompt.*` metadata (Layer 2), and ship a **logic-less Mustache render engine** that turns `(payload VO) + (provider-resolved template text) → final prompt string`, byte-identical across TS/Java/Python/C#. Prompt text is **external-only**, addressed by a backend- and locale-agnostic **logical reference**; a runtime-configured **provider** resolves the backend (filesystem / NoSQL / RDB), the locale, and any A/B / dynamic / evolutionary selection. This is roadmap **H6 (AI-collaboration capabilities)**. The first consumers are server-side Java and (later) Python applications; each consumer's adoption is tracked in its own repository.

## Background

Every consuming application that talks to an LLM tends to hand-assemble prompts imperatively — commonly many thousands of lines across several `StringBuilder`-style builders that read repositories *inside* the builder, so a prompt can't be produced without a live DB and can't be tested without one. The same rule text is independently restated across calls; a large fraction of each prompt is static boilerplate re-sent every turn; A/B testing requires pulling generated prompts out of the database into a separate one-off script ecosystem. There is **no declared shape** for a prompt's inputs, so payload drift and bloat are invisible. Each AI application re-solves the same problems in its own language with its own ad-hoc patterns.

MetaObjects already supplies the load-bearing pieces:
- **Projections** (FR-003): `object.value`/`object.entity` + `source.dbView` + `origin.passthrough`/`origin.aggregate`, materializing as `ValueObject`s — exactly the "all the data needed to build a prompt" shape (the *prompt-construction value objects*).
- **A polyglot loader + canonical serializer + shared conformance fixtures** (`fixtures/conformance/`, `spec/conformance-tests.md`) that already enforce byte-identical metadata semantics across TS/Java/C# (Python post-H3) — the precise machinery a byte-identical *render* needs.
- **Mustache codegen** (`codegen-mustache`) — the template engine is already in the Java toolchain.
- **Meta Forge** descriptive types (`decision`/`principle`/`convention`/`glossary`) explicitly built "for downstream readers (codegen prompts, MCP exposers)" — i.e. metadata was always meant to feed prompts.

What does **not** exist yet, and is the substance of this FR: the `prompt.*` metatype, the provider-resolved external-text addressing model, the cross-language Mustache render engine + resolver, render-time validation of template-against-payload, and the render conformance corpus.

## Cross-language alignment (durable contract vs. idiomatic surface)

Following FR-003's split: the **durable contract** is identical across languages; the **runtime surface** is idiomatic per language.

- **Durable (must be byte-identical, conformance-gated):** the `prompt.*` metadata vocabulary; the logical-reference grammar (`group → source → section`); the **section-addressable text format**; and the **rendered output** of `(fixed payload) + (fixed template text)` through the Mustache engine. Two languages given the same payload + same resolved text **must emit the same prompt string**.
- **Idiomatic (not parity-scoped):** the concrete `PromptSourceProvider` implementations (a Java Spring `DataSource`-backed RDB provider, a TS filesystem provider, a Python Neo4j provider…), caching, and how the host app populates the payload VO. These are runtime, like OMDB vs. Kysely in FR-003.

Mustache is the keystone of the byte-identical guarantee: it is the **only** mainstream engine with a published cross-language spec **and a shared conformance suite** (`mustache/spec`), faithful implementations in all four targets, and logic-less semantics (no per-port helper drift, no code execution from runtime-sourced text). We adopt the engine; we do **not** build a parser. `{{ }}` does not collide with the XML-heavy prompts these consumers emit.

## Capabilities

### 1. Layer 1 — the prompt payload is a projection value-object (reuse, not new)
The "object payload" — all data a prompt needs and nothing else — is an `object.value` projection (FR-003 §5): passthrough + aggregate fields over `source.dbView`, materialized as a `ValueObject`, with app-side cached fields overlaid by the host. **No new metatype is introduced for the payload.** This makes the payload the single declared input surface per prompt, so unused/orphan fields (payload bloat) are detectable, and the projection codegen (FR-003 §6) already emits the per-language VO class.

### 2. Layer 2 — `prompt.*` as a first-class metatype
A new base type `prompt` with subtypes:
- `prompt.template` — a renderable unit bound to one payload VO. Reserved/`@`-attrs: `@payloadRef` (the `object.value` projection it renders against), `@textRef` (the logical reference to its body), `@outputFormat` (e.g. `xml`/`json`/`text`), `@requiredSlots` (slots that must resolve — drives `verify`), `@maxChars`/`@maxTokens` (size budget), governance attrs (`@owner`, `@since`).
- `prompt.fragment` — a reusable text unit (the shared rule blocks that are triplicated across calls today live here **once**), addressed by `@textRef`, includable by templates/fragments as a partial.
- `prompt.section` *(optional, may fold into addressing)* — a named region within a source; primarily a resolution concept (see §3) rather than a node, unless a consumer wants per-section governance.

`prompt.*` nodes support the existing metamodel mechanics: `extends` (a fragment specializes another), `overlay` (re-open a node to override — the basis for variants and locale, §5), and references (`@textRef`, `@payloadRef`, partial includes). Composition is **catalogued in metadata** (which fragments exist, what payload binds, what constraints hold) but **assembled in text** via Mustache partials (§4) — metadata stays the registry + contract, not the assembly program.

### 3. External-only text addressing: a logical reference resolved by a provider
Prompt text is **never inline** in metadata. A `@textRef` is a backend- and locale-agnostic **3-layer logical reference**:

```
group  (L1)  →  source (L2)  →  section (L3)
```

A runtime-configured **`PromptSourceProvider`** maps the reference onto a backend and resolves the **active locale**:
- **filesystem** (default; the conformance + dev provider): L1 = folder, L2 = file, L3 = a named section within the file.
- **RDB**: L1/L2/L3 → table / key / section column (or a `(namespace, document, key)` scheme).
- **NoSQL / graph** (e.g. Neo4j, Qdrant): L1/L2/L3 → collection / document / field-path.

The metadata reference is **identical across environments**; only the configured provider changes. **Sections are what make external-only ergonomic**: one reviewable file (or document) holds many fragments, so external-only does *not* devolve into tiny-file sprawl. A portable **section-addressable text format** (a single language-agnostic delimiter grammar) is defined here and added to the conformance corpus so all four language ports parse sections identically.

**Locale is a runtime concern, never in metadata.** Given a reference + active locale, the provider returns the locale-specific variant with fallback to the default locale (filesystem: a locale-suffixed file/section or a locale subtree; RDB/NoSQL: a `locale` filter). Adding a locale is additive — a new bundle/overlay touching nothing else. Consumers translate **selectively**: instruction scaffolding can stay default-locale + a per-locale "respond in X" directive, while player-facing fragments carry true per-locale text.

### 4. The render engine: Mustache + a provider-backed partial resolver
A pure function `render(template, payloadVO, provider, locale) → string`, ported per language and conformance-gated:
- **Data injection** — Mustache variables resolve against the **payload VO**: `{{npcName}}`, iteration `{{#hostileNpcs}}…{{/hostileNpcs}}`, presence-conditional inclusion, and fallback via inverted sections `{{^x}}…{{/x}}`. (No custom default syntax; logic stays out of templates — precompute on the VO or use inverted sections.)
- **Composition = includes = provider lookups** — a partial reference encodes the same 3-layer address, e.g. `{{> group/source#section }}`. The resolver fetches the partial through the **same `PromptSourceProvider`**, honoring locale and caching. The rules triplicated across calls today become one `prompt.fragment` included everywhere.
- **No I/O in the engine itself** beyond delegating partial resolution to the injected provider; given a fixed provider the function is deterministic.

### 5. Variants, A/B, dynamic & evolutionary prompts — all through one seam
The logical-reference + pluggable-provider indirection is what lets prompts be static, A/B'd, dynamically assembled, or evolutionarily optimized **without touching metadata or the engine** — the metadata "just points," the provider gets smarter:
- **Static** — filesystem provider returns fixed text.
- **Runtime A/B** — a provider serves variant A vs B for a reference by experiment policy (session-hash, config); `overlay` expresses variants in metadata where they should be first-class.
- **Dynamic / evolutionary** — a Neo4j/Qdrant-backed provider (a graph-assembled prompt registry / promptbreeder-style optimizer) returns a graph-assembled or fitness-selected variant for the same reference.

**Determinism boundary:** dynamic/evolutionary providers are non-deterministic and therefore **out of byte-identical conformance scope**. Conformance always pins a **fixture provider** (deterministic, in-memory/filesystem). Dynamic behavior is a production capability validated by A/B / eval scoring and by the `verify` resolution check — never by the render-conformance corpus.

### 6. Validation: `verify` proves template ⇆ payload ⇆ source agree
Because we hold the payload VO metadata, the template, and the source text together, validation is static and build-time:
- **Reference resolution** — every `@textRef` and every `{{> partial }}` resolves in the configured provider (CI against the filesystem provider; loud startup validation in the host). A missing section fails **loud**, never silently.
- **Slot/payload conformance** — every `{{var}}`/`{{#section}}` in a template resolves to a real field on its `@payloadRef` VO, and every `@requiredSlots` slot is present. Drift between a prompt and its payload is caught at build time — delivering the "see drift and bloat in the payload" goal directly.
- **Capability/budget guard** — a rendered prompt must preserve required output-format tags and stay within `@maxChars`/`@maxTokens`; a variant that strips a format tag or blows the budget fails.

### 7. Codegen
Per-language emission (build-time, via the existing generator interface — ts-poet/TS, Mustache/Java) for: the **payload VO class** (already from FR-003 projection codegen), a typed **template handle** per `prompt.template` (its reference, payload type, required slots, output format, budget — so callers invoke a generated, type-checked entry point rather than a stringly-typed lookup), and a **fragment catalog**. Generated artifacts carry no business logic and **no MetaObjects runtime dependency** (per the framework philosophy); the render engine + providers are the runtime libraries consumers depend on.

### 8. Packaging — isolated modules in this monorepo
**Decided: monorepo, not a separate `metaobjects-ai` repo.** The byte-identical-render goal is enforced by the shared conformance fixtures + canonical serializer that already live here, and the `prompt.*` metatype is a metamodel extension that must live in core loaders regardless — splitting the engine into another repo would fracture an atomic thing and re-introduce the cross-repo lockstep FR-003 explicitly avoided. Mitigations preserve the separate-repo upsides:
- **Metatype + loaders + conformance fixtures → core** (they must be).
- **Render engine + resolver + section parser + golden harness → isolated, separately-published modules** (`@metaobjectsdev/prompt-*` in TS; a `metaobjects-prompt` Java module/reactor; Python post-H3), **not** folded into core proper.
- **Path-scoped CI + per-package publishing** so non-AI consumers don't pay, and the AI modules keep cadence independence inside the monorepo.

### 9. Conformance fixtures
Extend the corpus with: the `prompt.*` vocabulary (loader/serializer parity); the section-addressable text-format grammar; and a **render-conformance suite** — `(payload fixture JSON) + (template + fragments via the fixture provider) → expected rendered string`, asserted byte-identical across every shipped language port. Runtime-provider behavior (RDB/NoSQL/A-B/evolution) is **out of parity scope**, matching FR-003's treatment of ObjectManager runtimes.

## Dependencies

- **FR-003 (OMDB + projections + 7.0.0)** — Layer 1 payloads are FR-003 projections; the RDB `PromptSourceProvider` rides FR-003's Spring-transaction-aware connection. This FR **cannot start until FR-003 ships** (at least `7.0.0-M1`/`-RC`).
- **H3b Java conformance harness** — the render-conformance suite extends it.
- **Mustache** — adopt mature ports (`mustache.java`, `mustache.js`/hogan, `chevron`/`pystache`, `Stubble`/`Nustache`); pin to spec-conformant versions; the `mustache/spec` suite is a prerequisite oracle.

## Versioning & compatibility

Ships within `7.0.0` (additive on top of FR-003): a new metatype, new isolated modules, new conformance fixtures. No breaking change beyond what FR-003 already mandates for the `6.x → 7.0.0` boundary. The `prompt.*` vocabulary is additive to the metamodel; per-package versioning lets the prompt modules iterate ahead of a core point release.

## Out of scope
- The host-side **Assembler** (repos → payload VO), prompt **content**, LLM-client wiring, and domain eval — these live in each consumer application.
- Concrete production providers beyond the **filesystem** default (RDB/NoSQL/graph providers are specced as interfaces here; a given consumer ships its own).
- **Promptbreeder-style evolution / vector prompt registries** as built features — this FR defines the provider seam that *enables* them, not the optimizer itself.
- Byte-identical conformance of **non-deterministic** (dynamic/evolutionary) provider output — permanently out of parity scope.
- C# **render engine + codegen** if C# stays loader-only per current roadmap (C# gets the metatype/loader/conformance; render port follows when C# codegen/runtime is in scope).
- Localization of free-form *content* the host already produces in the player's language (NPC names, player text) — only declared prompt text is localized here.

## Open questions (resolve during planning)
1. **Section format grammar** — heading-based (`## section-id`) vs. explicit delimiter markers; whitespace/trailing-newline normalization (must be pinned for byte-identical render).
2. **Logical-reference encoding in `@textRef`** — single fused string (`group/source#section`) vs. three structured attrs; and whether L3 is always required or may default to "whole source."
3. **Variant/locale via `overlay` vs. provider** — which selection lives in metadata (`overlay`) vs. purely runtime (provider policy), and how the two compose.
4. **Partial recursion + cycle detection** — depth bound and cycle guard for `{{> }}` chains across the provider.
5. **Caching/invalidation contract** — the cache-key shape (reference + locale + variant) and the invalidation signal for RDB/NoSQL providers; whether it's part of the engine contract or per-provider.
6. **Type fidelity of payload slots** — how richly the `verify` slot-check models VO field types (presence-only vs. type-aware), given Mustache is untyped.
7. **`prompt.section` as a node** — keep addressing-only, or promote to a governed node for per-section ownership/versioning.

## Testing
- **Loader/serializer conformance** for `prompt.*` vocabulary.
- **Section-parse conformance** — same source → identical section map across language ports.
- **Render conformance** — `(payload + template + fragments) → byte-identical string` across ports (the headline guarantee).
- **`verify` checks** — unresolved reference, missing required slot, `{{var}}` not on payload VO, partial cycle, budget overflow, stripped output-format tag → each fails loud.
- **Provider contract tests** — filesystem provider + a fake RDB/NoSQL provider satisfy the same resolution + locale-fallback contract.
- **Determinism** — fixture provider yields identical output across runs; dynamic provider explicitly excluded from determinism assertions.

## Cross-references
- Persistence/projection substrate: `docs/superpowers/specs/2026-05-22-fr-003-omdb-persistence-schema-migration-projections-design.md`.
- Consumer adoptions are tracked in each consuming application's own repository (out of scope for this public spec).
- Prior-art prompt patterns (runtime prompt registry, evolutionary optimization, capability/budget validation, one-definition→many-targets) informed this design.
- Metamodel vocabulary: `spec/metamodel.md`; conformance contract: `spec/conformance-tests.md`; wire format: `spec/wire-format.md`.
- Codegen substrate: `codegen-mustache` (Java), `typescript/packages/codegen-ts`.
- Roadmap context: `spec/roadmap.md` (H6 AI-collaboration capabilities expansion).

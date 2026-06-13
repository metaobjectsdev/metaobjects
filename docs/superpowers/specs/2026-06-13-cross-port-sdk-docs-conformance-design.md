# Cross-port native SDK-docs conformance gate + C#/Python/Kotlin implementations (design)

_Status: APPROVED — 2026-06-13._

## Problem

Native SDK / API reference docs (Tier-1, idiomatic per language) ship today in **TypeScript**
(`meta docs` → `api/ts`) and **Java** (`mvn metaobjects:docs` → `api/java`) only. **C#, Python,
and Kotlin have no native SDK-docs surface** — they expose only `agent-docs` (the Claude
agent-context scaffold, an unrelated artifact). Nothing in the conformance corpus detects this
gap, so "a per-language SDK reference" reads as a five-port guarantee when it is a two-port one.

We need a cross-port conformance gate that (1) makes the missing ports **fail red**, and (2) is
satisfied only when C#/Python/Kotlin emit idiomatic native SDK docs that are **accurate by
construction** — the same bar TS and Java already meet.

Distinct from the **model docs** (Tier-2 neutral: entity reference + ERD + `template.output`
pages) which are a single shared TS-owned engine. This design is about the **SDK / API surface**
only (the per-language idiomatic reference), which is native per port.

## Decisions (locked in brainstorming)

1. **RED = hard-fail now (TDD red→green).** The shared contract requires all five api surfaces;
   the C#/Python/Kotlin cross-port runners fail until each port is implemented. CI/main is red
   from the gate commit until the third port lands (accepted; the three implementations are
   sequenced tightly to keep the red window short — no side branches per project convention).
2. **Full accuracy-by-construction.** A new port turns green only when every documented symbol
   matches a real exported identifier from that port's **actual generators** (naming-seam reuse,
   never re-concatenation) plus an inverse no-over-documentation check — exactly the TS/Java bar.

## Architecture

### Two-layer gate

1. **Shared cross-port contract** — `fixtures/conformance/api-docs-cross-port/expected-paths.json`.
   Every port documents the *same unit set* at the *same relative layout*, with resolving
   model↔api cross-links. **This layer goes red for a missing port** (no `api/<lang>` pages).
2. **Per-port accuracy-by-construction** — one test per port (mirrors
   `JavaApiDocsAccuracyTest`): every documented symbol matches a real exported identifier from
   that port's generators; inverse check forbids documenting a symbol the generator did not emit.

### The shared manifest — one file, five surfaces

Extend `expected-paths.json`:

- Add `apiCsharpSubDir: "api/csharp"`, `apiPythonSubDir: "api/python"`, `apiKotlinSubDir: "api/kotlin"`.
- Each unit gains `apiCsharpPath` / `apiPythonPath` / `apiKotlinPath` and the cross-link hrefs
  (`modelToApiCsharp`/`apiCsharpToModel`, etc.).
- Path math is deterministic per surface (`docPageOutputPath(layout, pkg, node)` under each
  subdir), so the **TS oracle** (`UPDATE_CONTRACT=1 bun test`) regenerates the full manifest even
  though TS does not emit the C#/Python/Kotlin pages. The existing TS + Java runners keep asserting
  their slices; three new runners assert the new slices.

### The canonical SDK-page contract (idiomatic per port)

Identical *structure* to TS/Java, idiomatic *content*. Per surface:

- Per-unit `<Node>.md`: header → model back-link (`**Model / metadata:** [Node](href)`) →
  optional Setup (runtime handles) → optional worked Example → **symbol sections grouped by kind**
  in canonical order; each symbol: signature · one-line usage · exact import · optional field
  table (Field/Type/Required/Notes) · optional throws.
- `README.md` — human index (entities vs templates, symbol-count summary).
- `AGENT-API.md` — token-frugal agent form (symbols grouped by import, no prose/tables).

Per-port idiomatic symbol kinds (core kinds shared; extras per stack):

| Port | model | data-access | rest | validation | extras |
|---|---|---|---|---|---|
| **C#** (EF Core / ASP.NET) | entity class | `AppDbContext` / `DbSet` | minimal-API routes | validators | extractor · render · payload · prompt |
| **Python** (Pydantic / FastAPI / ObjectManager) | Pydantic model | `ObjectManager` | FastAPI routes | validators | extractor · render · payload · prompt |
| **Kotlin** (KotlinPoet / Exposed / Spring) | data class | Exposed table / DAO | Spring controller | validator | extractor · render · payload · prompt |

A port documents only the kinds its generators actually emit (the inverse accuracy check enforces
this — e.g. no REST section for an entity whose generator suppresses routes).

### Kotlin is its own `api/kotlin` surface

Kotlin's idiom (Exposed / KotlinPoet) is distinct from Java's Spring DTO output, so it must NOT
reuse Java's `DocsMojo` page output. A `KotlinApiModelBuilder` lives in `codegen-kotlin`; the
Maven `DocsMojo` gains a `language` / surfaces parameter to emit `api/java` and/or `api/kotlin`.

### Where code lives + the command per port

| Port | Builder/renderer home | Command | Accuracy test home |
|---|---|---|---|
| **C#** | `MetaObjects.Codegen` — `CSharpApiModel` + builder + renderer | `dotnet meta docs` (new case in `MetaObjects.Cli/Program.cs`) | `MetaObjects.Codegen.Tests` |
| **Python** | `metaobjects` codegen pkg — `api_model` + builder + renderer | `metaobjects docs` (new subparser in `cli.py`) | pytest |
| **Kotlin** | `codegen-kotlin` — `KotlinApiModel` + builder + renderer | `mvn metaobjects:docs` (language param) | JVM test (`codegen-kotlin`/`integration-tests-kotlin`) |

Each builder enumerates symbols **through the real generators' naming seam** and gates inclusion
on each generator's `appliesTo`-equivalent (the Java SP-2a pattern). Where a port lacks a naming
seam, extracting one (behavior-preserving) is part of that port's phase.

### Model-docs cross-link

Extend the model-docs `apiSurfaces` list (ADR-0027 already supports a list) so each model page
renders all five `**API reference:**` links (TypeScript · Java · C# · Python · Kotlin), resolving
in both flat and package layouts via `apiSurfaceHref`.

## Sequencing

- **Phase 0 — the red.** Extend the shared manifest to five surfaces; regenerate via the TS
  oracle; add the three failing cross-port runners (C# xUnit, Python pytest, Kotlin JVM). CI red.
- **Phase 1 — C#.** `CSharpApiModel` + builder (naming-seam reuse) + renderer (3 page types) +
  `dotnet meta docs` + accuracy test → C# cross-port runner green.
- **Phase 2 — Python.** Same shape → Python runner green.
- **Phase 3 — Kotlin.** `KotlinApiModelBuilder` in `codegen-kotlin` + `DocsMojo` language param +
  accuracy test → Kotlin runner green. Model-docs five-surface cross-links finalized.

Each phase is independently shippable and conformance-gated; the red window spans Phase 0→3.

## Testing

- Cross-port path/coverage/cross-link contract (the gate) — TS oracle + five per-port runners.
- Per-port accuracy-by-construction (forward + inverse) — one test per new port.
- Reuse the existing shared input `fixtures/conformance/api-docs-cross-port/input/meta.json`
  (Customer / Order / OrderSummary / OrderSummaryPayload).
- Cross-port strict runners that glob the shared corpus get the existing `isContractOnly` skip
  treatment where they do not own this surface.

## Out of scope

- Changing the model-docs (Tier-2) engine. Only its `apiSurfaces` list grows.
- Federated/`baseUrl` polyglot hosting (ADR-0027) — unchanged; relative one-tree layout here.
- New symbol kinds beyond what each port's generators already emit.

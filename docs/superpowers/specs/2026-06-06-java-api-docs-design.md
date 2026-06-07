# Java api-docs surface (SP-2) — design

**Date:** 2026-06-06
**Status:** Design (pending review)
**Relates to:** ADR-0027 (polyglot docs composition — SP-2 makes Java emit the `api/java` surface into that contract), ADR-0025 (unified docs door), ADR-0022 (api-docs = Tier-1 per-port). SP-1 (the `apiSurfaces` contract) is the foundation.

## Goal

Document the **Java** generated SDK surface as a per-project api reference, emitted into SP-1's `apiSurfaces` contract so a polyglot TS+Java solution gets ONE cross-linked doc tree: TS emits `model` + `api/ts`, Java emits `api/java`, all cross-linking to the single shared model doc set. Accurate-by-construction: the Java api-docs documents what the **real Java generators** emit, reusing their naming — never inventing symbols (the discipline the TS api-docs and the accuracy gate established).

## Critical framing: the Java surface DIVERGES from TS

This is NOT a mechanical port. Java api-docs must document the **Java-idiomatic** surface, not mirror TS:

| Category | TS | **Java (what to document)** |
|---|---|---|
| model | `interface/const <Name>` | `class <Name>` (flavor: PojoObject/ValueObject) — `JavaObjectCodeGenerator` |
| dto | implicit | `record <Name>Dto(… Jakarta-annotated fields)` — `SpringDtoGenerator` |
| data-access | free fns `findById/list/create/update/deleteById` | `interface <Name>Repository` (consumer-implemented): `list/count/findById/create/update/delete` + M:N finders `find<Rel>(srcId)` — `SpringRepositoryGenerator` |
| rest | Fastify/Hono registrar | `@RestController @RequestMapping("/api/<plural>")` class; GET list/GET {id}/POST/PATCH+PUT {id}/DELETE {id} + `GET {id}/<rel>` — `SpringControllerGenerator` |
| validation | Zod `<Name>Insert/UpdateSchema` | Jakarta annotations ON the DTO record (`@NotNull/@NotBlank/@Pattern/…`) — part of `SpringDtoGenerator` |
| extractor | `extract<Name>/extractLenient<Name>(root,text)` | `<Name>Extractor.extract(loader,text)` + `.extractLenient(loader,text)` — `ExtractorCodeGenerator` |
| render | `render<Name>(payload,provider)` | `<Name>RenderHelper.render(payload,provider): String` (+ `EmailDocument` for email) — `SpringRenderHelperGenerator` |
| payload | implicit | `record <Name>Payload(…)` with `toMap()/fromMap()` — `SpringPayloadGenerator` |
| prompt | `render<Name>` in `prompts.ts` | `<Name>Prompt.outputFormat(): String` — `SpringOutputPromptGenerator` |
| output-parser | (lenient extract) | `<Name>OutputParser.parse/parseStrict(text)` — `SpringOutputParserGenerator` |
| filter | implicit | `<Name>FilterAllowlist.FIELDS / OPS_BY_FIELD` — `SpringFilterAllowlistGenerator` |
| trace | `record<Entity>` + `call<Entity>` | `<Name>LlmTraceHelper.record/buildLlmCallRow` — **NO `call<Entity>`** (BYO LLM, ADR-0024) |
| callable | `call<Entity>` | **none** (omit) |

Scope decision (user): **document the FULL surface** in the first increment.

## Architecture

Three pieces, mirroring the proven TS structure but Java-native:

### 1. `JavaApiModel` IR (Java)
A Java port of the `ApiModel` IR: per **unit** (entity or template), a list of `ApiSymbol`s grouped by category, each carrying `{ name, kind, importFqn, signature, params, returns, throws, usage, example?, fields? }`. Built by **reusing the real Java generators' naming** — the same generator classes (`SpringDtoGenerator`, `SpringRepositoryGenerator`, `SpringControllerGenerator`, etc.) that emit the code, so the documented names cannot drift from the generated names. Skip rules honored exactly (value object → model-only; TPH subtype → model-only; `@emitRoutes:false` → no controller; etc., matching each generator's own filter).

- **Accuracy gate (the keystone):** a Java conformance test runs the REAL generators on a rich fixture, builds the `JavaApiModel`, and asserts every documented symbol name appears as an identifier in the real generated Java (forward) and that skip shapes are not over-documented (inverse) — the Java equivalent of `api-docs-accuracy.test.ts`. This is what makes "accurate by construction" enforceable.

### 2. Native rendering (Java)
Render Java-idiomatic api pages + a `README.md` index + an `AGENT-API.md` condensed form, via the **JVM Mustache `Renderer`** (the engine the Spring render-helper generator already uses) with **Java api templates** (own copies — the page STRUCTURE mirrors the TS api templates for cross-port familiarity, but content is Java: ` ```java ` fences, repository-interface framing, Jakarta-validation field tables, Spring wiring in the setup preamble). Not byte-shared with the TS templates (api-docs is Tier-1 per-port; the TS template hardcodes ` ```ts `).

- **Setup preamble (Java):** how an adopter wires the generated surface — Maven coordinate, the `<Name>Repository` they implement, Spring component scan for the controller, the `MetaDataLoader` for extractors, the `Provider` for render helpers. Verified against the real runtime API (no invented types) — the Java equivalent of the TS setup-preamble gate.
- **Agent-usability:** the `AGENT-API.md` carries imports (FQNs) + signatures + field shapes + an example per unit, so an agent can call the generated Java without reading the source — Java equivalent of `api-docs-agent-usability.test.ts`.

### 3. Emission into the `apiSurfaces` contract + the docs goal
- Output placement + cross-links must be **byte-compatible** with SP-1: api pages at `<subDir>/<package-folded>/<Name>.md` (default `subDir="api/java"`), each linking back to the model root via the same path math as `apiSurfaceHref`/`docPageOutputPath`/`surfaceCrossHref` — **reimplemented in Java** (a small `DocsPaths` Java util, conformance-gated byte-identical to the TS helper for the same inputs). The `**Model / metadata:** [<Name>](<relative-or-baseUrl>)` cross-link string matches what the TS api page emits.
- **Invocation:** a Maven goal (mirror `AgentDocsMojo`) — `metaobjects:docs` — reads the docs config's `apiSurfaces` filtered to the Java-owned entry (`lang: "java"`), and runs the Java api-docs generator into that entry's `subDir` (+ `baseUrl` for federation). Register `JavaApiDocsGenerator` as the native `api-docs` generator in `GeneratorRegistry` (stable name `api-docs`, matching the cross-port registry manifest). Model docs are NOT emitted by Java (they come from TS); `metaobjects:docs` emits only the api surface.

## Cross-port end-to-end conformance (the SP-2 headline proof)
A fixture exercised by BOTH ports producing ONE cross-linked tree:
- TS `meta docs` (or the docsFile+apiDocsFile emit) → `model` pages + `api/ts/…`; declares `apiSurfaces:[{lang:ts,subDir:api/ts},{lang:java,subDir:api/java}]` so the model page links BOTH.
- Java `metaobjects:docs` → `api/java/…`, cross-linking back to the model root.
- A conformance test asserts: every cross-surface link in the combined tree resolves to a real emitted page (model↔api/ts, model↔api/java), flat + package; and the Java api page names match the real Java generated symbols (accuracy). This is the proof that the polyglot tree works end-to-end across the two toolchains.
- Update `fixtures/generator-registry-conformance/registry.json`: `api-docs` `ports: ["typescript","java"]`; Java's registry conformance test then requires it.

## Decomposition (each its own spec→plan→build)

SP-2 is large; build in three phases:

- **SP-2a — `JavaApiModel` IR + accuracy gate.** Full-surface symbol derivation by reusing the real Java generators; the Java accuracy conformance gate. No rendering yet. Deliverable: a tested IR proving documented==generated for every category.
- **SP-2b — Native rendering + the `metaobjects:docs` goal + contract emit.** Java api templates + JVM-Mustache renderers (entity/template page + index + AGENT-API), the Java `DocsPaths` util (cross-link math, byte-gated vs TS), the Maven goal, registry registration, setup-preamble + agent-usability gates. Deliverable: `metaobjects:docs` emits a valid `api/java` surface with working cross-links.
- **SP-2c — Cross-port end-to-end conformance + manifest.** The TS+Java one-tree fixture + the cross-surface link-integrity conformance across both toolchains; registry manifest adds `java`; agent-context/docs pointers updated. Deliverable: the polyglot tree proven end-to-end.

This spec is the architecture-of-record for all three; SP-2a gets the first implementation plan.

## File structure (SP-2a focus; later phases extend)
- `server/java/codegen-spring/src/main/java/com/metaobjects/generator/apidocs/JavaApiModel.java` (+ `ApiSymbol`, `FieldShape`, `UnitExample` records) — the IR.
- `…/apidocs/JavaApiModelBuilder.java` — derives the IR by reusing the generator classes' naming (inject/call the same name-producing logic the generators use; do NOT duplicate naming).
- `server/java/codegen-spring/src/test/java/com/metaobjects/generator/apidocs/JavaApiDocsAccuracyTest.java` — the accuracy gate (real generators vs IR), over a rich fixture under `fixtures/conformance/` (or a Java-test-local fixture — decide per the SP-1 fixture-hygiene lesson; prefer test-local unless it's a genuine cross-port case).
- (SP-2b) `…/apidocs/JavaApiDocsGenerator.java`, Java api templates, `…/apidocs/DocsPaths.java`, `DocsMojo.java`, `GeneratorRegistry` entry.
- (SP-2c) the cross-port fixture + conformance test; `registry.json`.

## Testing / gates
- SP-2a: accuracy (forward + inverse) over the full-surface fixture; skip-rule coverage (value object, TPH base/subtype, @emitRoutes:false, template json/email).
- SP-2b: `DocsPaths` byte-parity vs the TS path math (shared fixture of from/to → href); setup-preamble exists-in-runtime gate; agent-usability (import+signature+fields+example present); render goldens.
- SP-2c: cross-surface link integrity across the combined TS+Java tree (flat + package); registry set-equality includes java.

## Risks / open points
- **Naming reuse without duplication:** the cleanest accuracy guarantee is to call the generators' own name-producing methods. If those are private/inlined in each generator, SP-2a may need a small refactor to expose a `nameOf…`/symbol-listing seam per generator (preferred over copying naming into the IR builder — copying re-introduces drift). Flag during SP-2a.
- **Field-shape extraction:** Java field shapes come from the DTO/payload records' components + Jakarta annotations (required/optional, enum via `@Pattern`/enum type) — extract from the generated record, not invented.
- **M:N finders:** repository `find<Rel>(srcId)` + controller `GET {id}/<rel>` are per-relationship; derive from the same relationship resolution the generators use.
- **Fixture hygiene:** do NOT drop Java-test-only fixtures into the shared `fixtures/conformance/` corpus unless they're genuine cross-port cases with expectations (the SP-1 lesson). The SP-2c cross-port fixture IS a genuine cross-port case → it belongs in the shared corpus WITH expectations.

## YAGNI / non-goals
- No model-surface generation in Java (comes from TS; the deferred non-TS model engine reach stays deferred).
- No `call<Entity>` callable docs (Java has none).
- No new api page CONTENT categories beyond what Java generators actually emit.
- No sharing the TS api templates byte-for-byte (Tier-1 per-port rendering).

# Per-project generated-API reference (TS pilot) — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) tracking.

**Goal:** A new TypeScript `api-docs` generator that documents the API an
adopter's codegen produced (per entity/template, full surface), rendered two ways
from one model — human docs-site pages + index, and a condensed agent/LLM
reference — accurate by construction and drift-gated.

**Architecture:** Per ADR-0022 Part 3: `api-docs` is a **Tier-1 generator** (in
the `meta gen` registry), NOT a `meta docs` mode. It builds one `ApiModel` per
entity/template by reusing the *real* generators' naming/signature helpers (so it
can't drift), then renders human + agent forms via the **shared `render()`
Mustache engine + canonical `templates/`** (byte-identity-gated). Output lands in
`docs/api/`; the agent-context surface references the agent form (we don't edit
the sibling's install code).

**Tech Stack:** TypeScript, bun, the existing `codegen-ts` generators + their
`templates/*` naming helpers, the shared `@metaobjectsdev/render` Mustache engine
+ `FrameworkTemplatesProvider`, the ADR-0021 generator registry + conformance.

**Scope guard:** TS pilot only. Cross-port fan-out is deferred (spec open
question). Don't touch other ports, `meta docs` (neutral engine), or the
agent-context code.

---

## Reference files (read first)
- `server/typescript/packages/codegen-ts/src/generators/` — the real generators
  whose naming/signatures we reuse: `queries-file.ts` (+ `templates/queries-file.ts`
  → findById/create/updateById/deleteById/list), `routes-file.ts`,
  `extractor-file.ts` (extract<Name>), `render-helper-file.ts` (render<Name> →
  string/EmailDocument), `entity-file.ts`, the validators.
- `server/typescript/packages/codegen-ts/src/generator-registry.ts` — register `api-docs`.
- `fixtures/generator-registry-conformance/registry.json` — add `api-docs` for `typescript`.
- `server/typescript/packages/codegen-ts/src/generators/docs-file.ts` +
  `render-engine/framework-provider.ts` — the pattern for a Mustache-rendered doc
  generator + canonical-template resolution + the byte-identity gate
  (`templates-canonical.test.ts`) + `scripts/sync-doc-templates.sh`.
- `spec/decisions/ADR-0022-codegen-and-docs-surface-architecture.md` — governing decision.

---

## Task 1: `ApiModel` IR + builder (accurate by construction)

**Files:**
- Create `server/typescript/packages/codegen-ts/src/generators/api-model.ts`
- Test `server/typescript/packages/codegen-ts/test/api-model.test.ts`

The `ApiModel` is the neutral intermediate the renderers consume:
```ts
export type ApiSymbolKind = "model" | "data-access" | "rest" | "validation" | "extractor" | "render";
export interface ApiSymbol { name: string; kind: ApiSymbolKind; signature: string; params?: string[]; returns?: string; throws?: string; usage: string; example?: string; }
export interface ApiUnitDoc { node: string; nodeKind: "entity" | "template"; symbols: ApiSymbol[]; }
export interface ApiModel { units: ApiUnitDoc[]; }
```

- [ ] **Step 1:** Write `api-model.test.ts` — for a fixture model (an entity with a PK + fields + a `template.output`), assert `buildApiModel(root, ctx)` produces symbols with the EXACT names the real generators emit: `findById`/`create`/`updateById`/`deleteById`/`list` (data-access), the REST endpoints (rest), `extract<Name>`/`extractLenient` (extractor), `render<Name>` (render), the model type + validators. Run → FAIL.
- [ ] **Step 2:** Implement `buildApiModel` REUSING the real generators' naming/signature helpers (import the naming functions from `queries-file`/`routes-file`/`extractor-file`/`render-helper-file`/`entity-file` rather than re-deriving — this is the accuracy guarantee). Respect what each generator legitimately skips (no PK → no findById/updateById/deleteById).
- [ ] **Step 3:** Run → PASS. Commit `feat(codegen-ts): ApiModel IR + builder reusing real generator naming (api-docs)`.

## Task 2: Mustache templates + the two renderers (human + agent)

**Files:**
- Create `templates/api/entity-api.md.mustache`, `templates/api/index.md.mustache`, `templates/api/agent-api.md.mustache` (root canonical; `scripts/sync-doc-templates.sh` copies to the package + the byte-identity gate covers them — verify the gate/sync glob `*.mustache` recursively picks up `templates/api/`)
- Create `server/typescript/packages/codegen-ts/src/generators/api-doc-render.ts` (renderers)
- Test `server/typescript/packages/codegen-ts/test/golden/api-doc-render.test.ts`

- [ ] **Step 1:** Write the golden test — `ApiModel` (fixture) → (a) per-entity human page (sections per `ApiSymbolKind`, signature + fuller example), (b) consolidated `index` (links every unit's page + a symbol summary), (c) condensed `agent` form (one line per symbol: `name(sig) — usage`, grouped by unit, no prose). Assert byte-exact for each + the agent form is under a token/size budget. Run → FAIL.
- [ ] **Step 2:** Author the three canonical templates under `templates/api/`; run `scripts/sync-doc-templates.sh`; implement the renderers calling the shared `render()` engine with the framework provider (mirror `docs-file.ts`).
- [ ] **Step 3:** Run → PASS + `templates-canonical.test.ts` (byte-identity gate) green. Commit `feat(codegen-ts): api-docs human + agent renderers via shared Mustache engine`.

## Task 3: The `api-docs` generator + registry + emission

**Files:**
- Create `server/typescript/packages/codegen-ts/src/generators/api-docs-file.ts`
- Modify `generator-registry.ts` (register `api-docs`, tier native, description, factory) + `generators/index.ts` export
- Modify `fixtures/generator-registry-conformance/registry.json` (add `api-docs` → `{ concept, tier: native, ports: ["typescript"] }`)
- Test `server/typescript/packages/codegen-ts/test/golden/api-docs-file.test.ts`

- [ ] **Step 1:** Write the generator test — `apiDocsFile().generate(ctx)` for a multi-entity + template fixture emits `docs/api/<Entity>.md` (per entity), `docs/api/README.md` (index), `docs/api/AGENT-API.md` (agent), content matching the renderers; cross-links resolve; reuses the collision-safe path helper if multi-package (`docs-paths.ts`). Run → FAIL.
- [ ] **Step 2:** Implement `apiDocsFile` (build ApiModel → render both forms → emit files). Register `api-docs` in the registry; add to the conformance manifest. The existing `generator-registry-conformance.test.ts` (bidirectional set-equality) stays green because registry + manifest both gain `api-docs`.
- [ ] **Step 3:** Run → PASS + `generator-registry-conformance.test.ts` + `gen --list` shows `api-docs`. Commit `feat(codegen-ts): api-docs generator (registry-registered) emitting docs/api/`.

## Task 4: Accuracy / drift conformance gate (the headline guarantee)

**Files:**
- Test `server/typescript/packages/codegen-ts/test/golden/api-docs-accuracy.test.ts`

- [ ] **Step 1:** Write the drift gate — for a fixture model, run the ACTUAL generators (`entityFile`/`queriesFile`/`routesFile`/`extractor`/`renderHelper`) into a temp tree AND run `apiDocsFile`; then assert every symbol name the api-docs reference documents (`ApiModel` symbol names) actually appears in the corresponding generated `.ts` output. A generator rename ⇒ this gate fails (not the adopter's docs). Run → it should PASS once Tasks 1–3 are correct (the builder reuses the real helpers); if it FAILS, the builder drifted from a generator — fix the builder.
- [ ] **Step 2:** Commit `test(codegen-ts): api-docs accuracy gate — documented symbols ∈ generated output`.

## Task 5: Closeout
- [ ] Full TS suite: `cd server/typescript && bun test packages/codegen-ts packages/cli` green; counts. (CI already runs the whole codegen-ts suite, so the new tests + the drift gate fire in CI automatically.)
- [ ] Hygiene (merge-base diff): no private names/home paths/node_modules/bunfig/dist; generic fixtures.
- [ ] Whole-branch code-review + code-simplifier; fix findings.
- [ ] Forward-merge to main (handle the fast-moving origin via a temp worktree if the main checkout is stale/occupied, as established), push, remove worktree, update memory.

## Notes / guards
- **Accuracy is the differentiator:** the builder MUST reuse the real generators'
  naming/signature functions, not re-implement them. The Task-4 gate enforces it.
- Templates under `templates/api/` are canonical + byte-identity-gated + synced to
  the package copy (same discipline as `templates/docs/`).
- `api-docs` is Tier-1 native in the registry (ADR-0022 Part 3) — NOT neutral; it
  does not go through `meta docs`.
- Two forms, ONE `ApiModel` (don't duplicate derivation for human vs agent).
- Don't touch agent-context code; the agent form is a referenced artifact.

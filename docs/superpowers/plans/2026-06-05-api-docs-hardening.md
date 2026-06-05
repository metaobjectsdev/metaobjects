# api-docs hardening (staff-review findings) — implementation plan

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** Make the `api-docs` reference genuinely actionable for an AI coding
agent — currently it ships signatures-without-imports/examples/field-shapes, so
an agent gets *more* from reading the generated `.ts`. Close that gap.

**Source:** a god-level agentic-AI staff review found: (1) no import paths
[decisive], (2) nothing surfaces it to an agent, (3) not default-on, (4) no
examples / no setup preamble, (5) type names without field shapes; plus `throws`
computed-then-dropped, and coverage gaps.

**Scope split (collision-aware):** the agent-context P1 session is LIVE in
`server/typescript/packages/cli/src/commands/init.ts` + the `agent-context/`
skills. So:
- **DO now (all in `codegen-ts`, no collision):** imports, field shapes,
  examples, throws, the usefulness gate, header-comment fix, high-value coverage.
- **DEFER (coordinate with the live agent-context session):** adding
  `apiDocsFile()` to the `meta init` scaffold (default-on) + pointing the
  always-on context / `metaobjects-codegen` skill at `docs/api/AGENT-API.md`.
  Flag these; do NOT edit `init.ts`/`agent-context/` concurrently.

---

## Task 1: Import paths (+ surface `throws`) — the #1 actionability fix
**Files:** `src/generators/api-model.ts`, `api-doc-render.ts`, `templates/api/{entity-api,agent-api}.md.mustache`, `test/golden/api-docs-accuracy.test.ts`, the render goldens.
- Add `importPath: string` to `ApiSymbol` — the module an adopter imports the symbol from. Derive it from the SAME output-path logic the emitting generator uses (queries → `<Entity>.queries`, entity → `<Entity>`, extractor → `<Template>.extractor`, render → `<Template>.render`, validators → wherever zod schemas land). REST symbols have no import (they're endpoints) — carry the route-mount import instead (the `<Entity>Routes` registrar + its module) so an agent can mount them.
- Render the import in BOTH forms: human page shows `import { findProductById } from "./<path>"` per symbol (or grouped per module); agent form prepends each symbol line with its import or groups by module with one import line.
- Surface the `throws` string the IR already computes (`api-model.ts`) in both renderers (it's currently dropped in `symbolVM`/the agent VM).
- **Extend the accuracy gate:** assert the documented `importPath` matches the file the real generator actually emits the symbol into (so a wrong import fails the gate). 
- TDD: gate + goldens. Commit.

## Task 2: Field shapes (what to actually pass)
**Files:** `api-model.ts`, `api-doc-render.ts`, templates, tests.
- For each entity: enumerate the MODEL fields (name + type) and the create/update PAYLOAD fields (from the InsertSchema/UpdateSchema — name, type, required/optional). Reuse the existing field-metadata walk the neutral docs Constraints builder uses (don't re-derive). For extractor: the payload VO field shape; for REST: the request body = the insert/update shape, response = the model.
- Render: human page lists the field table per relevant symbol/entity; agent form gets a compact `{ field: type, ... }` shape inline for create/update + the model.
- Keep accurate-by-construction (the fields come from the metadata the generators use). TDD. Commit.

## Task 3: Examples + setup preamble
**Files:** `api-model.ts` (populate the inert `example`), `api-doc-render.ts`, templates, tests.
- Populate `ApiSymbol.example` with a RUNNABLE snippet per symbol (or one worked example per entity covering create→find→update→delete) using the real import + field shape (from T1/T2). Email/render examples show the payload + provider.
- Add a **setup preamble** to both forms: how to obtain `db` (the drizzle connection), the render `provider`, and the loaded `root`/`MetaRoot` — the construction an agent fumbles. Short, concrete, accurate (verify against the actual runtime API).
- TDD (goldens). Commit.

## Task 4: The "can an agent call it" gate + header fix
**Files:** new `test/golden/api-docs-agent-usability.test.ts`; `api-docs-file.ts` (header comment).
- The usefulness gate we skipped: assert the AGENT form is ACTIONABLE — for every callable symbol it contains (a) an import path, (b) typed args, (c) for create/update the payload field shape; and the setup preamble is present. (This is the structural proxy for "an agent could write a compiling call.")
- Fix the misleading `api-docs-file.ts` header that claims it "ships in the recommended `meta gen` suite" — it's registry-listed, not auto-run. State that accurately + note default-on is a deferred agent-context-coordination item.
- TDD. Commit.

## Task 5: High-value coverage
**Files:** `api-model.ts`, tests.
- Add the common missing surface: **relationships / M:N nav helpers** (FR-018 `@through`/`relations()` — shipped + common), the **callable/service** surface, **prompt-render** (`template.prompt`), and the **Hono routes variant** (`routes-file-hono`) when configured.
- DEFER (document as follow-ups, don't build now): TanStack/React generator surface (framework add-ons), TPH-base per-subtype write helpers/subpaths (prior deliberate deferral). Note them in the api-model header.
- Each addition stays accuracy-gated (T1's gate must pass for the new symbols). TDD. Commit.

## Task 6: Closeout
- Full `bun test packages/codegen-ts packages/cli` green; counts.
- Whole-branch review + simplifier; fix findings.
- Forward-merge to main (temp worktree off latest origin/main; main checkout is occupied). Update memory.
- **Report the two DEFERRED items** (default-on scaffold + agent-context pointers) for the user to coordinate with the agent-context session.

## Guard
Accuracy-by-construction is non-negotiable — every new field (importPath, field shapes, examples) must derive from what the generators actually emit, and T1's accuracy gate must cover the new claims. Don't touch `init.ts` / `agent-context/` (live sibling work).

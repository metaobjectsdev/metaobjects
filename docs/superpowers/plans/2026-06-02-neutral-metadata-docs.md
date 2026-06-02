# Neutral metadata documentation — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) tracking.

**Goal:** Generate neutral metadata documentation (entity + `template.output`
pages) from a single shared TS engine, with one canonical doc-template source,
runnable standalone via `meta docs`. No language assumptions, no `--target`.

**Architecture:** Tier-2 per ADR-0020 — one shared engine (TS), language-neutral
output. Canonical Mustache templates live at root `templates/`; the codegen-ts
package ships a byte-identity-gated copy. Entity page is neutralized (drop
Zod/generated SDK sections; document constraint metadata). New neutral template
page documents the render contract. New `meta docs` CLI command emits both from
metadata alone.

**Tech Stack:** TypeScript, bun, the existing `render()`/`templateGenerator()`
engine, Mustache.

**Scope guard:** TS only (single engine). Do NOT port the docs builder to
C#/Python/Java/Kotlin. Do NOT touch native code generators. SDK/API docs are out
of scope (Tier 1, future).

---

## Reference files (read before starting)

- `server/typescript/packages/codegen-ts/src/generators/docs-data.ts` — `EntityDocData` shape.
- `server/typescript/packages/codegen-ts/src/generators/docs-data-builder.ts` — builder; `constraintsCell()` (~L159), `validation` (~L370), `generated` (~L392-443).
- `server/typescript/packages/codegen-ts/src/generators/docs-file.ts` — per-entity emission; iterates `ctx.loadedRoot.objects().filter(ctx.matches)`.
- `server/typescript/packages/codegen-ts/src/generators/render-helper-file.ts` — reference for walking `template.output` nodes (`@kind`/`@payloadRef`/`@format`/`@textRef`/`@subjectRef`/`@htmlBodyRef`/`@textBodyRef`/`@maxChars`/`@requiredTags`).
- `server/typescript/packages/codegen-ts/src/render-engine/framework-provider.ts` — how templates resolve (the package `templates/` dir; `CANONICAL_TEMPLATE_REL`).
- `server/typescript/packages/codegen-ts/templates/docs/entity-page.md.mustache` — current template.
- `server/typescript/packages/codegen-ts/test/golden/docs-file-conformance.test.ts` — current golden.
- `server/typescript/packages/cli/src/commands/migrate.ts` — model for a standalone metadata-loading command (mirror for `docs.ts`).

---

## Task 1: Canonical `templates/` source + byte-identity gate (pure relocation)

**Intent:** Establish root `templates/` as the single source of truth for doc
templates; the codegen-ts package keeps a bundled copy (needed in the npm
tarball) that is byte-identity-gated against root. No output change — golden must
still pass.

**Files:**
- Create: `templates/docs/entity-page.md.mustache` (root canonical — copy of the current package template, byte-for-byte)
- Create: `scripts/sync-doc-templates.sh` (copies `templates/` → consuming packages' bundled `templates/`; idempotent)
- Keep: `server/typescript/packages/codegen-ts/templates/docs/entity-page.md.mustache` (bundled copy, now generated/synced)
- Test: `server/typescript/packages/codegen-ts/test/templates-canonical.test.ts`

- [ ] **Step 1: Write the failing byte-identity test.** Reads the repo-root `templates/docs/entity-page.md.mustache` and the package copy; asserts they are byte-identical (`readFileSync` both, `toEqual`). Resolve repo root by walking up from the test file to the dir containing `templates/` + `server/`.
- [ ] **Step 2: Run → FAIL** (root file doesn't exist yet). `cd server/typescript && bun test packages/codegen-ts/test/templates-canonical.test.ts`.
- [ ] **Step 3: Create root canonical** by copying the existing package template verbatim into `templates/docs/entity-page.md.mustache`. Add `scripts/sync-doc-templates.sh` that copies root → `server/typescript/packages/codegen-ts/templates/docs/` (so the package copy is reproducible; future ports add their dest here).
- [ ] **Step 4: Run → PASS** (byte-identical). Also run the existing docs golden to confirm NO output change: `bun test packages/codegen-ts/test/golden/docs-file-conformance.test.ts`.
- [ ] **Step 5: Commit.** `feat(docs): root templates/ canonical doc-template source + byte-identity gate`

---

## Task 2: Neutralize the entity page

**Intent:** Remove the language-specific sections. Drop `generated` (TS
filenames) and the Zod `validation` pointer. Replace with a neutral
**Constraints** table built from field metadata that renders for ALL entities
(including value objects with no storage). Keep Storage/Identity/Relationships/
Used by.

**Files:**
- Modify: `server/typescript/packages/codegen-ts/src/generators/docs-data.ts` (remove `GeneratedFileDoc` + `generated`; remove Zod `validation`; add `constraints` table shape: `{ hasConstraints, header, rows: [{ field, required, type, limits, rules }] }`)
- Modify: `server/typescript/packages/codegen-ts/src/generators/docs-data-builder.ts` (delete the `generated.push(...)` block and the `validation` Zod object; build `constraints` from every field — reuse the existing `constraintsCell` logic for limits/required/enum/validators; works without storage)
- Modify: `templates/docs/entity-page.md.mustache` (root) — remove `## Generated code`; replace `## Validation` with a `## Constraints` Markdown table (columns: Field | Required | Type | Limits | Rules); make `## Used by` bullets link `./<Template>.md`. Then run `scripts/sync-doc-templates.sh`.
- Modify: golden `docs-file-conformance.test.ts` to the neutralized output.
- Test: add a value-object fixture (no storage) with declared constraints (required, maxLength, enum, a `validator.*`) proving constraints render without a Storage section.
- Test: `server/typescript/packages/codegen-ts/test/docs-neutrality.test.ts` — generated entity docs contain none of: `Zod`, a generated `.ts`/`.cs`/`.kt`/`.py` filename, TS type literals.

- [ ] **Step 1: Write the neutrality test** asserting the rendered entity doc (from an existing fixture) contains no `Zod`, no `.ts` filename, no `## Generated code`. Run → FAIL.
- [ ] **Step 2: Write the value-object-constraints test** (a VO fixture with required/maxLength/enum/validator) asserting a `## Constraints` table with those rules and NO `## Storage`. Run → FAIL.
- [ ] **Step 3: Update `docs-data.ts`** — drop `generated`/`GeneratedFileDoc`, drop Zod `validation`, add `constraints` shape.
- [ ] **Step 4: Update `docs-data-builder.ts`** — remove generated + Zod-validation builders; build the `constraints` table for all fields.
- [ ] **Step 5: Update + sync `entity-page.md.mustache`** (root → run sync script).
- [ ] **Step 6: Regenerate/update the golden** to the neutral output; eyeball it for neutrality.
- [ ] **Step 7: Run → PASS** all of: neutrality test, VO-constraints test, golden, byte-identity gate. `bun test packages/codegen-ts`.
- [ ] **Step 8: Commit.** `feat(docs): neutralize entity page — constraints table, drop Zod/generated SDK sections`

---

## Task 3: New neutral `template.output` page

**Intent:** One Markdown page per `template.output`, render-contract-shaped,
distinct from the entity page, fully neutral (no generated-helper signatures, no
language types).

**Files:**
- Create: `server/typescript/packages/codegen-ts/src/generators/template-doc-data.ts` — `TemplateDocData`: `{ generatedMarker, name, kind (document|email), description?, format, isEmail, parts?: [{ label, ref, format, escaped }], payload: { name, link }, referencedFields: string[], requiredTags?: string[], maxChars?: number, sourceRefs: string[], capability: string }`.
- Create: `server/typescript/packages/codegen-ts/src/generators/template-doc-builder.ts` — `buildTemplateDocData(template, opts)` walking a `template.output` node (mirror `render-helper-file.ts` attr reads). `capability` is a fixed neutral string per kind (document → "returns the rendered string"; email → "returns subject + html body + optional text body").
- Create: `templates/docs/template-page.md.mustache` (root) + sync — sections: title + kind/description; `## Output` (format; for email the parts table + multipart note + escaping); `## Input` (payload link + referenced fields/requiredTags); `## Render contract` (maxChars-fails note, requiredTags, neutral drift guarantee); `## Source` (template refs); `## Capability` (the neutral capability sentence).
- Modify: `docs-file.ts` — after entity pages, iterate `loadedRoot` `template.output` nodes → emit `<Template>.md` via `templateGenerator({ ref: "docs/template-page.md", ... })`. (Or a sibling `template-docs-file.ts`; keep one emission entry from the generator list.)
- Test: `template-doc-conformance.test.ts` golden — a `document` template (WelcomePage) and an `email` template (WelcomeEmail, 3 parts); assert the sections, the payload link to the entity page, and the entity page's Used-by link resolving to this page.

- [ ] **Step 1: Write the template-page golden test** for a document + an email template (fixtures), asserting the neutral sections, payload→entity link, and entity↔template cross-links resolve. Run → FAIL.
- [ ] **Step 2: Implement `template-doc-data.ts`** (the shape).
- [ ] **Step 3: Implement `template-doc-builder.ts`** (walk node → data; neutral capability string).
- [ ] **Step 4: Author `templates/docs/template-page.md.mustache`** (root) + run sync.
- [ ] **Step 5: Wire emission** in `docs-file.ts` to also emit template pages.
- [ ] **Step 6: Run → PASS** the golden + full `bun test packages/codegen-ts`.
- [ ] **Step 7: Commit.** `feat(docs): neutral template.output documentation page (render contract)`

---

## Task 4: `meta docs` standalone command

**Intent:** A standalone CLI command that emits neutral metadata docs (entity +
template pages) from metadata ALONE — no codegen config, no Node toolchain for
the adopter (ships in the compiled binary, like `migrate-ts`).

**Files:**
- Create: `server/typescript/packages/cli/src/commands/docs.ts` — `meta docs <metadata> --out <dir>`: load the metadata root (mirror `migrate.ts` loading), build a minimal render context (project provider + framework templates), emit entity pages (neutral) + template pages into `--out`. No dependency on a full `gen` config.
- Modify: the CLI command registry (where `gen`/`migrate`/`verify` register) to add `docs`.
- Ensure the standalone `bun build --compile` binary includes the command (verify it imports cleanly — the framework-provider lazy-resolves templates; the binary has no on-disk `templates/`, so the command must surface a clear error if templates can't resolve, OR embed them — match how `gen` handles templates in the binary).
- Test: `server/typescript/packages/cli/test/docs-command.test.ts` — run `docs` against a fixture metadata file → asserts `<Entity>.md` + `<Template>.md` written to `--out`, neutral content, exits 0; appears in `--help`.

- [ ] **Step 1: Write the command test** (emits both page types from a metadata fixture to a temp `--out`; no gen config). Run → FAIL.
- [ ] **Step 2: Implement `docs.ts`** mirroring `migrate.ts`'s metadata loading; reuse the docs + template-doc builders + `render()`.
- [ ] **Step 3: Register** the command; add `--help` text.
- [ ] **Step 4: Run → PASS** the command test. Verify `meta docs --help` lists it.
- [ ] **Step 5: Binary check** — build/locate the standalone binary path used by other CLI tests; confirm `docs` is reachable (or document the template-resolution constraint if the binary can't see on-disk templates, and handle gracefully).
- [ ] **Step 6: Commit.** `feat(cli): meta docs — standalone neutral metadata-docs command`

---

## Task 5: Closeout

- [ ] **Step 1:** Full TS suites green: `cd server/typescript && bun test` (metadata, render, codegen-ts, cli). Record counts.
- [ ] **Step 2:** Hygiene — `git diff $(git merge-base origin/main HEAD)..HEAD` shows no private names, no absolute home paths, no committed node_modules/bunfig.toml. The new `templates/` + fixtures use generic names.
- [ ] **Step 3:** Whole-branch code-review + code-simplifier (the pre-merge gate); fix findings.
- [ ] **Step 4:** Forward-merge to main (FF/merge onto current origin/main tip, never rewrite), push, remove worktree, delete branch. Update memory.

---

## Self-review notes

- **Spec coverage:** shared canonical (T1) ✓; neutral entity page incl. constraints table + drop Zod/generated (T2) ✓; neutral template page (T3) ✓; `meta docs` standalone (T4) ✓; byte-identity gate (T1) ✓; neutrality assertion (T2) ✓.
- **Type consistency:** `constraints` shape introduced in T2 `docs-data.ts` is consumed by the T2 template edit; `TemplateDocData` in T3 is consumed by the T3 template + the T4 command.
- **Out-of-scope guard restated:** no per-port port of the builder; no native-codegen changes; no SDK docs.

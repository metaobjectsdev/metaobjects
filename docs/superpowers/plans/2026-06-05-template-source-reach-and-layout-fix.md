# Template-source docs: reach + package-layout fix — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes.

**Goal:** Close the two highest-leverage gaps a PM+staff review found in the shipped
linked-template-source `meta docs` feature: (#3) field links are wrong under `package`
output layout (hardcoded `./Owner.md`, untested), and (#1) `meta docs` is undiscoverable
(not in the `meta init` scaffold, not referenced by any agent-context skill).

**Architecture:** #3 — inject a layout-aware href resolver into the annotator built via the
existing `docPageHref(layout, fromNode, toNode)` + `docPageNode` + `root.findObject`, the
SAME path the Payload cross-link already uses; the annotator keeps a flat-`./Owner.md`
default so existing unit goldens stay byte-identical. #1 — add `docsFile()` to the default
init scaffold (parity with `apiDocsFile()`) and point the TS agent-context references at the
template pages (TS-only, since the neutral docs output is produced only by the TS `meta docs`
command — same scoping discipline used for api-docs).

**Tech Stack:** TypeScript (bun test), MetaObjects codegen-ts + cli + sdk packages.

---

## Task 1: Failing package-layout conformance case (RED)

**Files:**
- Create: `fixtures/conformance/template-source-conformance-package/input/meta.json` + `input/templates/*.mustache`
- Modify: `server/typescript/packages/codegen-ts/test/golden/template-source-conformance.test.ts`

Demonstrate the bug: a template whose payload VO lives in a DIFFERENT package than the
template, rendered under `outputLayout: "package"`, must link to `../<pkg>/Owner.md#field-…`
— but today it emits `./Owner.md#field-…`.

- [ ] **Step 1: Build the multi-package fixture.** Mirror the existing single-package fixture
  (`fixtures/conformance/template-source-conformance/input/`) but split packages: put the
  payload VO (e.g. `Order` with a nested `customer: Customer`) and `Customer` in package
  `acme::shop`, and the `template.output` nodes (`OrderPage` document + `OrderEmail` email)
  in package `acme::comms`, each `@payloadRef`-ing `Order`. Reuse the existing fixture's
  `.mustache` files verbatim (copy them) so only packaging differs.
- [ ] **Step 2: Add a package-layout assertion to the conformance test.** Add a second
  `test(...)` (or parametrize) that loads the new fixture and builds the GenContext with
  package layout. The existing `makeCtx` sets `config` without `outputLayout`; add an
  `outputLayout` parameter so the new case passes `outputLayout: "package"` (read
  `docs.ts:160-182` for how the real `meta docs` command threads `config.outputLayout`).
  Assert: (a) for every linked field var in each emitted template page, the href is a
  RELATIVE path that, resolved against the template page's own emitted output path, lands on
  the actual emitted entity-page path for that field's owner under package layout (i.e. the
  href must contain the owner's package dir, NOT a bare `./Owner.md`); (b) the existing
  link-integrity invariant still holds (the resolved target file exists in the emitted set and
  contains the `id="field-<name>"` anchor). Use `docPageOutputPath`/`docPageHref` from
  `src/docs-paths.ts` as the source of truth for expected placement.
- [ ] **Step 3: Run it — expect FAIL.** `cd server/typescript && bun test packages/codegen-ts/test/golden/template-source-conformance.test.ts`. Expected: the new package-layout case FAILS because field hrefs are `./Owner.md…` (no package dir) while the entity page is emitted under `acme/shop/…`. The existing flat case still PASSES.
- [ ] **Step 4: Commit (RED test).** `git add fixtures/conformance/template-source-conformance-package server/typescript/packages/codegen-ts/test/golden/template-source-conformance.test.ts && git commit` with a message noting this is the failing reproduction of the package-layout link bug.

## Task 2: Layout-aware field hrefs (GREEN)

**Files:**
- Modify: `server/typescript/packages/codegen-ts/src/generators/template-source-annotate.ts` (`fieldHref`, the annotate opts, `resolveAt`, and partial-href handling if present)
- Modify: `server/typescript/packages/codegen-ts/src/generators/template-doc-builder.ts` (`buildTemplateSourceSection` — construct + pass the resolver)

- [ ] **Step 1: Add an injectable href resolver to the annotator.** In
  `template-source-annotate.ts`, extend the annotate options with an optional
  `fieldHref?: (owner: string, name: string) => string`. In `resolveAt`/wherever `fieldHref`
  is called, use the injected resolver when provided, else fall back to the current
  `` `./${owner}.md#${fieldAnchorSlug(name)}` `` default (so the annotator's own unit tests +
  flat goldens stay byte-identical). If partials also build a hardcoded `./<ref>.md` href,
  add an analogous optional `partialHref?: (ref: string) => string` with the current default —
  check `template-source-annotate.ts` for a `partialHref`/partial token branch and apply the
  same treatment; if partial hrefs are out of scope of the bug, leave them but note it.
- [ ] **Step 2: Wire the layout-aware resolver from the builder.** In
  `template-doc-builder.ts` `buildTemplateSourceSection` (the call site that already has
  `layout`, `root`, and the `template` node), pass
  `fieldHref: (owner, name) => { const t = root?.findObject(owner); const target = t ? docPageNode(t) : { name: owner }; return `${docPageHref(layout, docPageNode(template), target)}#${fieldAnchorSlug(name)}`; }`
  — i.e. derive the owner's page node from the root (so package layout folds the correct
  relative dir) exactly as the Payload link does at `template-doc-builder.ts:140-148`, then
  append the shared `fieldAnchorSlug` fragment. Import `docPageHref`/`docPageNode` from
  `../docs-paths.js` and `fieldAnchorSlug` if not already in scope. Do the same for
  `partialHref` if Step 1 added it and partials are documented templates.
- [ ] **Step 2b: Keep `fieldHref`/`fieldAnchorSlug` the single source of the fragment.** Ensure
  the slug used in the injected resolver is the SAME `fieldAnchorSlug` the entity page uses for
  its `id="field-<name>"` anchor (no second slug definition) so link and anchor still can't drift.
- [ ] **Step 3: Run the package-layout case — expect PASS.** `bun test packages/codegen-ts/test/golden/template-source-conformance.test.ts`. Expected: BOTH the flat and package cases PASS.
- [ ] **Step 4: Run the broader codegen-ts suite for byte-stability.** `bun test packages/codegen-ts`. Expected: 0 fail; the flat-layout template-source goldens + annotator unit tests are UNCHANGED (the default path is byte-identical).
- [ ] **Step 5: Commit (GREEN).** `git add -A server/typescript/packages/codegen-ts/src && git commit` with a message describing the layout-aware field-href fix.

## Task 3: Wire `docsFile()` into the `meta init` scaffold

**Files:**
- Modify: `server/typescript/packages/cli/src/commands/init.ts` (`buildMetaobjectsConfigBody`, lines ~37-52)
- Modify: `server/typescript/packages/cli/test/unit/init-scaffold-config.test.ts`

- [ ] **Step 1: Add `docsFile` to the scaffold import + generators array.** In
  `buildMetaobjectsConfigBody`, add `docsFile,` to the named import from
  `@metaobjectsdev/codegen-ts/generators` and add `docsFile(),` to the `generators: [ … ]`
  array (place it next to `apiDocsFile()`). Add a one-line `//` comment distinguishing the two
  if it reads ambiguously (e.g. `apiDocsFile()` = SDK/API reference under `docs/api/`;
  `docsFile()` = neutral metadata docs — entity + template pages — under the docs dir).
- [ ] **Step 2: Update the scaffold test.** In `init-scaffold-config.test.ts`, add
  `expect(body).toContain(\`docsFile()\`);` alongside the existing `apiDocsFile()` assertion.
- [ ] **Step 3: Verify no output collision.** Run `meta init` into a temp dir, then run the
  generators (or directly inspect the canonical output dirs): confirm `docsFile()` and
  `apiDocsFile()` write to DISTINCT paths (neutral docs vs `docs/api/`) with no overwrite.
  Read `docs.ts` / the `docsFile()` generator to confirm its output directory, and the
  api-docs generator's, then assert they don't collide. If `docsFile()` writes a top-level
  `README.md`/index that would clobber an api-docs file, STOP and report (do not silently
  ship a collision — a past data-loss hole). Capture the actual neutral-docs output path
  string for Task 4 (do NOT guess it).
- [ ] **Step 4: Run the cli suite.** `bun test packages/cli`. Expected: 0 fail.
- [ ] **Step 5: Commit.** `git add server/typescript/packages/cli && git commit`.

## Task 4: Point the agent-context skills at the template pages

**Files:**
- Modify: `agent-context/skills/metaobjects-codegen/references/typescript.md` (generator table)
- Modify: `agent-context/skills/metaobjects-prompts/references/typescript.md` (template-page pointer)
- Regenerate: `fixtures/agent-context-conformance/*/expected/**` (TS stacks only)

- [ ] **Step 1: Add a `docsFile()` row to the codegen skill TS reference.** In
  `metaobjects-codegen/references/typescript.md`, add a generator-table row mirroring the
  existing `apiDocsFile()` row (lines ~48-63): `docsFile()` → the neutral metadata docs it
  emits (entity pages + `template.output`/`template.prompt` pages, the latter with the
  `## Template source` section), using the ACTUAL output path captured in Task 3 Step 3.
  Keep it one row + at most one bolded guidance line; match the existing terse style. Do NOT
  invent attribute or path names — use only verified strings.
- [ ] **Step 2: Add a template-page pointer to the prompts skill TS reference.** In
  `metaobjects-prompts/references/typescript.md`, add a short note: when `docsFile()` is
  enabled (default scaffold), `meta docs` emits a page per `template.prompt`/`template.output`
  whose `## Template source` section shows the Mustache source with every `{{var}}` linked to
  that field's documentation — so an agent can read which payload fields a template consumes
  (and the build-time drift gate guarantees those links match what `verify()` accepts). Use
  the real output path. Keep it to ~2-3 lines, matching the file's existing voice.
- [ ] **Step 3: Regenerate the agent-context conformance goldens.** The added lines break
  `packages/sdk/test/agent-context-conformance.test.ts` for TS-stack fixtures only. Find the
  regen mechanism (an env-flag/update mode on the assemble test, or regenerate by writing
  `assemble({contentRoot, stack})` output over the matching `expected/` files). Regenerate
  ONLY the affected fixtures (the ts-* stacks that include these two references); confirm
  non-TS stacks are byte-unchanged (proves the TS-only scoping, same as the api-docs wiring).
- [ ] **Step 4: Run the agent-context gates.** `bun test packages/sdk` (assemble/drift/size/
  scaffold/conformance). Expected: 0 fail. Also re-run `bun test packages/cli` to confirm the
  scaffold test still passes.
- [ ] **Step 5: Commit.** `git add agent-context fixtures/agent-context-conformance && git commit`.

## Task 5: Closeout

- [ ] Full `bun test packages/codegen-ts packages/cli packages/sdk packages/render` green; record counts.
- [ ] Whole-branch review + code-simplifier; fix findings.
- [ ] Forward-merge to origin/main via a temp worktree off the latest origin/main (the main
  checkout holds other sessions' WIP — do not touch it). Remove worktrees/branches. Update memory.

## Guard
- PUBLIC repo: no private/other-project names, no absolute home paths — in code, fixtures,
  OR commit messages. Genericize.
- The annotator's flat-layout default output MUST stay byte-identical (existing goldens
  unchanged); only the package-layout path is new behavior.
- `fieldAnchorSlug` stays the single source of the anchor fragment (link/anchor can't drift).
- Don't invent output paths/attr names — use only strings verified from the code (Task 3).
- Don't touch other ports, api-docs internals, the rich-view renderer, or the main checkout.

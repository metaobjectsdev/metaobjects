# Linked template source in meta docs — implementation plan

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** Embed the Mustache template source in the `meta docs` template page —
syntax-highlighted, with every `{{variable}}` linked to its field's doc — in two
renderings from one model (Markdown block + variables link table; rich inline-
linked HTML). Reuse the render `verify()` variable→field mapping. TS / meta docs
(neutral Tier-2) only. Decisions (resolved): rich view = collapsed `<details>`;
anchor slug = `field-<name>` prefixed; partials link to the referenced template
page when it's a documented template.output, else highlight-only.

## Reference (read first)
- `server/typescript/packages/render/src/verify.ts` — `Mustache.parse` tokens +
  the context-aware field resolution (`lookup`/`current`); `PayloadField` tree.
- `server/typescript/packages/codegen-ts/src/generators/template-doc-builder.ts`
  + `template-doc-data.ts` — the existing template page builder + `@payloadRef`
  field-tree derivation. `templates/docs/template-page.md.mustache`.
- `src/generators/docs-data-builder.ts` + `templates/docs/entity-page.md.mustache`
  — the Constraints table (where per-field anchors go).
- `spec/decisions/ADR-0022-...md`; the design spec `…/specs/2026-06-05-linked-template-source-docs-design.md`.

## Task 1: The annotated-template IR (the core)
**Files:** `src/generators/template-source-annotate.ts`; test `test/template-source-annotate.test.ts`.
- `annotateTemplate(source, payloadFieldTree, opts): TplToken[]` — `Mustache.parse`
  the source; walk tokens emitting `text` / `var` / `unescaped` / `section` /
  `inverted` / `close` / `partial` / `comment`; resolve each variable/section path
  against the payload field tree (REUSE verify's resolution — if its `lookup`/
  `current` helpers are internal, export them or factor `resolveTemplateVariable`
  shared in render). Each resolved var gets `{ owner, name, type, required, href }`
  where `href = ./<OwnerVO>.md#field-<name>`. Context-pushing sections resolve
  nested fields; dotted paths walk; unresolved → `valid:false` no href.
- [ ] TDD: a fixture template with a scalar var, a `{{#section}}{{field}}{{/}}`
  (nested-object context), a dotted path, a partial, a comment, and an off-payload
  var → assert the token kinds + each var's resolved owner/field/href + the
  off-payload one is `valid:false`. Run → FAIL → implement → PASS.

## Task 2: Per-field anchors on the entity page
**Files:** `docs-data-builder.ts` (constraints rows), `templates/docs/entity-page.md.mustache`; update the entity goldens.
- Emit a stable anchor per field in the Constraints table (e.g. an
  `<a id="field-<name>"></a>` in the Field cell, or an anchored field name) so
  `./Entity.md#field-<name>` resolves. Slug = `field-<fieldname>`.
- [ ] TDD: assert the rendered entity page contains `id="field-<name>"` per field;
  update the docs-file goldens to the anchored output.

## Task 3: The three renderers
**Files:** `src/generators/template-source-render.ts`; test `test/golden/template-source-render.test.ts`.
- From `TplToken[]`: (a) `renderSourceBlock` → a ```` ```mustache ```` fenced block
  of the raw source; (b) `renderVariablesTable` → a Markdown table of unique vars
  `{{path}}` → `[Owner.field](href)` | type | required (unresolved flagged);
  (c) `renderRichLinkedHtml` → `<details><summary>Linked view</summary>` + `<pre>`
  with self-contained INLINE-STYLED color spans per token kind + `<a href>` on
  variables/sections. Collapsed by default.
- [ ] TDD: byte-golden each renderer for a fixture IR; assert the rich HTML has
  inline styles (no external CSS) + resolving `<a href>`; the table links match
  the IR hrefs; the block is the verbatim source.

## Task 4: Integrate into the template page
**Files:** `template-doc-data.ts`, `template-doc-builder.ts`, `templates/docs/template-page.md.mustache` (canonical root + run `scripts/sync-doc-templates.sh`); update template-page goldens + the cli `meta docs` test.
- Builder attaches the annotated source per template + per email part (resolve
  each ref's mustache via the filesystem provider — the same the verify drift gate
  uses; the field tree from `@payloadRef`). Add a `## Template source` section to
  the template page rendering the block + table + rich `<details>` per part.
- [ ] TDD: the template page golden gains the source section with a linked var;
  `meta docs` emits it; byte-identity gate (root==package template) green.

## Task 5: Conformance gate (link integrity + annotator⇆verify agreement)
**Files:** `test/golden/template-source-conformance.test.ts`.
- For a fixture model: (a) every var the annotator links has a matching
  `id="field-<name>"` anchor on the target entity page actually emitted in the run
  (cross-doc link integrity); (b) the set of vars the annotator marks `valid`
  EQUALS the set render `verify()` does NOT flag `ERR_VAR_NOT_ON_PAYLOAD` for the
  same template+payload (the doc can't claim a link verify would reject).
- [ ] TDD: assert both; an injected off-payload var → annotator `valid:false` AND
  verify flags it (they agree); a renamed field breaks the link-integrity check.

## Task 6: Closeout
- Full `bun test packages/codegen-ts packages/cli packages/render` green; counts.
- Whole-branch review + simplifier; fix findings.
- Eyeball the rendered template page (source block + table + rich view).
- Forward-merge (temp worktree off latest origin/main). Update memory.

## Guard
Reuse verify's mapping (don't reimplement mustache resolution); the render engine
`verify()` behavior UNCHANGED. Anchors + links must resolve (gated). Templates
under `templates/docs/` stay byte-identity-gated + synced. Don't touch other ports
/ api-docs / agent-context / init.ts.

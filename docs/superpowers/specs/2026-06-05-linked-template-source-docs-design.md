# Linked, syntax-highlighted template source in `meta docs` — design

**Date:** 2026-06-05
**Status:** Design (pending review)
**Relates to:** ADR-0022 (this is a `meta docs` / neutral Tier-2 enhancement),
the render `verify()` engine (reused), the neutral entity + template docs.

## Goal

On the `meta docs` `template.output` / `template.prompt` page, **embed the actual
Mustache template source**, syntax-highlighted, with **every `{{variable}}`
hot-linked to that field's documentation** on its entity/VO page. Connect the
template to the model it depends on, reusing the variable→field mapping the
render `verify()` engine already computes (its build-time drift gate).

Both renderings from one model: a portable Markdown form (highlighted code block +
a Variables→field-doc link table) that works on GitHub and for an agent, AND a
rich HTML form (the template rendered as colored, inline-linked clickable
variables) for a docs site.

## Why it's cheap to do
- `verify.ts` already parses the template (`Mustache.parse` → tokens with
  type/value/position) and resolves each variable against the payload field tree
  (context-pushing sections handled) to drive `ERR_VAR_NOT_ON_PAYLOAD`. We reuse
  that parse + resolution to know, per variable, the exact field it maps to.
- The neutral entity page already documents each field (the Constraints table) —
  the link target. It just needs a stable per-field anchor.

## Scope
`meta docs` only (neutral, Tier-2, TS — the single shared docs engine per
ADR-0022). Both `template.output` and `template.prompt`. The render engine's
`verify()` behavior is UNCHANGED (we read its parse/resolution, not alter it).

## Design

### 1. The annotated-template IR
A new builder produces, per template (and per email part), an ordered token list:
```ts
type TplToken =
  | { kind: "text"; text: string }
  | { kind: "var" | "unescaped"; raw: string; path: string; field?: ResolvedField; href?: string; valid: boolean }
  | { kind: "section" | "inverted" | "close"; raw: string; path: string; field?: ResolvedField; href?: string }
  | { kind: "partial"; raw: string; ref: string; href?: string }
  | { kind: "comment"; raw: string };
interface ResolvedField { owner: string; name: string; type: string; required: boolean; }
```
- Built from `Mustache.parse(source)` + the payload field tree (reuse the
  template-doc-builder's `@payloadRef` field-tree derivation + verify's
  context-resolution: a `{{field}}` inside `{{#section}}` resolves within the
  section's nested VO; dotted paths walk the tree).
- `href` = `./<OwnerVO>.md#<field-anchor>` (the field's entity/VO page + anchor).
  A nested-object section that points at another `object.value` links to THAT
  VO's page; the leaf field links to its owner's page.
- Variables NOT on the payload → `valid:false`, no href, flagged (in a valid
  model the drift gate already forbids these; render defensively).
- Partials → optionally link to the referenced template's page if it's a
  documented `template.output`; else highlight only.

### 2. Per-field anchors on the entity page
The entity-page generator emits a stable anchor per field (e.g. an
`<a id="<field>"></a>` in the Field cell, or render the field name as an anchored
span) so `./Entity.md#<field>` resolves. Anchor slug = the field name
(kebab/lower as needed; documented + consistent with the link builder).

### 3. Renderings (both from one source) — on the template page
For each template (and each email part), emit:
1. **Source block** — a ```` ```mustache ```` fenced block of the raw template
   (clean source; the viewer/site highlighter colors it). Universal, agent-clean.
2. **Variables table** — each UNIQUE variable: `{{path}}` → `[Owner.field](href)` |
   type | required. (The links, Markdown-native.) Unresolved vars flagged.
3. **Rich linked view** — a collapsible `<details><summary>Linked view</summary>`
   containing an HTML `<pre>` of the template where each token is a
   **self-contained inline-styled** span (color) and each variable/section is
   wrapped in `<a href="…">` (clickable). Inline styles (no external CSS) so it
   renders identically on GitHub and a docs site. Collapsed by default so it
   doesn't clutter the plain/agent view.

This gives color (block + the rich view), links (table + the rich view), and
agent-cleanliness (block + table) — from one annotated IR.

### 4. Integration
- `template-doc-data.ts` / `template-doc-builder.ts` gain the annotated-template
  per template + per email part (reusing the existing `@payloadRef` field-tree +
  the render `Mustache.parse`/verify resolution).
- `templates/docs/template-page.md.mustache` renders the three forms under a new
  `## Template source` section (after the existing Source refs).
- The annotator + the rich-HTML renderer are pure functions over the IR
  (testable, golden-pinned).

## Accuracy / conformance gate
- **Links resolve:** a conformance test asserts every variable the annotator links
  has (a) a field that verify agrees is on the payload, AND (b) a matching anchor
  emitted on the target entity page (cross-doc link integrity — the two surfaces
  agree).
- **Annotator ⇆ verify agree:** the set of variables the annotator marks `valid`
  equals the set verify does NOT flag `ERR_VAR_NOT_ON_PAYLOAD` for the same
  template+payload (so the doc can't claim a link verify would reject).
- Byte-golden the rendered source block + table + rich view for a fixture.

## File structure (TS)
- `src/generators/template-source-annotate.ts` — `Mustache.parse` + field
  resolution → the `TplToken[]` IR (reuse verify's resolution helpers; if they're
  internal, factor a shared `resolveTemplateVariables` in render or codegen-ts).
- `src/generators/template-source-render.ts` — the three renderers (fenced block,
  variables table, rich-HTML `<details>`).
- `template-doc-builder.ts` + `template-doc-data.ts` — attach the annotated
  source; `template-page.md.mustache` — the `## Template source` section.
- entity page: per-field anchors (`docs-data-builder.ts` constraints + the
  entity template).
- Tests: annotator unit (sections/dotted/partials/unresolved), the link-integrity
  + annotator⇆verify conformance gate, render goldens.

## Open questions (for review)
1. **Rich view default:** collapsed `<details>` (proposed) vs always-expanded.
   Collapsed keeps the agent/plain view clean; humans expand for clickable vars.
2. **Anchor slug scheme** — bare field name vs `field-<name>` prefixed (avoid
   collision with other page anchors). Lean prefixed for safety.
3. **Partials linking** — link `{{>ref}}` to the referenced template page if it's
   a documented template.output, else highlight-only. Lean: link when resolvable,
   else highlight (cheap, useful).

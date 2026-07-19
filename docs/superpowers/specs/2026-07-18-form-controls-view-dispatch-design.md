# Form-controls: view-dispatch codegen + `@formExclude` registration

_Design — 2026-07-18 (updated 2026-07-19: `@rows` deferred — see Unit A)_

## Summary

Upgrade the generated `<Entity>Form` (TypeScript React codegen) so each field renders the
**right control for its declared view kind** — a `<select>` for an enum, a `<textarea>` for
multi-line text, a checkbox, a radio group — instead of the current bare `<input>` for every
scalar. One supporting metamodel attribute the codegen already _reads_ but core never
_registers_ is promoted to first-class, registered vocabulary: `@formExclude` (on fields).
(`@rows` on `view.textarea` was scoped in but **deferred** during implementation — no clean
cross-port home; see Unit A. Textareas render a fixed `rows={4}`.)

This is the first of two cycles that promote a proven, test-gated forms implementation from a
downstream consumer into the shared library. This cycle is **form controls only**. Image
handling (an `<ImageUpload>` component, image utilities, and a `view.image` subtype) is a
separate, later cycle and is out of scope here.

## Motivation

- The stock `formFile` template emits `<input className="metaobjects-field-input" {...form.input.<field>} />`
  for **every** flat scalar — an enum renders as a free-text box, a long-text field as a
  single-line input. A generated form should dispatch on the field's presentation intent. The
  view vocabulary to express that intent (`view.dropdown`, `view.textarea`, `view.checkbox`,
  `view.radio`) is **already core** — the gap was never vocabulary, only that the template never
  dispatched on it.
- `@formExclude` is read by the form template today (it drops the field from the generated form)
  but is **not registered by any core provider**. Under lax `meta gen` this is accepted; under
  strict `meta verify` (ADR-0023 sealed registry) it is rejected as `ERR_UNKNOWN_ATTR`. That is a
  latent library bug: a directive the library's own codegen honors will fail the library's own
  strict verify. (`@rows` for `<textarea>` sizing has the same read-but-unregistered gap, but
  registering it has no clean cross-port home — it is deferred; see Unit A.)

## Scope

**In scope (this cycle):**

- ~~**Unit A** — register `@rows` on `view.textarea`~~ — **DEFERRED** (no clean cross-port home; see Unit A below). Textarea renders a fixed `rows={4}`.
- **Unit B** — register `@formExclude` on the `field.*` wildcard via `spec/metamodel/ui.json` (cross-port; a data-only JSON edit synced to the C#/Python copies + regen — no non-TS code edits; Java auto-copies, Kotlin rides Java).
- **Unit C** — `formFile` view-dispatch codegen (TypeScript-only), plus a styled submit wrapper
  and the semantic class names its new controls require.

**Out of scope (deferred):**

- The image branch (`view.image` → an upload/crop component) and all image runtime primitives.
- A shipped `form.css` stylesheet file (no package ships CSS today; the packaging question rides
  with the image cycle). This cycle emits **class names only** — consistent with the template's
  existing contract, which already emits `metaobjects-field`, `-field-label`, `-field-input`,
  `-field-error`, `-fieldset`, `-field-array-add/remove` with no shipped CSS.
- The "blank-optional-scalar" submit fix (see [Deferred work](#deferred-work-tracking) — it
  conflicts with FR-035 tristate semantics and needs its own cycle).

## Decisions already settled

| Decision | Choice | Rationale |
| --- | --- | --- |
| Cycle scope | Form controls first; images later | Self-contained; images carry the thorny cross-port/CSS/dep questions. |
| Dispatch delivery | **Default-on, minor release** | Generated-output-only change; project ethos: "generated code is the disposable artifact", "no backwards-compat hacks"; three-way merge preserves hand-edits. No opt-in flag. |
| `@formExclude` registration | **Cross-port, `field.*` wildcard** | Honest fix under strict provenance; shared metadata carrying `@formExclude` must load in every port. "Exclude from a form" is orthogonal to field type; a curated subtype subset would create `ERR_UNKNOWN_ATTR` landmines. Mirrors the existing `@filterable`/`@sortable` wildcard. |
| `@rows` registration | **Deferred (updated 2026-07-19)** | No clean cross-port home for an attr on a TS-only view subtype: `ui.json`'s `extends` throws where `view.textarea` is deregistered, and core `view.json` breaks the FR-033 "core owns zero view attrs" invariant. Textarea uses a fixed `rows={4}`; configurable `@rows` needs its own design. See Unit A. |
| Styled submit + new class names | **Include now** | The new checkbox/radio controls need class names regardless; emitting them unnamed and renaming later would churn every adopter's three-way merge twice. Inert hooks without CSS is already the template's contract. |
| Blank-optional submit fix | **Defer + file tracking issue** | Porting as-is ships a silent data bug under FR-035 tristate (deleting a cleared key = "untouched" ⇒ the clear silently fails on edit). The correct fix is tristate-aware; its own cycle. |

## Design

### Registration mechanics (Unit B)

The metamodel spec JSON under `spec/metamodel/` is the canonical source. Each non-TS port is
**data-driven** — it loads the spec JSON rather than hand-registering attrs in provider code — so
adding an attr is a JSON edit plus regeneration, **not** per-port provider code:

- **TS** lowers the spec JSON into the embedded metamodel via
  `bun run scripts/generate-embedded-metamodel.ts` (regenerates every `*-definition.embedded.ts`
  from every `spec/metamodel/*.json` in one command; the embedded files are auto-generated, never
  hand-edited, and drift-gated by `test/*-definition-embed.test.ts`).
- **Java** copies `spec/metamodel/*.json` onto its classpath at build (`maven-resources-plugin`)
  and reads it via `SpecMetamodelReader` — so it **auto-refreshes from canonical; no committed copy
  to sync, no code edit**. **Kotlin rides Java's registration** (shared JVM `metadata` module) — no
  separate work.
- **C#** and **Python** carry **committed byte-identical copies** of the spec JSON
  (`server/csharp/MetaObjects/SpecMetamodel/*.json`, `server/python/src/metaobjects/spec_metamodel/*.json`),
  drift-gated to canonical. They must be re-synced (`cp`) whenever canonical changes — again, **no
  code edit**, just the file copy.

### Unit A — `@rows` on `view.textarea` — **DEFERRED** (no clean cross-port home)

`@rows` is **not registered this cycle.** During implementation both candidate homes proved
unworkable, and attaching an attr to a TS-only view subtype turns out to need its own cross-port
design — out of scope for form controls.

- **`ui.json`** (the correct provider per the invariant below) registers attrs through the
  `extends` mechanism, which **throws when the target subtype is not registered**. `view.textarea`
  is deregistered in C#/Python/Java (only `view.base` + `view.currency` are registered
  cross-port), and the committed port copies of `ui.json` are drift-gated byte-identical to
  canonical — so a `view.textarea` `extends` block would force those copies to carry it and the
  three ports would throw at registry-compose time.
- **`view.json`** (core, `metaobjects-core-types`) **violates a deliberate FR-033 invariant**:
  core registers **zero own attrs on any view subtype** — every view attr (e.g. `view.currency`'s
  `@locale`) is re-homed to the `ui` provider. This is enforced by
  `view-definition-completeness.test.ts` ("core registers NO own attrs — re-homed to ui") plus the
  `metamodel-docs*` golden tests. An `@rows` attr in core `view.json` breaks all three.

**Consequence for this cycle:** the textarea dispatch (Unit C) renders `<textarea rows={4}>` with a
**fixed** default. Configurable `@rows` is a documented future item (see [Deferred work](#deferred-work-tracking))
that needs a real design for attaching attributes to TS-only view subtypes (either re-register the
generic view subtypes cross-port, or a TS-only view-attr provider) — deliberately not undertaken
here.

### Unit B — `@formExclude` on the `field.*` wildcard (`ui.json`, cross-port)

`@formExclude` goes in **`spec/metamodel/ui.json`** on the existing `field.*` wildcard
`children[]`, peer to `@filterable`/`@sortable` (which are registered the identical way):

```jsonc
// appended to the field.* children in spec/metamodel/ui.json
{ "type": "attr", "subType": "boolean", "name": "formExclude", "min": 0, "max": 1,
  "description": "When true, the field is omitted from generated forms. Inert on fields for which no form is generated (e.g. projection/derived fields)." }
```

This one **is** cross-port: a field-level attr on the `field.*` wildcard appears **once per
concrete field subtype** in `expected-registry.json`, which the `registry-conformance` gate
byte-matches in all five ports. `ui.json` works here (unlike for `@rows`) because `field.*` is a
registered target in every port. The change is data-only and must land atomically:

1. Add the attr to canonical `spec/metamodel/ui.json`.
2. `cp spec/metamodel/ui.json server/csharp/MetaObjects/SpecMetamodel/ui.json`
3. `cp spec/metamodel/ui.json server/python/src/metaobjects/spec_metamodel/ui.json`
4. `bun run scripts/generate-embedded-metamodel.ts` (regenerates `ui-definition.embedded.ts`).
5. `bun run scripts/regen-expected-registry.ts` (canonical manifest gains `formExclude` per field
   subtype).
6. Add the `FIELD_ATTR_FORM_EXCLUDE` constant and use it at the existing `formExclude` read in
   the form template (replacing the bare string literal).

Java auto-copies from `spec/` at build and Kotlin rides Java — **no code edit in any non-TS
port.** Landing all copies + the regenerated fixture in one change keeps `main` green. Driven with
the `cross-language-porting` discipline.

### Unit C — `formFile` view-dispatch codegen (TypeScript-only)

Upgrade `renderFormFile` in `server/typescript/packages/codegen-ts-react/src/templates/form-file.ts`.
The template's structure (visible-field selection, value-object and array-of-value-object
recursion, depth guard, factory opt-in via `formFile()` with per-entity `@emitForm: false`
opt-out and TPH per-subtype handling) is **unchanged**. The only change is the per-field control.

Add three helpers, ported faithfully from the proven downstream generator (image branch removed):

- **`viewKindFor(field)`** — an explicit `field.views()[0].subType` wins; else `field.subType`
  is `enum` ⇒ `dropdown` (the one opinionated default — an enum with no explicit view becomes a
  dropdown); else `null` (falls through to the existing typed `<input>`, unchanged). Uses the
  resolving `field.views()` accessor per ADR-0039 — never `ownViews()`.
- **`labelAndError(field, entityName, control)`** — the shared wrapper (`<div class="metaobjects-field">`
  + `<label class="metaobjects-field-label" htmlFor>` + error `<span class="metaobjects-field-error" role="alert">`),
  byte-identical to today's `scalarBlock`, with the caller's `control` line spliced where the
  `<input>` was.
- **`fieldControlFor(field, entityName)`** — nested inside `renderFormFile` so its default branch
  closes over `scalarBlock`. Four dispatch branches, each wrapped by `labelAndError`:
  - `dropdown` → `<select className="metaobjects-field-input" {...form.register(name)}>` with an
    `<option>` per `@values`; an empty `<option value="">` is prepended unless the field is
    `@required`.
  - `textarea` → `<textarea className="metaobjects-field-input" rows={4} {...form.register(name)} />`
    (fixed `rows={4}`; configurable `@rows` is deferred — see Unit A).
  - `checkbox` → `<input type="checkbox" className="metaobjects-field-checkbox" {...form.register(name)} />`.
  - `radio` → `<fieldset className="metaobjects-field-radios">` of
    `<label className="metaobjects-field-radio"><input type="radio" value=... {...form.register(name)} /> ...</label>`
    per `@values`.
  - default → `scalarBlock(name)` verbatim.

The single wiring change in the main loop: at the scalar branch, replace `scalarBlock(f.name)`
with `fieldControlFor(f, entityName)`. Dispatch controls bind via `form.register(...)` (standard
React-Hook-Form, already on the `useEntityForm` return); the default scalar branch keeps the
pre-bound `form.input.<field>` accessor.

**Styled submit + class names:** wrap the submit button in `<div className="metaobjects-form-actions">`
and add `className="metaobjects-form-submit"` (stock emits a bare `<button>`). The new controls
carry `metaobjects-field-checkbox`, `-field-radios`, `-field-radio`. All are inert hooks
(no shipped CSS) — consistent with the template's existing class-name emission.

**Behavior change (the semver-relevant one, approved default-on-minor):** an enum field with no
explicit view now renders `<select>` bound via `form.register` instead of a bare `<input>` bound
via `form.input`.

### Named-constant discipline

Per the project rule (named constants for all metamodel strings), add:

- `VIEW_TEXTAREA_ATTR_ROWS = "rows"` (view constants module).
- `FIELD_ATTR_FORM_EXCLUDE = "formExclude"` (field constants module) — and replace the hard-coded
  `"formExclude"` literal the template reads today with this constant.

Reuse existing constants: `VIEW_SUBTYPE_{DROPDOWN,TEXTAREA,CHECKBOX,RADIO}`, `FIELD_SUBTYPE_ENUM`,
`FIELD_ATTR_{VALUES,REQUIRED}`. Emitted CSS class names stay string literals (they are
generated-code content, not metamodel concepts), matching the existing template.

## Testing (TDD)

Failing test first, watch it fail, minimal green.

- **Unit B loader/registration gate:** the regenerated `registry-conformance` fixture is the
  cross-port gate — every port re-runs it. A strict-mode load of `field.string @formExclude`
  succeeds (no `ERR_UNKNOWN_ATTR`).
- **Unit C render tests:** a metadata fixture exercising an enum field, a `view.textarea`,
  a `view.checkbox`, and a `view.radio` field. Call `renderFormFile` and assert the output
  contains `<select>` + its `<option>`s, `<textarea ... rows={4}>`, `<input type="checkbox">`,
  the radio `<fieldset>`, and `className="metaobjects-form-submit"` — and that the enum is **no
  longer** a bare `form.input.<field>` bound input. Also assert a `@formExclude` field is absent
  from the rendered form.

## Deferred work (tracking)

- **Blank-optional-scalar submit behavior.** The downstream generator deletes submit-payload keys
  whose value is `""` so a blank optional input stores `NULL` instead of `""` (an `""` in a
  date/timestamp column is invalid; a `!= null` check misreads `""` as "set"). Ported as-is this
  is a silent data bug under FR-035 present-key PATCH tristate: on **edit**, deleting a cleared
  field's key means "untouched", so clearing a previously-set optional field silently fails. The
  correct behavior is tristate-aware (blank-on-create → omit/null; blank-that-was-set-on-edit →
  explicit `null`; `@required` untouched) and needs create-vs-edit + dirty-state awareness. **File
  a tracking issue** so this deferral is a recorded decision. Note the promoted template inherits
  the pre-existing `""`-vs-`NULL`-on-CREATE wart for blank optional date/timestamp inputs until
  that issue lands.
- **Configurable `@rows` on `view.textarea`.** Deferred (see Unit A). There is no clean
  cross-port home today for an attribute on a TS-only view subtype: `ui.json`'s `extends` throws
  in the non-TS ports (where `view.textarea` is deregistered), and core `view.json` violates the
  FR-033 "core owns zero view attrs" invariant. A future cycle can address it by either
  re-registering the generic view subtypes cross-port or introducing a TS-only view-attr provider.
  Until then, generated textareas render a fixed `rows={4}`.
- **Image cycle.** `view.image` subtype (cross-port vocab decision), `<ImageUpload>` runtime
  component + adapter contract, `canvasToJpegBlob`/`reencodeJpeg` utilities, and the `form.css`
  packaging question — the next cycle.

## Release framing

The cross-port `@formExclude` registration + the conformance fixture must land atomically to keep
`main` green. Whether we immediately cut releases of all five registries, or let the non-TS
registration ride the next coordinated bump while only npm ships the codegen value, is a
release-timing call made when the work is complete. Semantically it is a minor everywhere
(additive attr + generated-output change; no metamodel or wire-format break).

## Open questions

None — the scope, delivery model, `@formExclude` breadth, styled-submit inclusion, and
blank-optional deferral are all settled above.

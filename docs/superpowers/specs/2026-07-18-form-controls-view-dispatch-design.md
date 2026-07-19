# Form-controls: view-dispatch codegen + `@rows` / `@formExclude` registration

_Design — 2026-07-18_

## Summary

Upgrade the generated `<Entity>Form` (TypeScript React codegen) so each field renders the
**right control for its declared view kind** — a `<select>` for an enum, a `<textarea>` for
multi-line text, a checkbox, a radio group — instead of the current bare `<input>` for every
scalar. Two supporting metamodel attributes the codegen already _reads_ but core never
_registers_ are promoted to first-class, registered vocabulary: `@rows` (on `view.textarea`)
and `@formExclude` (on fields).

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
  strict verify. `@rows` (needed for `<textarea>` sizing) has the same read-but-unregistered gap.

## Scope

**In scope (this cycle):**

- **Unit A** — register `@rows` on `view.textarea` (TypeScript-only; see conformance note).
- **Unit B** — register `@formExclude` on the `field.*` wildcard (cross-port, all five ports).
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
| Styled submit + new class names | **Include now** | The new checkbox/radio controls need class names regardless; emitting them unnamed and renaming later would churn every adopter's three-way merge twice. Inert hooks without CSS is already the template's contract. |
| Blank-optional submit fix | **Defer + file tracking issue** | Porting as-is ships a silent data bug under FR-035 tristate (deleting a cleared key = "untouched" ⇒ the clear silently fails on edit). The correct fix is tristate-aware; its own cycle. |

## Design

### Unit A — `@rows` on `view.textarea`

Add a `view.textarea` block to the `metaobjects-ui` provider's `extends[]` in
`spec/metamodel/ui.json`, mirroring the existing `view.currency` / `@locale` entry:

```jsonc
{
  "type": "view",
  "subType": "textarea",
  "children": [
    { "type": "attr", "subType": "int", "name": "rows", "min": 0, "max": 1,
      "description": "Visible row count for the generated <textarea>. Read by the form generator; defaults to 4 when absent." }
  ]
}
```

Regenerate the embedded metamodel (`scripts/generate-embedded-metamodel.ts` →
`server/typescript/packages/metadata/src/presentation/ui/ui-definition.embedded.ts`); the
embedded `.embedded.ts` file is auto-generated and must not be hand-edited.

**Conformance note (TypeScript-only):** `view.textarea` is a presentation-only **excluded** row
in the registry manifest — the manifest emitter drops every `view.*` row except `base` and
`currency`, including all its attrs. So `@rows` is invisible to the `registry-conformance` gate:
**no `expected-registry.json` change, no other-port work.** Registering it in the TS provider is
sufficient. (It still must be registered so strict `meta verify` accepts `view.textarea @rows`.)

### Unit B — `@formExclude` on the `field.*` wildcard (cross-port)

Add a boolean `formExclude` attr to the existing `field.*` wildcard `children[]` in
`spec/metamodel/ui.json`, peer to `@filterable`/`@sortable`:

```jsonc
{ "type": "attr", "subType": "boolean", "name": "formExclude", "min": 0, "max": 1,
  "description": "When true, the field is omitted from generated forms. Inert on fields for which no form is generated (e.g. projection/derived fields)." }
```

Because a field-level attr on the `field.*` wildcard appears **once per concrete field subtype**
in `expected-registry.json`, and the `registry-conformance` gate byte-matches that manifest in
all five ports, this attr is **cross-port**. It must land atomically across:

- `spec/metamodel/ui.json` + regenerate the TS embedded metamodel.
- Java: `server/java/metadata/src/main/java/com/metaobjects/presentation/ui/UiTypesMetaDataProvider.java`
  (Java refreshes from `spec/`; Kotlin shares the JVM `metadata` module — no separate registration).
- Python: `server/python/src/metaobjects/meta/presentation/ui/ui_provider.py` and the committed
  Python spec copy.
- C#: `server/csharp/MetaObjects/Presentation/Ui/UiMetaDataProvider.cs` and the committed
  `server/csharp/MetaObjects/SpecMetamodel/ui.json`.
- Regenerate `fixtures/registry-conformance/expected-registry.json` (adds `@formExclude` under
  every concrete field subtype).

The port work is mechanical — it mirrors the `@filterable`/`@sortable` registration already
present in each port — and is driven with the `cross-language-porting` discipline. Landing all
five ports plus the fixture in one change keeps `main` green.

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
  - `textarea` → `<textarea className="metaobjects-field-input" rows={<rows>} {...form.register(name)} />`,
    where `<rows>` reads `@rows` off the **view child** (`field.views()[0].attr(rows)`), default 4.
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

- **Unit A/B loader tests:** a strict-mode load of `view.textarea @rows` and
  `field.string @formExclude` succeeds (no `ERR_UNKNOWN_ATTR`). For Unit B, the regenerated
  `registry-conformance` fixture is the cross-port gate — every port re-runs it.
- **Unit C render tests:** a metadata fixture exercising an enum field, a `view.textarea @rows`,
  a `view.checkbox`, and a `view.radio` field. Call `renderFormFile` and assert the output
  contains `<select>` + its `<option>`s, `<textarea ... rows={N}>`, `<input type="checkbox">`,
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

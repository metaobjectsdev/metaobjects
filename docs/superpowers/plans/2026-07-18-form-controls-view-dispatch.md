# Form-controls view-dispatch — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the generated `<Entity>Form` render the right control for each field's declared view kind (enum→`<select>`, `view.textarea`→`<textarea>`, `view.checkbox`, `view.radio`) instead of a bare `<input>` per scalar, and register the two attributes the codegen already reads — `@rows` and `@formExclude`.

**Architecture:** Three units. Unit A registers `@rows` on `view.textarea` via `spec/metamodel/view.json` (TS-registration-only). Unit B registers `@formExclude` on the `field.*` wildcard via `spec/metamodel/ui.json` (cross-port, data-driven — JSON sync + regen, no non-TS code). Unit C upgrades the `renderFormFile` template with a view-kind dispatch. Cross-port ports are data-driven: they load the spec JSON, so Units A/B are JSON edits + regeneration, not per-port code.

**Tech Stack:** TypeScript (Bun test runner, ts-poet templates), the `@metaobjectsdev/metadata` loader + registry, the `metaobjects-ui` / `metaobjects-core-types` metamodel providers, `fixtures/registry-conformance` cross-port gate. Design spec: `docs/superpowers/specs/2026-07-18-form-controls-view-dispatch-design.md`.

## Global Constraints

- **ESM only. No `any`** — use `unknown` and narrow.
- **Named constants for all metamodel strings** — never inline `"formExclude"`, `"rows"`, `"textarea"`, `"enum"`, etc. Import from the constants modules.
- **Public repository** — no consumer/other-project names, no absolute home paths, in any committed file, fixture, test, doc, or commit message. Use repo-relative paths and generic terms ("a downstream consumer").
- **TDD** — failing test first, watch it fail, minimal implementation, watch it pass, commit.
- **`own*()` accessors are forbidden** except a codegen emitting a subclass's own members (ADR-0039). Use resolving accessors: `field.views()`, `field.attr(...)`, `view.attr(...)`.
- **Delivery** — default-on, generated-output-only change; ships as a minor. No opt-in flag.
- **Cross-port atomicity (Unit B)** — the canonical JSON edit, the committed C#/Python copies, and the regenerated `expected-registry.json` must land in **one commit** or `main` goes red.
- **Auto-generated files are never hand-edited** — `*-definition.embedded.ts` and `expected-registry.json` are produced by scripts.
- **Run tests scoped**, never a bare repo-root `bun test`.

---

## File Structure

**Unit A — `@rows` (view.json):**
- Modify: `spec/metamodel/view.json` — add `rows` int attr to the `view.textarea` entry.
- Modify (sync copy): `server/csharp/MetaObjects/SpecMetamodel/view.json`
- Modify (sync copy): `server/python/src/metaobjects/spec_metamodel/view.json`
- Regenerate: `server/typescript/packages/metadata/src/presentation/view/view-definition.embedded.ts`
- Modify: `server/typescript/packages/metadata/src/presentation/view/view-constants.ts` — add `VIEW_TEXTAREA_ATTR_ROWS`.

**Unit B — `@formExclude` (ui.json):**
- Modify: `spec/metamodel/ui.json` — add `formExclude` boolean attr to the `field.*` wildcard.
- Modify (sync copy): `server/csharp/MetaObjects/SpecMetamodel/ui.json`
- Modify (sync copy): `server/python/src/metaobjects/spec_metamodel/ui.json`
- Regenerate: `server/typescript/packages/metadata/src/presentation/ui/ui-definition.embedded.ts`
- Regenerate: `fixtures/registry-conformance/expected-registry.json`
- Modify: `server/typescript/packages/metadata/src/core/field/field-constants.ts` — add `FIELD_ATTR_FORM_EXCLUDE`.

**Unit C — view-dispatch codegen:**
- Modify: `server/typescript/packages/codegen-ts-react/src/templates/form-file.ts` — imports, `viewKindFor`, `labelAndError`, `fieldControlFor`, main-loop dispatch swap, use `FIELD_ATTR_FORM_EXCLUDE` at the `formExclude` read, styled submit.
- Test: `server/typescript/packages/codegen-ts-react/test/form-view-dispatch.test.ts` (new).

**Unit D — deferred-work tracking:**
- A GitHub issue for the tristate-aware blank-optional submit fix.

---

## Task 1: Register `@rows` on `view.textarea` (view.json, TS-registration-only)

**Files:**
- Modify: `spec/metamodel/view.json:14-18` (the `view.textarea` entry)
- Modify: `server/csharp/MetaObjects/SpecMetamodel/view.json`
- Modify: `server/python/src/metaobjects/spec_metamodel/view.json`
- Modify: `server/typescript/packages/metadata/src/presentation/view/view-constants.ts`
- Regenerate: `server/typescript/packages/metadata/src/presentation/view/view-definition.embedded.ts`

**Interfaces:**
- Produces: the metamodel attribute `@rows` (int, on `view.textarea`) and the constant `VIEW_TEXTAREA_ATTR_ROWS = "rows"` (exported from `view-constants.ts`), both consumed by Task 3.

- [ ] **Step 1: Edit `spec/metamodel/view.json` — add `@rows` to `view.textarea`**

Replace the `textarea` entry (lines 14-18):

```jsonc
    {
      "type": "view",
      "subType": "textarea",
      "description": "Multi-line text area.",
      "children": [
        { "type": "attr", "subType": "int", "name": "rows", "min": 0, "max": 1,
          "description": "Visible row count for the generated <textarea>; read by the form generator, defaults to 4 when absent." }
      ]
    },
```

- [ ] **Step 2: Run the embed drift test to verify it now FAILS**

Run: `cd server/typescript/packages/metadata && bun test test/view-definition-embed.test.ts`
Expected: FAIL — the embedded `view-definition.embedded.ts` no longer matches the edited `view.json`.

- [ ] **Step 3: Regenerate the embedded metamodel**

Run (from repo root): `bun run scripts/generate-embedded-metamodel.ts`
This rewrites `view-definition.embedded.ts` (and every other `*-definition.embedded.ts`) from the spec JSON. Do not hand-edit the embedded file.

- [ ] **Step 4: Run the embed drift test to verify it PASSES**

Run: `cd server/typescript/packages/metadata && bun test test/view-definition-embed.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the `VIEW_TEXTAREA_ATTR_ROWS` constant**

In `server/typescript/packages/metadata/src/presentation/view/view-constants.ts`, in the "View attrs" section next to `VIEW_CURRENCY_ATTR_LOCALE`, add:

```ts
/** Visible row count on a view[textarea]. Defaults to 4 when omitted. */
export const VIEW_TEXTAREA_ATTR_ROWS = "rows";
```

- [ ] **Step 6: Sync the committed C# and Python spec copies (drift gate)**

Run (from repo root):

```bash
cp spec/metamodel/view.json server/csharp/MetaObjects/SpecMetamodel/view.json
cp spec/metamodel/view.json server/python/src/metaobjects/spec_metamodel/view.json
```

(The added attr is inert in those ports — `view.textarea` is not a registered subtype there, so the entry is carried but never processed. Java auto-copies from `spec/` at build; Kotlin rides Java. This `cp` only keeps the byte-identity drift gate green.)

- [ ] **Step 7: Verify TS registry-conformance is unchanged (rows stays out of the manifest)**

Run (from repo root): `bun run scripts/regen-expected-registry.ts`
Then: `git status --short fixtures/registry-conformance/expected-registry.json`
Expected: **no change** to `expected-registry.json` (`view.textarea` is a presentation-only excluded manifest row, so `@rows` never enters it). If a diff appears, stop — the exclusion assumption is wrong.

- [ ] **Step 8: Run the metadata view/completeness tests**

Run: `cd server/typescript/packages/metadata && bun test test/view-definition-embed.test.ts test/view-definition-completeness.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add spec/metamodel/view.json \
  server/csharp/MetaObjects/SpecMetamodel/view.json \
  server/python/src/metaobjects/spec_metamodel/view.json \
  server/typescript/packages/metadata/src/presentation/view/view-definition.embedded.ts \
  server/typescript/packages/metadata/src/presentation/view/view-constants.ts
git commit -m "feat(metadata): register @rows on view.textarea (TS-registration-only)"
```

---

## Task 2: Register `@formExclude` on the `field.*` wildcard (ui.json, cross-port)

**Files:**
- Modify: `spec/metamodel/ui.json` (the `field.*` `children` array)
- Modify: `server/csharp/MetaObjects/SpecMetamodel/ui.json`
- Modify: `server/python/src/metaobjects/spec_metamodel/ui.json`
- Regenerate: `server/typescript/packages/metadata/src/presentation/ui/ui-definition.embedded.ts`
- Regenerate: `fixtures/registry-conformance/expected-registry.json`
- Modify: `server/typescript/packages/metadata/src/core/field/field-constants.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: the metamodel attribute `@formExclude` (boolean, on `field.*`) and the constant `FIELD_ATTR_FORM_EXCLUDE = "formExclude"` (exported from `field-constants.ts`), both consumed by Task 3.

- [ ] **Step 1: Edit `spec/metamodel/ui.json` — add `@formExclude` to the `field.*` children**

Append to the `field.*` `children` array (after the `sortableDefaultOrder` attr):

```jsonc
        { "type": "attr", "subType": "boolean", "name": "formExclude", "min": 0, "max": 1, "description": "When true, the field is omitted from generated forms. Inert on fields for which no form is generated (e.g. projection/derived fields)." }
```

(The `children` array's prior last entry `sortableDefaultOrder` needs a trailing comma added.)

- [ ] **Step 2: Sync the committed C# and Python spec copies**

Run (from repo root):

```bash
cp spec/metamodel/ui.json server/csharp/MetaObjects/SpecMetamodel/ui.json
cp spec/metamodel/ui.json server/python/src/metaobjects/spec_metamodel/ui.json
```

- [ ] **Step 3: Run the ui embed drift test to verify it FAILS**

Run: `cd server/typescript/packages/metadata && bun test test/ui-definition-embed.test.ts`
Expected: FAIL — the embedded `ui-definition.embedded.ts` no longer matches `ui.json`.

- [ ] **Step 4: Regenerate the embedded metamodel**

Run (from repo root): `bun run scripts/generate-embedded-metamodel.ts`

- [ ] **Step 5: Run the ui embed drift test to verify it PASSES**

Run: `cd server/typescript/packages/metadata && bun test test/ui-definition-embed.test.ts`
Expected: PASS.

- [ ] **Step 6: Run TS registry-conformance to verify it now FAILS (registry has the attr, fixture doesn't)**

Run: `cd server/typescript/packages/metadata && bun test test/registry-conformance.test.ts`
Expected: FAIL — the composed registry now carries `formExclude` per field subtype, but `expected-registry.json` does not yet.

- [ ] **Step 7: Regenerate the expected-registry fixture**

Run (from repo root): `bun run scripts/regen-expected-registry.ts`
Then eyeball: `git diff fixtures/registry-conformance/expected-registry.json` should show a `formExclude` entry added adjacent to each `filterable` entry (once per concrete field subtype) and nothing else.

- [ ] **Step 8: Run TS registry-conformance to verify it PASSES**

Run: `cd server/typescript/packages/metadata && bun test test/registry-conformance.test.ts test/registry-coverage.test.ts`
Expected: PASS. (If `registry-coverage.test.ts` fails on a snapshot, regenerate it with `MO_UPDATE_COVERAGE_SNAPSHOT=1 bun test test/registry-coverage.test.ts` and re-run.)

- [ ] **Step 9: Add the `FIELD_ATTR_FORM_EXCLUDE` constant**

In `server/typescript/packages/metadata/src/core/field/field-constants.ts`, next to `FIELD_ATTR_FILTERABLE` / `FIELD_ATTR_SORTABLE` (lines ~98-100), add:

```ts
/** When true, the field is omitted from generated forms. */
export const FIELD_ATTR_FORM_EXCLUDE = "formExclude";
```

(The template's existing `formExclude` read is swapped to this constant in Task 3, where `form-file.ts` is already open.)

- [ ] **Step 10: Verify the non-TS ports' conformance**

Run each (a toolchain that is unavailable locally is gated by local-ci on push — note which you skipped):

```bash
cd server/java   && mvn -pl metadata test -Dtest='RegistryManifestConformanceTest' -q
cd server/java   && mvn -pl codegen-kotlin test -Dtest='RegistryManifestConformanceTest' -q
cd server/python && uv run pytest tests/conformance/test_registry_conformance.py tests/conformance/test_spec_metamodel_embed.py -q
cd server/csharp && dotnet test MetaObjects.Conformance.Tests/MetaObjects.Conformance.Tests.csproj --nologo
```

Expected: PASS in every runnable port. Java reads `spec/metamodel/ui.json` off its build classpath (auto-refresh); Kotlin composes the same JVM registry; Python/C# read their committed copies (synced in Step 2). No non-TS code edits are required.

- [ ] **Step 11: Commit (atomic — all copies + regen together)**

```bash
git add spec/metamodel/ui.json \
  server/csharp/MetaObjects/SpecMetamodel/ui.json \
  server/python/src/metaobjects/spec_metamodel/ui.json \
  server/typescript/packages/metadata/src/presentation/ui/ui-definition.embedded.ts \
  server/typescript/packages/metadata/src/core/field/field-constants.ts \
  fixtures/registry-conformance/expected-registry.json
git commit -m "feat(metadata): register @formExclude on field.* wildcard (cross-port)"
```

---

## Task 3: `formFile` view-dispatch codegen

**Files:**
- Modify: `server/typescript/packages/codegen-ts-react/src/templates/form-file.ts`
- Test: `server/typescript/packages/codegen-ts-react/test/form-view-dispatch.test.ts` (new)

**Interfaces:**
- Consumes: `VIEW_TEXTAREA_ATTR_ROWS` (Task 1), `FIELD_ATTR_FORM_EXCLUDE` (Task 2), and the existing `VIEW_SUBTYPE_{TEXTAREA,DROPDOWN,CHECKBOX,RADIO}`, `FIELD_SUBTYPE_ENUM`, `FIELD_ATTR_{VALUES,REQUIRED}` constants — all from `@metaobjectsdev/metadata`.
- Produces: the upgraded generated form output (final task; nothing downstream depends on it).

- [ ] **Step 1: Write the failing test**

Create `server/typescript/packages/codegen-ts-react/test/form-view-dispatch.test.ts`:

```ts
// Form controls: renderFormFile dispatches on each field's view kind.
import { describe, test, expect } from "bun:test";
import {
  MetaDataLoader,
  InMemoryStringSource,
  type MetaObject,
  type MetaRoot,
} from "@metaobjectsdev/metadata";
import { renderFormFile } from "../src/templates/form-file.js";
import { makeRenderContext, buildPkMap, buildRelationMap } from "@metaobjectsdev/codegen-ts";

async function loadModel(): Promise<{ root: MetaRoot; report: MetaObject }> {
  const loader = new MetaDataLoader();
  const { root, errors } = await loader.load([
    new InMemoryStringSource(
      JSON.stringify({
        "metadata.root": {
          package: "demo",
          children: [
            {
              "object.entity": {
                name: "Report",
                children: [
                  { "source.rdb": { "@table": "reports" } },
                  { "field.long": { name: "id" } },
                  { "identity.primary": { name: "id", "@fields": "id", "@generation": "increment" } },
                  { "field.string": { name: "name", "@required": true } },
                  // enum with no explicit view -> dropdown default
                  { "field.enum": { name: "status", "@required": true, "@values": ["draft", "active", "closed"] } },
                  // view.textarea @rows -> <textarea rows={8}>
                  { "field.string": { name: "notes", children: [{ "view.textarea": { "@rows": 8 } }] } },
                  // view.checkbox -> checkbox
                  { "field.boolean": { name: "archived", children: [{ "view.checkbox": {} }] } },
                  // view.radio over enum values -> radio fieldset
                  { "field.enum": { name: "tier", "@values": ["free", "pro"], children: [{ "view.radio": {} }] } },
                  // @formExclude -> absent from the form
                  { "field.string": { name: "internalNote", "@formExclude": true } },
                ],
              },
            },
          ],
        },
      }),
      { id: "report.json" },
    ),
  ]);
  if (errors.length > 0) throw new Error(errors.map((e) => e.message).join("; "));
  const report = root.objects().find((o) => o.name === "Report")! as MetaObject;
  return { root, report };
}

function ctxFor(root: MetaRoot) {
  return makeRenderContext({
    dialect: "postgres",
    loadedRoot: root,
    outDir: "/x",
    dbImport: "../db",
    extStyle: "none",
    apiPrefix: "/api",
    pkMap: buildPkMap(root),
    relationMap: buildRelationMap(root),
  });
}

describe("form controls — view-kind dispatch", () => {
  test("enum with no view renders a <select>, not a bare bound input", async () => {
    const { root, report } = await loadModel();
    const out = renderFormFile(report, ctxFor(root));
    expect(out).toContain("<select");
    expect(out).toContain('<option value="draft">');
    expect(out).toContain('<option value="active">');
    expect(out).toContain('form.register("status")');
    expect(out).not.toMatch(/form\.input\.status/);
  });

  test("view.textarea renders a <textarea> with the @rows count", async () => {
    const { root, report } = await loadModel();
    const out = renderFormFile(report, ctxFor(root));
    expect(out).toContain("<textarea");
    expect(out).toContain("rows={8}");
    expect(out).toContain('form.register("notes")');
  });

  test("view.checkbox renders a checkbox input", async () => {
    const { root, report } = await loadModel();
    const out = renderFormFile(report, ctxFor(root));
    expect(out).toContain('type="checkbox"');
    expect(out).toContain('form.register("archived")');
  });

  test("view.radio renders a radio fieldset over the enum values", async () => {
    const { root, report } = await loadModel();
    const out = renderFormFile(report, ctxFor(root));
    expect(out).toContain('className="metaobjects-field-radios"');
    expect(out).toContain('type="radio"');
    expect(out).toContain('value="free"');
    expect(out).toContain('value="pro"');
  });

  test("a scalar string with no view keeps the existing bound <input>", async () => {
    const { root, report } = await loadModel();
    const out = renderFormFile(report, ctxFor(root));
    expect(out).toContain("{...form.input.name}");
  });

  test("a @formExclude field is absent from the form", async () => {
    const { root, report } = await loadModel();
    const out = renderFormFile(report, ctxFor(root));
    expect(out).not.toContain("internalNote");
  });

  test("the submit button is wrapped in the styled actions container", async () => {
    const { root, report } = await loadModel();
    const out = renderFormFile(report, ctxFor(root));
    expect(out).toContain('className="metaobjects-form-actions"');
    expect(out).toContain('className="metaobjects-form-submit"');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server/typescript/packages/codegen-ts-react && bun test test/form-view-dispatch.test.ts`
Expected: FAIL — the enum still renders `{...form.input.status}`, there is no `<select>`/`<textarea>`/checkbox/radio, and no `metaobjects-form-actions` wrapper.

- [ ] **Step 3: Add the required imports**

In `server/typescript/packages/codegen-ts-react/src/templates/form-file.ts`, extend the existing import from `@metaobjectsdev/metadata` to include the constants the dispatch needs:

```ts
import {
  // ...existing imports (MetaField, MetaObject, stripPackage, FIELD_* constants)...
  FIELD_ATTR_FORM_EXCLUDE,
  FIELD_ATTR_VALUES,
  FIELD_ATTR_REQUIRED,
  FIELD_SUBTYPE_ENUM,
  VIEW_SUBTYPE_TEXTAREA,
  VIEW_SUBTYPE_DROPDOWN,
  VIEW_SUBTYPE_CHECKBOX,
  VIEW_SUBTYPE_RADIO,
  VIEW_TEXTAREA_ATTR_ROWS,
} from "@metaobjectsdev/metadata";
```

(Only add the names not already imported; leave the rest of the import list intact.)

- [ ] **Step 4: Swap the `formExclude` literal for the constant**

In `visibleFields`, change the bare-string read (currently `form-file.ts:72`):

```ts
    if (child.attr(FIELD_ATTR_FORM_EXCLUDE) === true) continue;
```

- [ ] **Step 5: Add `viewKindFor` and `labelAndError` helpers**

Add near the other module-scope helpers in `form-file.ts`:

```ts
/** The view kind that drives control selection: an explicit view child wins;
 *  an enum with no view defaults to a dropdown; otherwise null (typed <input>). */
function viewKindFor(field: MetaField): string | null {
  const view = field.views()[0]; // resolving accessor (ADR-0039)
  if (view !== undefined) return view.subType;
  if (field.subType === FIELD_SUBTYPE_ENUM) return VIEW_SUBTYPE_DROPDOWN;
  return null;
}
```

Inside `renderFormFile` (so it closes over `entityName`), add the shared wrapper used by the new control branches:

```ts
  const labelAndError = (f: string, control: string) =>
    `        <div className="metaobjects-field" key=${JSON.stringify(f)}>
          <label className="metaobjects-field-label" htmlFor={${entityName}.${f}.name}>
            {${entityName}.${f}.label}
          </label>
${control}
          {form.formState.errors.${f} !== undefined && (
            <span className="metaobjects-field-error" role="alert">
              {String(form.formState.errors.${f}?.message ?? '')}
            </span>
          )}
        </div>`;
```

- [ ] **Step 6: Add the `fieldControlFor` dispatcher**

Inside `renderFormFile`, next to the existing `scalarBlock` (so it can fall back to it), add:

```ts
  const fieldControlFor = (field: MetaField): string => {
    const name = field.name;
    const kind = viewKindFor(field);
    // Enum member symbols are validated to /^[A-Za-z_][A-Za-z0-9_]*$/, so raw
    // interpolation into JSX attribute/text positions is safe (no escaping).
    if (kind === VIEW_SUBTYPE_DROPDOWN) {
      const values = (field.attr(FIELD_ATTR_VALUES) as string[] | undefined) ?? [];
      const required = field.attr(FIELD_ATTR_REQUIRED) === true;
      const empty = required ? "" : `            <option value="">Select…</option>\n`;
      const options = values.map((v) => `            <option value="${v}">${v}</option>`).join("\n");
      return labelAndError(
        name,
        `          <select className="metaobjects-field-input" {...form.register("${name}")}>\n${empty}${options}\n          </select>`,
      );
    }
    if (kind === VIEW_SUBTYPE_TEXTAREA) {
      const rows = (field.views()[0]?.attr(VIEW_TEXTAREA_ATTR_ROWS) as number | undefined) ?? 4;
      return labelAndError(
        name,
        `          <textarea className="metaobjects-field-input" rows={${rows}} {...form.register("${name}")} />`,
      );
    }
    if (kind === VIEW_SUBTYPE_CHECKBOX) {
      return labelAndError(
        name,
        `          <input type="checkbox" className="metaobjects-field-checkbox" {...form.register("${name}")} />`,
      );
    }
    if (kind === VIEW_SUBTYPE_RADIO) {
      const values = (field.attr(FIELD_ATTR_VALUES) as string[] | undefined) ?? [];
      const radios = values
        .map(
          (v) =>
            `            <label className="metaobjects-field-radio"><input type="radio" value="${v}" {...form.register("${name}")} /> ${v}</label>`,
        )
        .join("\n");
      return labelAndError(name, `          <fieldset className="metaobjects-field-radios">\n${radios}\n          </fieldset>`);
    }
    return scalarBlock(name);
  };
```

- [ ] **Step 7: Swap the main-loop dispatch**

In the main field loop (currently `form-file.ts:306`), change the scalar branch from `scalarBlock(f.name)` to the dispatcher:

```ts
  for (const f of fields) {
    if (resolveValueObject(f, ctx) === undefined) {
      blocks.push(fieldControlFor(f));
      continue;
    }
    const r = renderNestedField(f, f.name, false, ctx, new Set<string>(), 0);
    blocks.push(r.jsx);
    fieldArrayHooks.push(...r.hooks);
  }
```

- [ ] **Step 8: Wrap the submit button (styled submit)**

Change the bare button (currently `form-file.ts:360`) to:

```tsx
      <div className="metaobjects-form-actions">
        <button className="metaobjects-form-submit" type="submit" disabled={form.formState.isSubmitting}>
          {props.submitLabel ?? 'Submit'}
        </button>
      </div>
```

- [ ] **Step 9: Run the new test to verify it passes**

Run: `cd server/typescript/packages/codegen-ts-react && bun test test/form-view-dispatch.test.ts`
Expected: PASS (all seven cases).

- [ ] **Step 10: Run the full codegen-ts-react suite (no regressions)**

Run: `cd server/typescript/packages/codegen-ts-react && bun test`
Expected: PASS — in particular `nested-value-object-form.test.ts` (scalars still bind via `form.input.name`) and `tph-form.test.ts` are unaffected.

- [ ] **Step 11: Typecheck the workspace**

Run (from repo root): `bun run --filter '*' build && bun run --filter '*' typecheck`
Expected: PASS (no `any`, all constants resolve).

- [ ] **Step 12: Commit**

```bash
git add server/typescript/packages/codegen-ts-react/src/templates/form-file.ts \
  server/typescript/packages/codegen-ts-react/test/form-view-dispatch.test.ts
git commit -m "feat(codegen-ts-react): dispatch form controls on field view kind"
```

---

## Task 4: File the deferred blank-optional-fix tracking issue

**Files:** none (a GitHub issue).

**Interfaces:** none.

- [ ] **Step 1: File the tracking issue**

Run (genericized — no consumer/project names):

```bash
gh issue create \
  --title "Form generator: tristate-aware blank-optional field submit handling" \
  --body "$(cat <<'EOF'
Deferred from the form-controls view-dispatch cycle (spec:
docs/superpowers/specs/2026-07-18-form-controls-view-dispatch-design.md).

A generated form's blank optional scalar inputs submit "" (empty string). For a
nullable date/timestamp column this is invalid, and a `!= null` check misreads ""
as "set". A downstream implementation worked around this by deleting ""-valued
keys from the submit payload. That fix was NOT promoted because it conflicts with
FR-035 present-key PATCH tristate: deleting a cleared field's key means "untouched",
so on the edit/PATCH path clearing a previously-set optional field silently fails
to clear it.

The correct behavior is tristate-aware and needs create-vs-edit + dirty-state
awareness:
- blank on CREATE -> omit the key (or send null) so the column defaults/NULLs,
- a field that was set and is now cleared on EDIT -> send explicit null (present-null clears),
- a @required field left untouched -> unchanged.

Scope: the generated form's submit handler in codegen-ts-react (and its React
runtime binding). Until this lands, the promoted form template inherits the
pre-existing ""-vs-NULL wart for blank optional date/timestamp inputs on CREATE.
EOF
)" \
  --label enhancement
```

- [ ] **Step 2: Record the issue number**

Note the issue URL/number in the commit that closes out the cycle (or reply to the user). No code change.

---

## Self-Review

**1. Spec coverage:**
- Unit A (`@rows` via `view.json`, TS-registration-only, drift-gate sync) → Task 1. ✓
- Unit B (`@formExclude` via `ui.json`, cross-port, data-driven, atomic) → Task 2. ✓
- Unit C (`viewKindFor` / `labelAndError` / `fieldControlFor` dispatch, enum→dropdown default, styled submit + semantic class names, constant usage) → Task 3. ✓
- Named constants (`VIEW_TEXTAREA_ATTR_ROWS`, `FIELD_ATTR_FORM_EXCLUDE`) defined (Tasks 1/2) + used (Task 3). ✓
- Testing (loader/registration gated by embed + conformance; render tests) → Tasks 1/2 gates + Task 3 render tests. ✓
- Deferred blank-optional fix + tracking issue → Task 4. ✓
- Out-of-scope (image branch, `form.css` file) → not implemented, correctly absent. ✓

**2. Placeholder scan:** No "TBD"/"TODO"/"handle edge cases"/"similar to". Every code step shows the code; every run step shows the command + expected result. ✓

**3. Type consistency:** `viewKindFor(field: MetaField): string | null`; `fieldControlFor(field: MetaField): string`; `labelAndError(f: string, control: string)`; `scalarBlock(f: string)` (existing, name-string arg — matched). `field.views()[0]?.attr(...)`, `field.attr(...)` return `unknown`, narrowed with `as` to the expected shapes. Constant names match their definitions in Tasks 1/2. ✓

**Dependency note:** Task 3's render test loads a fixture using `view.textarea @rows` and `field.string @formExclude`; under the strict loader those must be registered first, so Tasks 1 and 2 must complete before Task 3. Task 4 is independent.

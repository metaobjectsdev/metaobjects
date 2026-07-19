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
                  // view.textarea -> <textarea rows={4}> (configurable @rows deferred)
                  { "field.string": { name: "notes", children: [{ "view.textarea": {} }] } },
                  // view.checkbox -> checkbox
                  { "field.boolean": { name: "archived", children: [{ "view.checkbox": {} }] } },
                  // view.radio over enum values -> radio fieldset
                  { "field.enum": { name: "tier", "@values": ["free", "pro"], children: [{ "view.radio": {} }] } },
                  // non-required enum with an explicit dropdown -> empty option IS emitted
                  { "field.enum": { name: "priority", "@values": ["low", "high"], children: [{ "view.dropdown": {} }] } },
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
    expect(out).toContain("aria-label={Report.status.label}");
  });

  test("view.textarea renders a <textarea> with the default row count", async () => {
    const { root, report } = await loadModel();
    const out = renderFormFile(report, ctxFor(root));
    expect(out).toContain("<textarea");
    expect(out).toContain("rows={4}");
    expect(out).toContain('form.register("notes")');
    expect(out).toContain("aria-label={Report.notes.label}");
  });

  test("view.checkbox renders a checkbox input", async () => {
    const { root, report } = await loadModel();
    const out = renderFormFile(report, ctxFor(root));
    expect(out).toContain('type="checkbox"');
    expect(out).toContain('form.register("archived")');
    expect(out).toContain("aria-label={Report.archived.label}");
  });

  test("view.radio renders a radio fieldset over the enum values", async () => {
    const { root, report } = await loadModel();
    const out = renderFormFile(report, ctxFor(root));
    expect(out).toContain('className="metaobjects-field-radios"');
    expect(out).toContain('type="radio"');
    expect(out).toContain('value="free"');
    expect(out).toContain('value="pro"');
    expect(out).toContain("aria-label={Report.tier.label}");
  });

  test("a non-required dropdown emits the empty option", async () => {
    const { root, report } = await loadModel();
    const out = renderFormFile(report, ctxFor(root));
    expect(out).toContain('<option value="">');
    expect(out).toContain("aria-label={Report.priority.label}");
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

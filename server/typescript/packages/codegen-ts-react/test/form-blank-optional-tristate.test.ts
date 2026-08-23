// #223 — a blank optional control submits `""`, and the generated form must resolve it
// into the FR-035 present-key tristate rather than passing it through.
//
// A blank text/date/number input, an unselected `<option value="">` and an empty textarea
// all yield `""`, so an HTML form cannot distinguish "empty" from "not provided". For a
// nullable date/timestamp column `""` is not even a legal value, and everywhere else it
// makes a `!= null` check read a blank field as SET.
//
// The correct handling is create-vs-edit aware, which is why the blanket "strip empty
// strings" a downstream project reached for was NOT promoted: under FR-035 an absent key
// means "leave untouched", so stripping a cleared field on the EDIT path silently fails
// to clear it — trading a visible wart for an invisible one.
//
// These tests EXECUTE the emitted normalizer rather than grepping for it: a golden that
// only asserts the text is present goes quiet the moment the text is regenerated to match
// a bad fix.

import { describe, test, expect } from "bun:test";
import { formFile } from "../src/form-file.js";
import { makeRenderContext, buildPkMap, buildRelationMap } from "@metaobjectsdev/codegen-ts";
import type { GenContext } from "@metaobjectsdev/codegen-ts";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";

async function formFor(entityChildren: unknown[], name = "Booking"): Promise<string> {
  const json = JSON.stringify({
    "metadata.root": {
      package: "acme",
      children: [
        {
          "object.entity": {
            name,
            "@emitForm": true,
            children: [
              { "source.rdb": { "@table": "bookings" } },
              { "field.int": { name: "id" } },
              { "identity.primary": { name: "id", "@fields": "id" } },
              ...entityChildren,
            ],
          },
        },
      ],
    },
  });
  const { root, errors } = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
  if (errors.length > 0) throw new Error(errors.map((e) => e.message).join("\n"));

  const renderContext = makeRenderContext({
    dialect: "sqlite", loadedRoot: root, outDir: "/tmp",
    dbImport: "../db", extStyle: "none",
    pkMap: buildPkMap(root), relationMap: buildRelationMap(root),
  });
  const gen = formFile();
  const ctx: GenContext = {
    entities: root.objects(),
    loadedRoot: root,
    matches: (e) => gen.filter?.(e) ?? true,
    config: { outDir: "/tmp", extStyle: "none", dbImport: "../db", dialect: "sqlite" },
    renderContext,
    warn: () => {},
  };
  const files = await gen.generate(ctx);
  const f = files.find((x) => x.path === `${name}.form.tsx`);
  if (f === undefined) throw new Error(`no form emitted for ${name}`);
  return f.content;
}

/**
 * Lift the EMITTED normalizer out of the generated file and run it, so these assertions
 * are about the shipped behaviour and not about a hand-written copy of it. The function
 * is plain TS with no imports, so stripping its two type annotations is enough to make it
 * evaluable — anything more elaborate would be re-implementing it, which is the trap.
 */
function emittedNormalizer(src: string): (v: Record<string, unknown>, isEdit: boolean) => Record<string, unknown> {
  const constLine = src.match(/const BLANK_OPTIONAL_FIELDS = .*?;/s);
  const fnBody = src.match(/function normalizeBlankOptionals[\s\S]*?\n}/);
  if (constLine === null || fnBody === null) throw new Error("normalizer not emitted");
  const js = `${constLine[0]}\n${fnBody[0]}\nreturn normalizeBlankOptionals;`
    .replace(/ as const/g, "")
    .replace(/: Record<string, unknown>/g, "")
    .replace(/: boolean/g, "")
    .replace(/\)\s*\{/, ") {");
  return new Function(js)() as never;
}

/** The emitted blankable-field LIST. Asserted directly, because a field name also occurs
 *  in the JSX below it — matching the whole file would pass on the wrong occurrence. */
function blankFieldList(src: string): string[] {
  const m = src.match(/const BLANK_OPTIONAL_FIELDS = (\[[^\]]*\])/);
  return m === null ? [] : (JSON.parse(m[1] as string) as string[]);
}

const OPTIONAL_DATE = { "field.date": { name: "startsOn" } };
const OPTIONAL_TEXT = { "field.string": { name: "note" } };
const REQUIRED_TEXT = { "field.string": { name: "title", "@required": true } };
const CHECKBOX = {
  "field.boolean": { name: "confirmed", children: [{ "view.checkbox": { name: "v" } }] },
};

describe("generated form — blank optional fields are tristate-aware (#223)", () => {
  test("CREATE: a blank optional key is OMITTED, so the column's default/NULL applies", async () => {
    const normalize = emittedNormalizer(await formFor([OPTIONAL_DATE, OPTIONAL_TEXT, REQUIRED_TEXT]));
    const out = normalize({ title: "Trip", startsOn: "", note: "" }, false);

    expect("startsOn" in out).toBe(false);
    expect("note" in out).toBe(false);
    expect(out.title).toBe("Trip");
  });

  test("EDIT: a cleared optional field is sent as explicit null, which is what CLEARS it", async () => {
    const normalize = emittedNormalizer(await formFor([OPTIONAL_DATE, OPTIONAL_TEXT, REQUIRED_TEXT]));
    const out = normalize({ title: "Trip", startsOn: "", note: "" }, true);

    // Present-and-null, not absent — absent means "untouched" under FR-035, which is
    // precisely how the naive strip-empty-strings fix loses the clear.
    expect("startsOn" in out).toBe(true);
    expect(out.startsOn).toBe(null);
    expect(out.note).toBe(null);
  });

  test("a value the user actually entered is never rewritten, in either mode", async () => {
    const normalize = emittedNormalizer(await formFor([OPTIONAL_DATE, OPTIONAL_TEXT, REQUIRED_TEXT]));
    const values = { title: "Trip", startsOn: "2026-01-01", note: "hi" };

    expect(normalize({ ...values }, false)).toEqual(values);
    expect(normalize({ ...values }, true)).toEqual(values);
  });

  test("a @required field is left alone — blank there is a validation error, not a null", async () => {
    const src = await formFor([OPTIONAL_DATE, REQUIRED_TEXT]);
    expect(blankFieldList(src)).toEqual(["startsOn"]);

    // And behaviourally: an empty required field survives to the schema that rejects it.
    const out = emittedNormalizer(src)({ title: "", startsOn: "" }, false);
    expect(out.title).toBe("");
  });

  test("a checkbox is excluded — a boolean control cannot produce an empty string", async () => {
    const src = await formFor([CHECKBOX, OPTIONAL_TEXT]);
    expect(blankFieldList(src)).toEqual(["note"]);

    // `false` is a real answer and must never be treated as blank.
    expect(emittedNormalizer(src)({ confirmed: false, note: "" }, true)).toEqual({
      confirmed: false,
      note: null,
    });
  });

  test("an all-required form emits no normalizer at all — output stays byte-identical", async () => {
    const src = await formFor([REQUIRED_TEXT]);
    expect(src).not.toContain("normalizeBlankOptionals");
    expect(src).toContain("form.handleSubmit(props.onSubmit as never)");
  });
});

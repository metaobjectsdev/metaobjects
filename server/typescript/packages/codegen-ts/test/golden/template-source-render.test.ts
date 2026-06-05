// Golden tests for the three template-source renderers (linked-template-source-docs, Task 3).
//
// The renderers are pure functions over the annotated-template IR (TplToken[])
// produced by annotateTemplate. They turn ONE IR into THREE doc forms:
//   • renderSourceBlock     — a ```mustache fenced block, byte-identical source.
//   • renderVariablesTable  — a Markdown Variable|Field|Type|Required table.
//   • renderRichLinkedHtml  — a collapsed <details> with inline-styled, linked spans.
//
// We build the IR by running annotateTemplate on a fixture covering: literal
// text, a linked scalar var, a section with a nested linked var, an unescaped
// var, a partial, a comment, and an UNRESOLVED var — plus a literal `<` / `&`
// in the text so the rich-HTML escaping is exercised.

import { describe, test, expect } from "bun:test";
import {
	annotateTemplate,
	type AnnotatePayloadField,
	type TplToken,
} from "../../src/generators/template-source-annotate.js";
import {
	renderSourceBlock,
	renderVariablesTable,
	renderRichLinkedHtml,
} from "../../src/generators/template-source-render.js";

const ROOT_VO = "OrderSummary";
const ITEMS_VO = "LineItem";

const payload: AnnotatePayloadField[] = [
	{ name: "name", owner: ROOT_VO, type: "string", required: true },
	{
		name: "items",
		owner: ROOT_VO,
		type: "object[]",
		required: false,
		fields: [{ name: "sku", owner: ITEMS_VO, type: "string", required: true }],
	},
];

// A literal `<b>` and `&` in the text exercise HTML-escaping in the rich view.
const TEMPLATE =
	"Hi <b>{{name}}</b> ({{{name}}}) & co\n" +
	"{{#items}}- {{sku}}\n{{/items}}" +
	"{{>shared/footer}}\n" +
	"{{! a note }}" +
	"Unknown: {{bogus}}\n";

function annotate(): TplToken[] {
	return annotateTemplate(TEMPLATE, payload, { ownerVoName: ROOT_VO });
}

describe("renderSourceBlock", () => {
	test("wraps the verbatim source in a ```mustache fence, byte-identical", () => {
		const out = renderSourceBlock(annotate());
		expect(out.startsWith("```mustache\n")).toBe(true);
		expect(out.endsWith("```")).toBe(true);
		// The fenced body equals the original source byte-for-byte.
		const body = out.slice("```mustache\n".length, out.length - "\n```".length);
		expect(body).toBe(TEMPLATE);
	});
});

describe("renderVariablesTable", () => {
	test("renders a header row with the four columns", () => {
		const out = renderVariablesTable(annotate());
		expect(out).toContain("| Variable | Field | Type | Required |");
		expect(out).toContain("| --- | --- | --- | --- |");
	});

	test("a resolved scalar var links to [owner.name](href) with type + required", () => {
		const out = renderVariablesTable(annotate());
		expect(out).toContain(
			`| \`{{name}}\` | [${ROOT_VO}.name](./${ROOT_VO}.md#field-name) | string | yes |`,
		);
	});

	test("a nested section var resolves to its own owner + href", () => {
		const out = renderVariablesTable(annotate());
		expect(out).toContain(
			`| \`{{sku}}\` | [${ITEMS_VO}.sku](./${ITEMS_VO}.md#field-sku) | string | yes |`,
		);
	});

	test("the section head itself is listed (resolves to a field)", () => {
		const out = renderVariablesTable(annotate());
		expect(out).toContain(
			`| \`{{items}}\` | [${ROOT_VO}.items](./${ROOT_VO}.md#field-items) | object[] | no |`,
		);
	});

	test("an unresolved var is flagged: no link, em-dashes, a 'not on payload' note", () => {
		const out = renderVariablesTable(annotate());
		expect(out).toContain("| `{{bogus}}` | — (not on payload) | — | — |");
		expect(out.toLowerCase()).toContain("not on payload");
	});

	test("dedups by path (one row per unique variable)", () => {
		const out = renderVariablesTable(annotate());
		// `{{name}}` appears twice in the template (escaped + unescaped) → one row.
		const nameRows = out.split("\n").filter((l) => l.includes("`{{name}}`"));
		expect(nameRows.length).toBe(1);
	});

	test("renders nothing when there are no variables", () => {
		const toks = annotateTemplate("just literal text", payload, {
			ownerVoName: ROOT_VO,
		});
		expect(renderVariablesTable(toks).trim()).toBe("");
	});
});

describe("renderRichLinkedHtml", () => {
	test("is a collapsed <details> (no open attribute) with a <summary> and <pre>", () => {
		const out = renderRichLinkedHtml(annotate());
		expect(out).toContain("<details>");
		expect(out).not.toContain("<details open");
		expect(out).toContain("<summary>");
		expect(out).toContain("<pre");
	});

	test("uses self-contained inline styles, never an external class/CSS", () => {
		const out = renderRichLinkedHtml(annotate());
		expect(out).toContain('<span style="');
		expect(out).not.toContain("class=");
		expect(out).not.toContain("<style");
		expect(out).not.toContain("<link");
	});

	test("wraps resolved variables/sections in a clickable <a href>", () => {
		const out = renderRichLinkedHtml(annotate());
		expect(out).toContain(`<a href="./${ROOT_VO}.md#field-name">`);
		expect(out).toContain(`<a href="./${ITEMS_VO}.md#field-sku">`);
		expect(out).toContain(`<a href="./${ROOT_VO}.md#field-items">`);
	});

	test("does NOT wrap the unresolved var in an <a> (color span only)", () => {
		const out = renderRichLinkedHtml(annotate());
		// The bogus tag text appears, but never inside an href.
		expect(out).toContain("{{bogus}}");
		expect(out).not.toContain("bogus</a>");
	});

	test("HTML-escapes literal < and & from the template text", () => {
		const out = renderRichLinkedHtml(annotate());
		expect(out).toContain("&lt;b&gt;");
		expect(out).toContain("&amp; co");
		// No raw, unescaped literal <b> tag leaked from the template text.
		expect(out).not.toContain("Hi <b>");
	});

	test("preserves newlines inside the <pre> (does not collapse)", () => {
		const out = renderRichLinkedHtml(annotate());
		// The literal newline after `co` survives.
		expect(out).toContain("co\n");
	});
});

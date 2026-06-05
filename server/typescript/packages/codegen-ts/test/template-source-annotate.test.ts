// Annotated-template IR (linked-template-source-docs, Task 1).
//
// annotateTemplate parses a Mustache template (the SAME Mustache.parse verify
// walks) and resolves each {{variable}} to the payload field it references —
// REUSING verify's exported resolveTemplateVariable so the annotator and the
// drift gate share ONE resolution. These tests pin the token mapping, the
// nested-context/dotted-path resolution, the off-payload flagging, and assert
// the annotator's valid-set AGREES with verify's ERR_VAR_NOT_ON_PAYLOAD set.

import { describe, test, expect } from "bun:test";
import { verify, ERR_VAR_NOT_ON_PAYLOAD } from "@metaobjectsdev/render";
import {
	annotateTemplate,
	type AnnotatePayloadField,
	type TplToken,
} from "../src/generators/template-source-annotate.js";

// A fixture payload tree (enriched: owner/type/required carried per node so the
// annotator can emit ResolvedField). The shape extends verify's PayloadField
// (name + optional fields), so the SAME resolution walk applies.
const ROOT_VO = "OrderSummary";
const ITEMS_VO = "LineItem";
const CUSTOMER_VO = "Customer";

const payload: AnnotatePayloadField[] = [
	{ name: "name", owner: ROOT_VO, type: "string", required: true },
	{ name: "status", owner: ROOT_VO, type: "string", required: false },
	{
		name: "items",
		owner: ROOT_VO,
		type: "object[]",
		required: false,
		fields: [{ name: "sku", owner: ITEMS_VO, type: "string", required: true }],
	},
	{
		name: "customer",
		owner: ROOT_VO,
		type: "object",
		required: false,
		fields: [
			{ name: "email", owner: CUSTOMER_VO, type: "string", required: false },
		],
	},
];

const TEMPLATE =
	"Hi {{name}} ({{{name}}})\n" +
	"{{#items}}- {{sku}}\n{{/items}}" +
	"Contact: {{customer.email}}\n" +
	"{{>shared/footer}}\n" +
	"{{! a note }}" +
	"Unknown: {{bogus}}\n";

function annotate(): TplToken[] {
	return annotateTemplate(TEMPLATE, payload, { ownerVoName: ROOT_VO });
}

// Typed narrowing helpers (no `as any`): pick a token by kind, asserting it
// exists so the returned member type flows into the assertions below.
type VarTok = Extract<TplToken, { kind: "var" | "unescaped" }>;
type TextTok = Extract<TplToken, { kind: "text" }>;

function isVar(t: TplToken): t is VarTok {
	return t.kind === "var" || t.kind === "unescaped";
}
function findVar(toks: TplToken[], path: string): VarTok {
	const hit = toks.find((t) => isVar(t) && t.path === path);
	expect(hit).toBeDefined();
	return hit as VarTok;
}
function findByKind<K extends TplToken["kind"]>(
	toks: TplToken[],
	kind: K,
): Extract<TplToken, { kind: K }> {
	const hit = toks.find((t) => t.kind === kind);
	expect(hit).toBeDefined();
	return hit as Extract<TplToken, { kind: K }>;
}

describe("annotateTemplate: token mapping + order", () => {
	test("emits text tokens preserving literal source between tags", () => {
		const toks = annotate();
		const texts = toks
			.filter((t): t is TextTok => t.kind === "text")
			.map((t) => t.text);
		// The literal prefix and inter-tag text are preserved verbatim.
		expect(texts).toContain("Hi ");
		expect(texts).toContain(" (");
		expect(texts).toContain(")\n");
		expect(texts).toContain("- ");
		expect(texts).toContain("Contact: ");
		expect(texts).toContain("Unknown: ");
		// Concatenating only the text + raw of every token round-trips the source.
		const reconstructed = toks
			.map((t) => (t.kind === "text" ? t.text : t.raw))
			.join("");
		expect(reconstructed).toBe(TEMPLATE);
	});

	test("maps Mustache token types to TplToken kinds", () => {
		const toks = annotate();
		const kinds = toks.map((t) => t.kind);
		expect(kinds).toContain("var");
		expect(kinds).toContain("unescaped");
		expect(kinds).toContain("section");
		expect(kinds).toContain("close");
		expect(kinds).toContain("partial");
		expect(kinds).toContain("comment");
		expect(kinds).toContain("text");
	});
});

describe("annotateTemplate: variable resolution", () => {
	test("a scalar {{name}} resolves to its field + href, valid", () => {
		const v = findVar(annotate(), "name");
		expect(v.kind).toBe("var");
		expect(v.valid).toBe(true);
		expect(v.field).toEqual({
			owner: ROOT_VO,
			name: "name",
			type: "string",
			required: true,
		});
		expect(v.href).toBe(`./${ROOT_VO}.md#field-name`);
	});

	test("{{{name}}} is an unescaped var, resolves the same field", () => {
		const u = findByKind(annotate(), "unescaped");
		expect(u.path).toBe("name");
		expect(u.valid).toBe(true);
		expect(u.field?.name).toBe("name");
		expect(u.href).toBe(`./${ROOT_VO}.md#field-name`);
	});

	test("{{sku}} inside {{#items}} resolves within the items subtree (nested owner)", () => {
		const sku = findVar(annotate(), "sku");
		expect(sku.valid).toBe(true);
		expect(sku.field).toEqual({
			owner: ITEMS_VO,
			name: "sku",
			type: "string",
			required: true,
		});
		expect(sku.href).toBe(`./${ITEMS_VO}.md#field-sku`);
	});

	test("the {{#items}} section head resolves to the items field + its owner href", () => {
		const sec = findByKind(annotate(), "section");
		expect(sec.path).toBe("items");
		expect(sec.field).toEqual({
			owner: ROOT_VO,
			name: "items",
			type: "object[]",
			required: false,
		});
		expect(sec.href).toBe(`./${ROOT_VO}.md#field-items`);
	});

	test("a {{/items}} close token carries the path, no resolution needed", () => {
		const close = findByKind(annotate(), "close");
		expect(close.path).toBe("items");
	});

	test("a dotted {{customer.email}} walks the tree to the nested VO field", () => {
		const dotted = findVar(annotate(), "customer.email");
		expect(dotted.valid).toBe(true);
		expect(dotted.field).toEqual({
			owner: CUSTOMER_VO,
			name: "email",
			type: "string",
			required: false,
		});
		expect(dotted.href).toBe(`./${CUSTOMER_VO}.md#field-email`);
	});

	test("an off-payload {{bogus}} is valid:false with no field/href", () => {
		const bogus = findVar(annotate(), "bogus");
		expect(bogus.valid).toBe(false);
		expect(bogus.field).toBeUndefined();
		expect(bogus.href).toBeUndefined();
	});
});

describe("annotateTemplate: partials + comments", () => {
	test("a partial captures its ref; href optional (undefined here)", () => {
		const p = findByKind(annotate(), "partial");
		expect(p.ref).toBe("shared/footer");
		expect(p.href).toBeUndefined();
	});

	test("a comment is captured by kind, raw preserved", () => {
		const c = findByKind(annotate(), "comment");
		expect(c.raw).toContain("a note");
	});
});

describe("annotator ⇆ verify agreement", () => {
	test("the vars the annotator marks valid == those verify does NOT flag", () => {
		const toks = annotateTemplate(TEMPLATE, payload, { ownerVoName: ROOT_VO });

		// Annotator's view: the set of variable PATHS marked valid:true.
		const annotatorValid = new Set(
			toks.filter(isVar).filter((t) => t.valid).map((t) => t.path),
		);

		// verify's view: every var path it does NOT raise ERR_VAR_NOT_ON_PAYLOAD for.
		// Run verify over the SAME inputs (PayloadField is the structural subset).
		const errors = verify(TEMPLATE, payload);
		const flagged = new Set(
			errors
				.filter((e) => e.code === ERR_VAR_NOT_ON_PAYLOAD)
				.map((e) => e.path),
		);

		// Every annotator-valid path is NOT flagged by verify.
		for (const p of annotatorValid) {
			expect(flagged.has(p)).toBe(false);
		}
		// And the off-payload path verify flags is NOT in the annotator-valid set.
		expect(flagged.has("bogus")).toBe(true);
		expect(annotatorValid.has("bogus")).toBe(false);

		// The positive set the annotator claims valid matches the real fields.
		expect(annotatorValid.has("name")).toBe(true);
		expect(annotatorValid.has("sku")).toBe(true);
		expect(annotatorValid.has("customer.email")).toBe(true);
	});
});

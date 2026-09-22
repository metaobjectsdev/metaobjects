import { describe, test, expect } from "bun:test";
import { MetaDataLoader } from "../src/loader/meta-data-loader.js";
import { InMemoryStringSource } from "../src/loader/meta-data-source.js";

/**
 * A child wrapper's BODY must be an object, and an unregistered child key is an unknown
 * TYPE — in LAX mode as well as strict.
 *
 * The conformance corpus runs the loader STRICT, so
 * `fixtures/conformance/error-child-not-object` and `.../error-unknown-bare-child-type`
 * prove the rule only on that path. Lax is the path that matters for the defect these
 * fixtures were written for: `meta verify` loads strict (ADR-0023, #96) while `meta gen`
 * takes the default, and under the old code the two disagreed about whether the same file
 * was valid — `gen` warned, dropped the child, and emitted a table missing the declared
 * column, which is the failure nobody sees until the column is missing in production.
 *
 * Gated here rather than left to the corpus so a future refactor cannot quietly re-gate
 * the rule on `strict` and keep every fixture green.
 */

async function load(doc: unknown, opts?: { strict: true }) {
	const loader = new MetaDataLoader(opts);
	return loader.load([new InMemoryStringSource(JSON.stringify(doc), { id: "t.json" })]);
}

const withChild = (child: unknown) => ({
	"metadata.root": {
		package: "t",
		children: [
			{
				"object.entity": {
					name: "A",
					children: [
						{ "field.long": { name: "id" } },
						child,
						{ "identity.primary": { name: "pk", "@fields": ["id"] } },
					],
				},
			},
		],
	},
});

const MODES: ReadonlyArray<[string, { strict: true } | undefined]> = [
	["lax", undefined],
	["strict", { strict: true }],
];

describe("a child wrapper's body must be an object", () => {
	for (const [mode, opts] of MODES) {
		test(`${mode}: a registered type with a string body is refused, not dropped`, async () => {
			const { errors } = await load(withChild({ "field.string": "label" }), opts);
			const codes = errors.map((e) => (e as { code?: string }).code);
			expect(codes).toContain("ERR_CHILD_NOT_OBJECT");
		});

		test(`${mode}: an array body is refused`, async () => {
			const { errors } = await load(withChild({ "field.string": ["label"] }), opts);
			expect(errors.map((e) => (e as { code?: string }).code)).toContain("ERR_CHILD_NOT_OBJECT");
		});

		test(`${mode}: a null body is refused`, async () => {
			const { errors } = await load(withChild({ "field.string": null }), opts);
			expect(errors.map((e) => (e as { code?: string }).code)).toContain("ERR_CHILD_NOT_OBJECT");
		});

		// The ATTR door is a separate branch, so the rule needs asserting on it separately.
		// Python's is a separate FUNCTION, and fixing only the structural door left it
		// answering ERR_MISSING_REQUIRED_ATTR — the consequence of coercing the body to {},
		// not the cause.
		test(`${mode}: an attr child with a non-object body is refused`, async () => {
			const { errors } = await load(
				withChild({ "field.string": { name: "s", children: [{ "attr.string": "a note" }] } }),
				opts,
			);
			const codes = errors.map((e) => (e as { code?: string }).code);
			expect(codes).toContain("ERR_CHILD_NOT_OBJECT");
			expect(codes).not.toContain("ERR_MISSING_REQUIRED_ATTR");
		});

		// The key is judged BEFORE the body. `$comment` is not a node, so telling the author
		// to give it a node body would send them to wrap prose that was never a node.
		test(`${mode}: an unknown key with a non-object body is an unknown TYPE`, async () => {
			const { errors } = await load(withChild({ $comment: "prose" }), opts);
			const codes = errors.map((e) => (e as { code?: string }).code);
			expect(codes).toContain("ERR_UNKNOWN_TYPE");
			expect(codes).not.toContain("ERR_CHILD_NOT_OBJECT");
		});
	}

	test("the refused child is not in the tree, and the valid siblings are", async () => {
		const { root } = await load(withChild({ "field.string": "label" }));
		const entity = root.children().find((c) => c.name === "A");
		expect(entity).toBeDefined();
		const fieldNames = entity!.children().map((c) => c.name);
		expect(fieldNames).toContain("id");
		expect(fieldNames).not.toContain("label");
	});
});

describe("an unregistered bare child key is an unknown type", () => {
	for (const [mode, opts] of MODES) {
		// The root door has carried the registration-first guard since FR5a; the child door
		// did not, so `madeup` was answered with "write the full `madeup.<subType>`" — advice
		// about a type that does not exist. One rule, two doors.
		test(`${mode}: reports ERR_UNKNOWN_TYPE, not ERR_MISSING_SUBTYPE`, async () => {
			const { errors } = await load(withChild({ madeup: { name: "label" } }), opts);
			const codes = errors.map((e) => (e as { code?: string }).code);
			expect(codes).toContain("ERR_UNKNOWN_TYPE");
			expect(codes).not.toContain("ERR_MISSING_SUBTYPE");
		});
	}

	// The control the guard must not swallow: `identity` IS registered and declares no
	// default subtype, so it keeps ERR_MISSING_SUBTYPE — that advice is correct for it.
	test("a REGISTERED type with no declared default still reports ERR_MISSING_SUBTYPE", async () => {
		const { errors } = await load(withChild({ identity: { name: "alt" } }));
		const codes = errors.map((e) => (e as { code?: string }).code);
		expect(codes).toContain("ERR_MISSING_SUBTYPE");
		expect(codes).not.toContain("ERR_UNKNOWN_TYPE");
	});

	test("the error names the type without a trailing dot", async () => {
		const { errors } = await load(withChild({ madeup: { name: "label" } }));
		const unknown = errors.find((e) => (e as { code?: string }).code === "ERR_UNKNOWN_TYPE");
		expect(unknown!.message).toContain('"madeup"');
		expect(unknown!.message).not.toContain('"madeup."');
	});
});

// Conformance GATE for the linked-template-source-docs feature (Task 5).
//
// The feature (Tasks 1-4): the `meta docs` template.output page embeds the
// template source with every `{{variable}}` linked to `./<OwnerVO>.md#field-<name>`,
// and each entity/VO page emits a literal `<a id="field-<name>"></a>` anchor.
// A link is only useful if its TARGET PAGE exists AND carries the anchor it
// points at. This gate proves that on the REAL `docsFile` output — it does NOT
// re-assert the builder against itself; it parses the emitted template pages'
// links + the emitted entity pages' anchors and cross-checks them.
//
// Three guarantees:
//   1. Cross-doc link integrity (headline): every `{{variable}}` link the
//      template page emits (Markdown table link AND the rich-view <a href>)
//      targets a page that IS emitted in the run and that CONTAINS a matching
//      id="field-<name>" anchor. A dangling page / missing anchor → FAIL.
//   2. Annotator ⇆ verify agreement (on real output): the set of variables the
//      template page documents as LINKED equals the set render verify() does NOT
//      flag ERR_VAR_NOT_ON_PAYLOAD, for the same resolved source + payload tree.
//   3. Teeth: the integrity check genuinely FAILS on a missing anchor, and the
//      annotator+verify genuinely DISagree-free-set rejects an off-payload var
//      (both mark it unlinked / flagged).
//
// The fixture has a document + an email template.output whose mustache
// references payload-VO fields PLUS a nested `@objectRef` section, so at least
// one link points at a DIFFERENT VO's page (Order → Customer) — the cross-VO
// case is part of the integrity sweep.

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { dirname, posix as posixPath } from "node:path";
import { InMemoryStringSource, MetaDataLoader } from "@metaobjectsdev/metadata";
import {
	ERR_VAR_NOT_ON_PAYLOAD,
	type PayloadField,
	verify,
} from "@metaobjectsdev/render";
import type { GenContext } from "../../src/generator.js";
import {
	docPageHref,
	docPageNode,
	docPageOutputPath,
} from "../../src/docs-paths.js";
import { docsFile } from "../../src/generators/docs-file.js";
import type { OutputLayout } from "../../src/import-path.js";
import { buildEnrichedPayloadTree } from "../../src/generators/template-payload-tree.js";
import {
	type AnnotatePayloadField,
	annotateTemplate,
	type TplToken,
} from "../../src/generators/template-source-annotate.js";
import { buildPkMap } from "../../src/pk-resolver.js";
import { buildRelationMap } from "../../src/relation-resolver.js";
import { makeRenderContext } from "../../src/render-context.js";
import { projectProvider } from "../../src/render-engine/framework-provider.js";

const CORPUS = resolve(import.meta.dir, "../fixtures/docs-conformance");
const FIXTURE = "template-source-conformance";
// Multi-package mirror of FIXTURE: the payload VOs live in `acme::shop`, the
// two template.output nodes in `acme::comms`. Under package layout the doc
// pages are written under their package dirs, so a template page links a field
// on a VO in a DIFFERENT directory — the cross-package href case.
const FIXTURE_PACKAGE = "template-source-conformance-package";

interface Emitted {
	path: string;
	content: string;
}

// `outputLayout` defaults to "flat" so the existing flat cases are unchanged.
// We thread it the SAME way the real `meta docs` command does (cli/docs.ts):
// onto `config.outputLayout` (where the generator reads placement from) AND
// into `makeRenderContext` — so this test exercises the exact production path.
function makeCtx(
	root: Awaited<ReturnType<MetaDataLoader["load"]>>["root"],
	projectRoot: string,
	outputLayout: OutputLayout = "flat",
): GenContext {
	const renderContext = makeRenderContext({
		dialect: "sqlite",
		loadedRoot: root,
		outDir: "/tmp",
		dbImport: "~/db",
		pkMap: buildPkMap(root),
		relationMap: buildRelationMap(root),
		outputLayout,
	});
	return {
		entities: root.objects(),
		loadedRoot: root,
		matches: () => true,
		config: {
			outDir: "/tmp",
			extStyle: "none",
			dbImport: "~/db",
			dialect: "sqlite",
			outputLayout,
		} as never,
		renderContext,
		warn: () => {},
		projectRoot,
	};
}

async function loadFixture(fixture: string = FIXTURE) {
	const inputDir = join(CORPUS, fixture, "input");
	const inputFiles = readdirSync(inputDir).filter((f) => f.endsWith(".json"));
	const sources = inputFiles.map(
		(f) =>
			new InMemoryStringSource(readFileSync(join(inputDir, f), "utf-8"), {
				id: f,
				format: "json",
			}),
	);
	const res = await new MetaDataLoader().load(sources);
	expect(res.errors, "fixture load errors").toEqual([]);
	return { root: res.root, inputDir };
}

async function emit(
	fixture: string = FIXTURE,
	outputLayout: OutputLayout = "flat",
): Promise<Emitted[]> {
	const { root, inputDir } = await loadFixture(fixture);
	return (await docsFile().generate(
		makeCtx(root, inputDir, outputLayout),
	)) as Emitted[];
}

// ── Link parsing (precise — no false-accept) ─────────────────────────────────

/** A field-doc link parsed off a template page: the target page + the anchor it
 *  points at, plus the surface (markdown link vs rich-view <a href>) for diag. */
interface FieldLink {
	page: string; // e.g. "Order.md"
	anchor: string; // e.g. "field-name"
	surface: "md" | "href";
	raw: string;
}

// A field-doc link looks like `./<Page>.md#field-<name>`. We accept ONLY the
// `#field-` fragment form (the per-field anchor convention) so plain page links
// (Payload/Used-by, no fragment) are not mistaken for field links. Captures the
// page filename and the full anchor slug.
const MD_LINK = /\[[^\]]*\]\(\.\/([^)#]+\.md)#(field-[A-Za-z0-9_]+)\)/g;
const HREF_LINK = /href="\.\/([^"#]+\.md)#(field-[A-Za-z0-9_]+)"/g;

function parseFieldLinks(content: string): FieldLink[] {
	const out: FieldLink[] = [];
	for (const m of content.matchAll(MD_LINK)) {
		out.push({ page: m[1]!, anchor: m[2]!, surface: "md", raw: m[0]! });
	}
	for (const m of content.matchAll(HREF_LINK)) {
		out.push({ page: m[1]!, anchor: m[2]!, surface: "href", raw: m[0]! });
	}
	return out;
}

// ── Anchor index off the EMITTED pages ───────────────────────────────────────

/** Map page filename → set of anchor slugs (`id="field-…"`) it actually emits. */
function buildAnchorIndex(files: Emitted[]): Map<string, Set<string>> {
	const idx = new Map<string, Set<string>>();
	const ID = /id="(field-[A-Za-z0-9_]+)"/g;
	for (const f of files) {
		const set = new Set<string>();
		for (const m of f.content.matchAll(ID)) set.add(m[1]!);
		idx.set(f.path, set);
	}
	return idx;
}

/** Cross-check every field link against the emitted page index. Returns the list
 *  of BROKEN links (missing page or missing anchor) — empty means sound. Pure
 *  over (links, index) so the teeth tests can run it against a synthetic set. */
function findBrokenLinks(
	links: FieldLink[],
	index: Map<string, Set<string>>,
): { link: FieldLink; reason: "no-page" | "no-anchor" }[] {
	const broken: { link: FieldLink; reason: "no-page" | "no-anchor" }[] = [];
	for (const link of links) {
		const anchors = index.get(link.page);
		if (anchors === undefined) {
			broken.push({ link, reason: "no-page" });
		} else if (!anchors.has(link.anchor)) {
			broken.push({ link, reason: "no-anchor" });
		}
	}
	return broken;
}

// The template pages are the two `template.output` artifacts (NOT entity pages,
// NOT README). They carry the `{{variable}}` field links.
const TEMPLATE_PAGES = new Set(["OrderPage.md", "OrderEmail.md"]);

// ── 1. Cross-doc link integrity (headline) ───────────────────────────────────

describe("template-source link integrity — every {{var}} link resolves to a real page + anchor", () => {
	it("emits the expected page set (entities, VOs, both template pages)", async () => {
		const files = await emit();
		const paths = new Set(files.map((f) => f.path));
		for (const p of [
			"Order.md",
			"Customer.md",
			"OrderPage.md",
			"OrderEmail.md",
			"README.md",
		]) {
			expect(paths.has(p), `missing emitted page ${p}`).toBe(true);
		}
	});

	it("every field link on every template page targets an emitted page AND a matching anchor", async () => {
		const files = await emit();
		const index = buildAnchorIndex(files);

		let totalLinks = 0;
		const allBroken: { page: string; link: FieldLink; reason: string }[] = [];
		for (const f of files) {
			if (!TEMPLATE_PAGES.has(f.path)) continue;
			const links = parseFieldLinks(f.content);
			// Each template page that documents variables MUST carry links (both
			// surfaces: the markdown table + the rich <a href> view).
			expect(links.length, `${f.path}: no field links parsed`).toBeGreaterThan(
				0,
			);
			expect(
				links.some((l) => l.surface === "md"),
				`${f.path}: no markdown-table field link`,
			).toBe(true);
			expect(
				links.some((l) => l.surface === "href"),
				`${f.path}: no rich-view <a href> field link`,
			).toBe(true);
			totalLinks += links.length;
			for (const b of findBrokenLinks(links, index)) {
				allBroken.push({ page: f.path, link: b.link, reason: b.reason });
			}
		}

		expect(
			totalLinks,
			"no field links found across template pages",
		).toBeGreaterThan(0);
		expect(
			allBroken,
			`broken field links: ${JSON.stringify(
				allBroken.map((b) => `${b.page}: ${b.link.raw} (${b.reason})`),
				null,
				2,
			)}`,
		).toEqual([]);
	});

	it("the CROSS-VO link (Order template → Customer.md) resolves to a real anchor", async () => {
		const files = await emit();
		const index = buildAnchorIndex(files);
		const orderPage = files.find((f) => f.path === "OrderPage.md")!;
		const links = parseFieldLinks(orderPage.content);

		// At least one link must point at a DIFFERENT VO's page than Order.md.
		const crossVo = links.filter((l) => l.page === "Customer.md");
		expect(
			crossVo.length,
			"expected a cross-VO link to Customer.md",
		).toBeGreaterThan(0);
		// And it must land on a real anchor on Customer.md.
		expect(findBrokenLinks(crossVo, index)).toEqual([]);
		expect(index.get("Customer.md")!.has("field-name")).toBe(true);
	});
});

// ── 2. Annotator ⇆ verify agreement (on real resolved sources) ───────────────

// Strip the enriched tree down to verify's PLAIN PayloadField[] so verify walks
// the same shape the build-time drift gate gets.
function toPlainTree(tree: AnnotatePayloadField[]): PayloadField[] {
	return tree.map((n) => {
		const node: PayloadField = { name: n.name };
		if (n.fields !== undefined) node.fields = toPlainTree(n.fields);
		return node;
	});
}

// The unique variable paths the annotator marked as LINKED (valid + resolved to
// a field). Sections that resolve to a field count too — they carry an href.
function linkedPaths(tokens: TplToken[]): Set<string> {
	const out = new Set<string>();
	for (const t of tokens) {
		if (t.kind === "var" || t.kind === "unescaped") {
			if (t.valid && t.field !== undefined && t.path !== ".") out.add(t.path);
		} else if (t.kind === "section" || t.kind === "inverted") {
			if (t.field !== undefined && t.path !== ".") out.add(t.path);
		}
	}
	return out;
}

// Variables verify did NOT flag as off-payload (i.e. the ones it accepts). We
// derive this from the parsed token paths minus the verify-flagged set, so it is
// the complement over the SAME variable universe.
function allVarPaths(tokens: TplToken[]): Set<string> {
	const out = new Set<string>();
	for (const t of tokens) {
		if (
			(t.kind === "var" ||
				t.kind === "unescaped" ||
				t.kind === "section" ||
				t.kind === "inverted") &&
			t.path !== "."
		) {
			out.add(t.path);
		}
	}
	return out;
}

describe("annotator ⇆ verify agreement — linked set equals verify's accepted set", () => {
	it("for each resolved template source: linked variables == NOT-flagged variables", async () => {
		const { root, inputDir } = await loadFixture();
		const provider = projectProvider(inputDir);
		const tree = buildEnrichedPayloadTree(root, "Order");
		const plain = toPlainTree(tree);

		// Every mustache source the two templates reference.
		const refs = [
			"site/order",
			"email/order.subject",
			"email/order.html",
			"email/order.text",
		];
		let checked = 0;
		for (const ref of refs) {
			const source = provider.resolve(ref);
			expect(source, `provider could not resolve ${ref}`).toBeDefined();

			const tokens = annotateTemplate(source!, tree, { ownerVoName: "Order" });
			const linked = linkedPaths(tokens);
			const all = allVarPaths(tokens);

			// verify over the SAME source + plain tree.
			const flagged = new Set(
				verify(source!, plain)
					.filter((e) => e.code === ERR_VAR_NOT_ON_PAYLOAD)
					.map((e) => e.path),
			);
			const accepted = new Set([...all].filter((p) => !flagged.has(p)));

			// The doc cannot claim a link verify would reject, and cannot drop a valid
			// variable: the two sets are identical.
			expect([...linked].sort(), `${ref}: linked != accepted`).toEqual(
				[...accepted].sort(),
			);
			checked++;
		}
		expect(checked).toBe(refs.length);
	});
});

// ── 3. Teeth — prove the gate catches drift ──────────────────────────────────

describe("teeth — the integrity check fails on real drift", () => {
	it("a renamed field (anchor removed from the entity page) is reported broken", async () => {
		const files = await emit();
		// Simulate a renamed/removed field: strip the `field-name` anchor from
		// Customer.md (the cross-VO target). The link on the template page still
		// points at #field-name — now dangling.
		const drifted = files.map((f) =>
			f.path === "Customer.md"
				? { ...f, content: f.content.replace(/<a id="field-name"><\/a>/g, "") }
				: f,
		);
		const index = buildAnchorIndex(drifted);
		const orderPage = drifted.find((f) => f.path === "OrderPage.md")!;
		const broken = findBrokenLinks(parseFieldLinks(orderPage.content), index);

		// The gate MUST report the now-missing anchor (not silently accept it).
		expect(broken.length, "drift not detected").toBeGreaterThan(0);
		expect(broken.every((b) => b.reason === "no-anchor")).toBe(true);
		expect(broken.some((b) => b.link.anchor === "field-name")).toBe(true);
	});

	it("a link to a non-existent page is reported broken", async () => {
		// A fabricated link targeting a page the run never emitted.
		const phantom: FieldLink[] = [
			{
				page: "DoesNotExist.md",
				anchor: "field-ghost",
				surface: "md",
				raw: "[x](./DoesNotExist.md#field-ghost)",
			},
		];
		const files = await emit();
		const broken = findBrokenLinks(phantom, buildAnchorIndex(files));
		expect(broken).toHaveLength(1);
		expect(broken[0]!.reason).toBe("no-page");
	});

	it("an OFF-PAYLOAD variable is both UNLINKED (annotator) and FLAGGED (verify) — they agree", () => {
		// A template referencing a variable not on the payload.
		const source = "<p>{{ref}} / {{ghost}}</p>";
		const tree: AnnotatePayloadField[] = [
			{ name: "ref", owner: "Order", type: "string", required: false },
		];
		const plain = toPlainTree(tree);

		const tokens = annotateTemplate(source, tree, { ownerVoName: "Order" });
		const linked = linkedPaths(tokens);
		const flagged = new Set(
			verify(source, plain)
				.filter((e) => e.code === ERR_VAR_NOT_ON_PAYLOAD)
				.map((e) => e.path),
		);

		// Annotator: `ghost` is NOT linked; `ref` is.
		expect(linked.has("ref")).toBe(true);
		expect(linked.has("ghost")).toBe(false);
		// verify: `ghost` flagged off-payload; `ref` not.
		expect(flagged.has("ghost")).toBe(true);
		expect(flagged.has("ref")).toBe(false);
		// Agreement: the unlinked var is exactly the flagged var.
		const unlinked = new Set(
			[...allVarPaths(tokens)].filter((p) => !linked.has(p)),
		);
		expect([...unlinked].sort()).toEqual([...flagged].sort());
	});
});

// ── 4. Package layout — field links resolve cross-package ─────────────────────
//
// Under `outputLayout: "package"` the doc pages are written under their package
// dirs (`acme/shop/Order.md`, `acme/comms/OrderPage.md`). A template page in
// `acme/comms/` linking a field on a VO in `acme/shop/` MUST emit a relative
// href that, resolved against the template page's OWN output path, lands on the
// VO's REAL emitted page (`../shop/Order.md#field-ref`) — NOT a bare
// `./Order.md` (which from `acme/comms/` points at the wrong directory). The
// sibling "Payload" link already does this via docPageHref; the per-`{{var}}`
// field links must match. `docPageOutputPath`/`docPageHref` are the source of
// truth for expected placement.

// Parse field-doc links allowing BOTH `./` and `../` relative forms (package
// layout yields `../shop/Order.md#field-…`). Captures the FULL relative href
// (path + fragment) plus the page filename + anchor, on both surfaces.
const PKG_MD_LINK =
	/\[[^\]]*\]\((\.\.?\/[^)#]*?([^/)#]+\.md)#(field-[A-Za-z0-9_]+))\)/g;
const PKG_HREF_LINK =
	/href="(\.\.?\/[^"#]*?([^/"#]+\.md)#(field-[A-Za-z0-9_]+))"/g;

interface PkgFieldLink {
	href: string; // full relative href incl. fragment, e.g. ../shop/Order.md#field-ref
	page: string; // target page filename, e.g. Order.md
	anchor: string; // e.g. field-ref
	surface: "md" | "href";
}

function parsePkgFieldLinks(content: string): PkgFieldLink[] {
	const out: PkgFieldLink[] = [];
	for (const m of content.matchAll(PKG_MD_LINK)) {
		out.push({ href: m[1]!, page: m[2]!, anchor: m[3]!, surface: "md" });
	}
	for (const m of content.matchAll(PKG_HREF_LINK)) {
		out.push({ href: m[1]!, page: m[2]!, anchor: m[3]!, surface: "href" });
	}
	return out;
}

describe("package layout — field links resolve cross-package", () => {
	it("every {{var}} field link on a template page resolves to the field-owner's REAL package-layout page", async () => {
		const layout: OutputLayout = "package";
		const { root, inputDir } = await loadFixture(FIXTURE_PACKAGE);
		const files = (await docsFile().generate(
			makeCtx(root, inputDir, layout),
		)) as Emitted[];
		const emittedPaths = new Set(files.map((f) => f.path));

		// Sanity: pages ARE folded under their package dirs.
		for (const p of [
			"acme/shop/Order.md",
			"acme/shop/Customer.md",
			"acme/comms/OrderPage.md",
			"acme/comms/OrderEmail.md",
		]) {
			expect(emittedPaths.has(p), `missing package-layout page ${p}`).toBe(
				true,
			);
		}

		// Index: page output path → set of field anchors it emits.
		const anchorByPath = new Map<string, Set<string>>();
		const ID = /id="(field-[A-Za-z0-9_]+)"/g;
		for (const f of files) {
			const set = new Set<string>();
			for (const m of f.content.matchAll(ID)) set.add(m[1]!);
			anchorByPath.set(f.path, set);
		}

		const templatePages = files.filter((f) =>
			f.path.startsWith("acme/comms/"),
		);
		expect(templatePages.length, "no template pages emitted").toBe(2);

		let checked = 0;
		for (const page of templatePages) {
			// The template node that produced this page (carries its package, so its
			// placement folds under `acme/comms/`). Looked up off the root's own
			// children (templates aren't `findObject`-able).
			const templateName = page.path.split("/").pop()!.replace(/\.md$/, "");
			const templateNode = root
				.ownChildren()
				.find((c) => c.name === templateName);
			expect(
				templateNode,
				`could not find template node for ${page.path}`,
			).toBeDefined();
			const fromNode = docPageNode(templateNode!);
			// The from-node MUST place under the template's own dir.
			expect(docPageOutputPath(layout, fromNode)).toBe(page.path);

			const links = parsePkgFieldLinks(page.content);
			// Each template page must carry field links on BOTH surfaces.
			expect(
				links.length,
				`${page.path}: no field links parsed (page content may use a bare ./<Owner>.md href the package-aware regex rejects — that IS the bug)`,
			).toBeGreaterThan(0);

			for (const link of links) {
				// The owner VO is the target page's short name (Order.md → Order).
				const ownerName = link.page.replace(/\.md$/, "");
				const ownerObj = root.findObject(ownerName);
				expect(
					ownerObj,
					`${page.path}: link target ${link.page} is not a known VO`,
				).toBeDefined();

				// Source of truth for WHERE the owner page is + WHAT href should point
				// at it from this template page (`fromNode` computed above).
				const toNode = docPageNode(ownerObj!);
				const expectedOwnerPath = docPageOutputPath(layout, toNode);
				const expectedHref = `${docPageHref(layout, fromNode, toNode)}#${link.anchor}`;

				// (a) The href must NOT be a bare `./<Owner>.md…` — under package layout
				// it must carry the owner's package dir relative to the template page.
				expect(
					link.href.startsWith(`./${link.page}#`),
					`${page.path}: field link ${link.href} is a bare ./${link.page} — ignores package layout (owner page is ${expectedOwnerPath})`,
				).toBe(false);

				// (b) The href must equal what docPageHref derives (the same helper the
				// Payload link already uses) for this from→to pair.
				expect(
					link.href,
					`${page.path}: field link ${link.href} != expected ${expectedHref}`,
				).toBe(expectedHref);

				// (c) Resolving the href against the template page's own dir must land
				// on the owner's ACTUAL emitted page path.
				const resolved = posixPath.normalize(
					posixPath.join(dirname(page.path), link.href.split("#")[0]!),
				);
				expect(
					resolved,
					`${page.path}: field link ${link.href} resolves to ${resolved}, not the emitted owner page ${expectedOwnerPath}`,
				).toBe(expectedOwnerPath);

				// (d) That resolved page is in the emitted set AND carries the anchor.
				expect(
					emittedPaths.has(resolved),
					`${page.path}: resolved target ${resolved} is not an emitted page`,
				).toBe(true);
				expect(
					anchorByPath.get(resolved)?.has(link.anchor),
					`${page.path}: ${resolved} is missing anchor ${link.anchor}`,
				).toBe(true);

				checked++;
			}
		}
		expect(checked, "no cross-package field links checked").toBeGreaterThan(0);
	});
});

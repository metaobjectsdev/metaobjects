// Conformance GATE for the unified-docs-door cross-links (Task 5).
//
// The unified `meta docs` emits BOTH surfaces under one outDir: the model
// surface (`<Entity>.md` / `<Template>.md` + `README.md`) and the api surface
// (`api/<Entity>.md` + `api/README.md` + `api/AGENT-API.md`). Task 4 cross-links
// them: each model entity page links to its api page; each api entity page links
// back to its model page; the model index gets an `## API reference` link to the
// api index. A cross-link is only useful if its TARGET PAGE is actually emitted.
//
// This gate emits both surfaces exactly as cli/docs.ts does (with the
// sibling-surface opts), then proves every model↔api crossing resolves to a
// real emitted page — in BOTH flat and package layouts. It also asserts the run
// actually produced cross-links (no silent no-op), and a separate unit proves
// the broken-link finder has teeth.

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { posix as posixPath } from "node:path";
import { InMemoryStringSource, MetaDataLoader } from "@metaobjectsdev/metadata";
import type { GenContext } from "../../src/generator.js";
import { docsFile } from "../../src/generators/docs-file.js";
import { apiDocsFile } from "../../src/generators/api-docs-file.js";
import type { OutputLayout } from "../../src/import-path.js";
import { buildPkMap } from "../../src/pk-resolver.js";
import { buildRelationMap } from "../../src/relation-resolver.js";
import { makeRenderContext } from "../../src/render-context.js";

const CORPUS = resolve(import.meta.dir, "../../../../../../fixtures/conformance");
const FIXTURE = "template-source-conformance";
const FIXTURE_PACKAGE = "template-source-conformance-package";

interface Emitted {
	path: string;
	content: string;
}

function makeCtx(
	root: Awaited<ReturnType<MetaDataLoader["load"]>>["root"],
	projectRoot: string,
	outputLayout: OutputLayout,
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

async function loadFixture(fixture: string) {
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

/** Emit BOTH surfaces the way cli/docs.ts does when both are requested. */
async function emitBoth(fixture: string, layout: OutputLayout): Promise<Emitted[]> {
	const { root, inputDir } = await loadFixture(fixture);
	const ctx = makeCtx(root, inputDir, layout);
	const model = (await docsFile({ apiSurface: { subDir: "api" } }).generate(
		ctx,
	)) as Emitted[];
	const api = (await apiDocsFile({
		subDir: "api",
		modelSurface: true,
	}).generate(ctx)) as Emitted[];
	return [...model, ...api];
}

// ── Cross-link finder (pure — unit-testable for teeth) ───────────────────────

const isApi = (p: string): boolean => p.startsWith("api/");
// Any markdown link target ending in `.md` (optionally with an #anchor).
const MD_LINK = /\]\(([^)\s]+\.md(?:#[^)\s]*)?)\)/g;

interface CrossLink {
	from: string;
	href: string;
	resolved: string;
}

/** Resolve every `.md` markdown link in each file against the file's own dir,
 *  keep only the model↔api CROSSINGS (file's surface differs from the target's),
 *  and return those whose resolved path is NOT in `present`. Same-surface links
 *  (model→model field anchors, api→api index links) are ignored — they have
 *  their own gates. */
export function findBrokenCrossLinks(
	files: Emitted[],
	present: Set<string>,
): CrossLink[] {
	const broken: CrossLink[] = [];
	for (const f of files) {
		for (const m of f.content.matchAll(MD_LINK)) {
			const href = m[1]!;
			const noAnchor = href.split("#")[0]!;
			const resolved = posixPath.normalize(
				posixPath.join(posixPath.dirname(f.path), noAnchor),
			);
			if (isApi(f.path) === isApi(resolved)) continue; // same surface → skip
			if (!present.has(resolved)) broken.push({ from: f.path, href, resolved });
		}
	}
	return broken;
}

/** All model↔api crossings (resolved), for the no-op guard counts. */
function crossLinks(files: Emitted[]): CrossLink[] {
	const out: CrossLink[] = [];
	for (const f of files) {
		for (const m of f.content.matchAll(MD_LINK)) {
			const href = m[1]!;
			const resolved = posixPath.normalize(
				posixPath.join(posixPath.dirname(f.path), href.split("#")[0]!),
			);
			if (isApi(f.path) !== isApi(resolved)) out.push({ from: f.path, href, resolved });
		}
	}
	return out;
}

describe("unified-docs-door cross-link integrity", () => {
	for (const [label, fixture, layout] of [
		["flat", FIXTURE, "flat"],
		["package", FIXTURE_PACKAGE, "package"],
	] as const) {
		it(`every model↔api cross-link resolves to a real emitted page (${label})`, async () => {
			const files = await emitBoth(fixture, layout);
			const present = new Set(files.map((f) => f.path));

			const broken = findBrokenCrossLinks(files, present);
			expect(broken, `broken cross-links (${label})`).toEqual([]);

			// No silent no-op: the run must have produced cross-links in both
			// directions plus the index→api link.
			const cross = crossLinks(files);
			const modelEntityToApi = cross.filter(
				(l) => !isApi(l.from) && l.from !== "README.md" && isApi(l.resolved),
			);
			const apiToModel = cross.filter((l) => isApi(l.from) && !isApi(l.resolved));
			const indexToApi = cross.some(
				(l) => l.from === "README.md" && l.resolved === "api/README.md",
			);
			expect(modelEntityToApi.length, `model→api links (${label})`).toBeGreaterThan(0);
			expect(apiToModel.length, `api→model links (${label})`).toBeGreaterThan(0);
			expect(indexToApi, `index→api link (${label})`).toBe(true);
		});
	}

	it("findBrokenCrossLinks has teeth (flags a missing cross-target)", () => {
		const files: Emitted[] = [
			{ path: "Order.md", content: "**API reference:** [generated SDK for Order](./api/Order.md)\n" },
			{ path: "api/Order.md", content: "**Model / metadata:** [Order](../Order.md)\n" },
		];
		// Only the model page is "present"; the api page target is missing.
		const present = new Set(["Order.md"]);
		const broken = findBrokenCrossLinks(files, present);
		expect(broken).toEqual([
			{ from: "Order.md", href: "./api/Order.md", resolved: "api/Order.md" },
		]);
	});
});

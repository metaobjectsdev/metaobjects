// Cross-port api-docs LAYOUT CONTRACT — TS half (the oracle).
//
// This is the registry-conformance idiom applied to the api-docs page layout:
// a SHARED fixture (repo-root `fixtures/conformance/api-docs-cross-port/`) and a
// committed manifest (`expected-paths.json`) that BOTH the TS and the Java
// api-docs conformance tests assert against. The manifest is the single source
// of truth for where each documented unit's pages land and how the model surface
// and the api surfaces cross-link — in PACKAGE layout, so `acme::shop` folds to
// `acme/shop/...` and the api→model `..` math (4 levels up) is exercised.
//
// The manifest is DERIVED FROM THE REAL TS EMIT (this port is the oracle). It is
// generated once via `UPDATE_CONTRACT=1 bun test <this file>` (a golden-update
// flag), inspected, and committed. On a normal run the test ASSERTS the live
// emit against the committed file — the committed manifest is the contract Java
// will also assert against, so its values are the real, math-correct paths/hrefs.

import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, posix as posixPath } from "node:path";
import { InMemoryStringSource, MetaDataLoader } from "@metaobjectsdev/metadata";
import type { GenContext } from "../../src/generator.js";
import { apiDocsFile } from "../../src/generators/api-docs-file.js";
import { docsFile } from "../../src/generators/docs-file.js";
import type { OutputLayout } from "../../src/import-path.js";
import { buildPkMap } from "../../src/pk-resolver.js";
import { buildRelationMap } from "../../src/relation-resolver.js";
import { makeRenderContext } from "../../src/render-context.js";

// Walk UP from this test file's dir until we find a dir containing BOTH
// fixtures/ and server/ — that's the repo root (same strategy as
// generator-registry-conformance.test.ts). No hardcoded absolute paths.
function findRepoRoot(start: string): string {
	let dir = start;
	while (true) {
		if (existsSync(join(dir, "fixtures")) && existsSync(join(dir, "server"))) {
			return dir;
		}
		const parent = dirname(dir);
		if (parent === dir) {
			throw new Error(
				"Could not locate repo root (dir containing fixtures/ and server/)",
			);
		}
		dir = parent;
	}
}

const repoRoot = findRepoRoot(import.meta.dir);
const fixtureDir = join(
	repoRoot,
	"fixtures",
	"conformance",
	"api-docs-cross-port",
);
const inputDir = join(fixtureDir, "input");
const manifestPath = join(fixtureDir, "expected-paths.json");

const LAYOUT: OutputLayout = "package";
const API_TS_SUBDIR = "api/ts";
const API_JAVA_SUBDIR = "api/java";

interface Emitted {
	path: string;
	content: string;
}

interface ManifestUnit {
	node: string;
	modelPath: string;
	apiTsPath: string;
	apiJavaPath: string;
	modelToApiTs: string;
	modelToApiJava: string;
	apiTsToModel: string;
	apiJavaToModel: string;
}

interface Manifest {
	$comment: string;
	layout: string;
	apiTsSubDir: string;
	apiJavaSubDir: string;
	units: ManifestUnit[];
}

function makeCtx(
	root: Awaited<ReturnType<MetaDataLoader["load"]>>["root"],
	projectRoot: string,
): GenContext {
	const renderContext = makeRenderContext({
		dialect: "sqlite",
		loadedRoot: root,
		outDir: "/tmp",
		dbImport: "~/db",
		pkMap: buildPkMap(root),
		relationMap: buildRelationMap(root),
		outputLayout: LAYOUT,
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
			outputLayout: LAYOUT,
		} as never,
		renderContext,
		warn: () => {},
		projectRoot,
	};
}

async function loadFixture() {
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
	return res.root;
}

const TWO_SURFACES = [
	{ label: "TypeScript", subDir: API_TS_SUBDIR },
	{ label: "Java", subDir: API_JAVA_SUBDIR },
];

/** Emit the model surface + the api/ts surface (PACKAGE layout). The model page
 *  DECLARES both api surfaces (TS + Java) so it links each, even though only the
 *  api/ts files are physically emitted. */
async function emit(): Promise<Emitted[]> {
	const root = await loadFixture();
	const ctx = makeCtx(root, inputDir);
	const model = (await docsFile({ apiSurfaces: TWO_SURFACES }).generate(
		ctx,
	)) as Emitted[];
	const tsApi = (await apiDocsFile({
		subDir: API_TS_SUBDIR,
		modelSurface: true,
	}).generate(ctx)) as Emitted[];
	return [...model, ...tsApi];
}

// ── Link extraction (parse `[label](href)` lines) ────────────────────────────

const MD_LINK_LABELLED = (label: string): RegExp =>
	new RegExp(`\\[${label}\\]\\(([^)\\s]+)\\)`);

/** From a model entity page, pull the api/ts + api/java hrefs out of the
 *  `**API reference:** [TypeScript](..) · [Java](..)` line. */
function modelApiRefs(content: string): { ts?: string; java?: string } {
	const ts = content.match(MD_LINK_LABELLED("TypeScript"));
	const java = content.match(MD_LINK_LABELLED("Java"));
	return { ts: ts?.[1], java: java?.[1] };
}

/** From an api page, pull the model back-link out of the
 *  `**Model / metadata:** [<node>](..)` line. */
function apiModelRef(content: string, node: string): string | undefined {
	return content.match(MD_LINK_LABELLED(node))?.[1];
}

// ── Build the manifest from the real emit (oracle) ───────────────────────────

/** Resolve a relative href against the FROM file's directory (posix). */
function resolveHref(fromPath: string, href: string): string {
	return posixPath.normalize(posixPath.join(posixPath.dirname(fromPath), href));
}

async function buildManifest(): Promise<Manifest> {
	const files = await emit();
	const byPath = new Map(files.map((f) => [f.path, f]));

	// Every api/ts per-unit page (excludes README / AGENT-API) names a documented
	// unit. The page path is `api/ts/<pkgPath>/<Node>.md`.
	const apiTsUnitFiles = files.filter(
		(f) =>
			f.path.startsWith(`${API_TS_SUBDIR}/`) &&
			f.path.endsWith(".md") &&
			!f.path.endsWith("/README.md") &&
			!f.path.endsWith("/AGENT-API.md"),
	);

	const units: ManifestUnit[] = apiTsUnitFiles
		.map((apiTsFile): ManifestUnit => {
			const apiTsPath = apiTsFile.path;
			// Same placement under each surface root (the page placement is
			// surface-agnostic; only the prefix differs).
			const placement = apiTsPath.slice(API_TS_SUBDIR.length + 1);
			const node = placement.slice(
				placement.lastIndexOf("/") + 1,
				-".md".length,
			);
			const modelPath = placement;
			const apiJavaPath = `${API_JAVA_SUBDIR}/${placement}`;

			// model → api hrefs come straight off the model page's apiRefs line, when
			// the model page is an ENTITY page (template model pages carry no apiRefs).
			const modelFile = byPath.get(modelPath);
			const refs = modelFile ? modelApiRefs(modelFile.content) : {};

			// api/ts → model back-link off the api page's `Model / metadata` line.
			const apiTsToModel = apiModelRef(apiTsFile.content, node);

			// api/java → model: TS does not emit api/java, but the math is identical
			// (api/java page sits at the same placement under api/java). Compute it the
			// same way the live api page does: relative path from the api page dir to
			// the model page (which is `<depth> × ..` then the placement).
			const apiJavaToModel = posixPath.relative(
				posixPath.dirname(apiJavaPath),
				modelPath,
			);
			// model → api/java: relative path from the model page dir to the api/java
			// page (the same rule docsFile's apiSurfaceHref uses).
			const modelToApiJava = (() => {
				const rel = posixPath.relative(
					posixPath.dirname(modelPath),
					apiJavaPath,
				);
				return rel.startsWith(".") ? rel : `./${rel}`;
			})();

			return {
				node,
				modelPath,
				apiTsPath,
				apiJavaPath,
				modelToApiTs: refs.ts ?? "",
				modelToApiJava: refs.java ?? modelToApiJava,
				apiTsToModel: apiTsToModel ?? "",
				apiJavaToModel,
			};
		})
		.sort((a, b) => a.node.localeCompare(b.node));

	return {
		$comment:
			"Cross-port api-docs layout contract; TS and Java api-docs conformance both assert against this. Layout: package.",
		layout: LAYOUT,
		apiTsSubDir: API_TS_SUBDIR,
		apiJavaSubDir: API_JAVA_SUBDIR,
		units,
	};
}

// One-time generation aid: `UPDATE_CONTRACT=1 bun test <this file>` writes the
// manifest from the real emit, to be inspected + committed. Normal runs assert.
if (process.env.UPDATE_CONTRACT === "1") {
	const manifest = await buildManifest();
	writeFileSync(
		manifestPath,
		`${JSON.stringify(manifest, null, 2)}\n`,
		"utf-8",
	);
	// eslint-disable-next-line no-console
	console.log(`wrote ${manifestPath}`);
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as Manifest;

describe("api-docs cross-port layout contract (TS oracle)", () => {
	it("manifest declares package layout + the two api subDirs", () => {
		expect(manifest.layout).toBe(LAYOUT);
		expect(manifest.apiTsSubDir).toBe(API_TS_SUBDIR);
		expect(manifest.apiJavaSubDir).toBe(API_JAVA_SUBDIR);
		expect(manifest.units.length).toBeGreaterThan(0);
	});

	it("the live TS emit matches the committed contract", async () => {
		const live = await buildManifest();
		expect(live.units).toEqual(manifest.units);
	});

	// Per-unit assertions against the COMMITTED manifest (the contract).
	describe("per-unit pages + cross-links exist where the contract says", () => {
		// Emit lazily, once, shared across the per-unit cases.
		let files: Emitted[];
		let byPath: Map<string, Emitted>;

		for (const unit of manifest.units) {
			it(`${unit.node}: pages land + links resolve per contract`, async () => {
				if (files === undefined) {
					files = await emit();
					byPath = new Map(files.map((f) => [f.path, f]));
				}

				// Model page exists at modelPath; api/ts page exists at apiTsPath.
				const modelFile = byPath.get(unit.modelPath);
				const apiTsFile = byPath.get(unit.apiTsPath);
				expect(modelFile, `model page ${unit.modelPath}`).toBeDefined();
				expect(apiTsFile, `api/ts page ${unit.apiTsPath}`).toBeDefined();

				// Entity model pages carry the apiRefs line (template model pages don't).
				const isEntity = unit.modelToApiTs !== "";
				if (isEntity) {
					const refs = modelApiRefs(modelFile!.content);
					expect(refs.ts, `${unit.node} model→api/ts`).toBe(unit.modelToApiTs);
					expect(refs.java, `${unit.node} model→api/java`).toBe(
						unit.modelToApiJava,
					);
				}

				// api/ts page's model back-link == apiTsToModel.
				const back = apiModelRef(apiTsFile!.content, unit.node);
				expect(back, `${unit.node} api/ts→model`).toBe(unit.apiTsToModel);

				// Resolving modelToApiTs from modelPath's dir lands on apiTsPath.
				if (isEntity) {
					expect(
						resolveHref(unit.modelPath, unit.modelToApiTs),
						`${unit.node} model→api/ts resolves to apiTsPath`,
					).toBe(unit.apiTsPath);
				}
				// Resolving apiTsToModel from apiTsPath's dir lands on modelPath.
				expect(
					resolveHref(unit.apiTsPath, unit.apiTsToModel),
					`${unit.node} api/ts→model resolves to modelPath`,
				).toBe(unit.modelPath);
				// And the api/java math is self-consistent too (Java will emit these).
				expect(
					resolveHref(unit.apiJavaPath, unit.apiJavaToModel),
					`${unit.node} api/java→model resolves to modelPath`,
				).toBe(unit.modelPath);
			});
		}
	});
});

// Gate for apiDocsFile()'s `subDir` option (the api-docs output prefix).
//
// The DEFAULT prefix is `docs/api` (byte-identical to the historical `meta gen`
// behaviour + goldens). The upcoming unified `meta docs` command writes under a
// single docs root (`./docs`), so the api surface must be able to emit under a
// bare `api/` prefix instead (avoiding `./docs/docs/api`). This test pins both:
// the default stays `docs/api/`, and `subDir:'api'` moves EVERYTHING under `api/`.
//
// The GenContext is built with the SAME loader pattern as
// test/golden/template-source-conformance.test.ts (load the
// `template-source-conformance` fixture in flat layout, build a real
// GenContext with config.outputLayout), so the api surface emits real pages +
// README + AGENT-API.

import { test, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { InMemoryStringSource, MetaDataLoader } from "@metaobjectsdev/metadata";
import type { GenContext } from "../src/generator.js";
import type { OutputLayout } from "../src/import-path.js";
import { buildPkMap } from "../src/pk-resolver.js";
import { buildRelationMap } from "../src/relation-resolver.js";
import { makeRenderContext } from "../src/render-context.js";
import { apiDocsFile } from "../src/generators/api-docs-file.js";

const CORPUS = resolve(import.meta.dir, "./fixtures/docs-conformance");
const FIXTURE = "template-source-conformance";

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

async function loadCtx(): Promise<GenContext> {
	const inputDir = join(CORPUS, FIXTURE, "input");
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
	return makeCtx(res.root, inputDir, "flat");
}

const ctx = await loadCtx();

test("default subDir keeps docs/api (byte-identical)", async () => {
	const files = await apiDocsFile().generate(ctx);
	expect(files.length).toBeGreaterThan(0);
	expect(files.some((f) => f.path.startsWith("docs/api/"))).toBe(true);
	expect(files.some((f) => f.path === "docs/api/README.md")).toBe(true);
});

test("subDir:'api' emits under api/ only", async () => {
	const files = await apiDocsFile({ subDir: "api" }).generate(ctx);
	expect(files.length).toBeGreaterThan(0);
	expect(files.every((f) => f.path.startsWith("api/"))).toBe(true);
	expect(files.some((f) => f.path === "api/README.md")).toBe(true);
	expect(files.some((f) => f.path.startsWith("docs/api/"))).toBe(false);
});

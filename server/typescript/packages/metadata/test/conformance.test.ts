// Auto-discovering conformance test runner.
//
// Drives the @metaobjectsdev/conformance engine through the TS adapter. Every
// scenario directory under the repo-root corpus (fixtures/conformance/)
// becomes a `lint:` test and a `conformance:` test. Adding a fixture
// directory adds tests automatically — no code change required.
//
// This file lives at typescript/packages/metadata/test/conformance.test.ts.
// The corpus is at the REPO ROOT — four `../` levels up from test/
// (test → metadata → packages → typescript → repo-root).

import { expect, test } from "bun:test";
import { join } from "node:path";
import {
	discoverFixtures,
	isContractOnlyFixture,
	isDocsOnlyFixture,
	lintFixture,
	loadErrorCodes,
	loadLedger,
	runAndClassify,
} from "@metaobjectsdev/conformance";
import { tsAdapter } from "./conformance/adapter.js";

// METAOBJECTS_CONFORMANCE_CORPUS env override lets mutation-testing sandboxes
// (e.g. Stryker) point at the real corpus via absolute path rather than
// resolving four `../` levels up from an instrumented sandbox copy of this file.
const CORPUS =
	process.env.METAOBJECTS_CONFORMANCE_CORPUS ??
	join(import.meta.dir, "../../../../../fixtures/conformance");
const LEDGER = join(import.meta.dir, "../conformance-expected-failures.json");
const ERROR_CODES = await loadErrorCodes(join(CORPUS, "ERROR-CODES.json"));

const fixtures = await discoverFixtures(CORPUS);
const ledger = await loadLedger(LEDGER);

for (const fix of fixtures) {
	// Docs-only fixtures (an `expected/*.md` directory, no strict expectation
	// files) drive the docs-conformance runner only — the strict metadata
	// runner skips them rather than flagging "declares no expectation files".
	if (isDocsOnlyFixture(fix)) continue;
	// Contract-only fixtures (a custom `expected-paths.json`, no strict
	// expectation files) drive a bespoke cross-port runner — the strict metadata
	// runner skips them rather than flagging "declares no expectation files".
	if (isContractOnlyFixture(fix)) continue;

	test(`lint: ${fix.name}`, () => {
		expect(lintFixture(fix, ERROR_CODES)).toEqual([]);
	});
	test(`conformance: ${fix.name}`, async () => {
		const { status, problems } = await runAndClassify(fix, tsAdapter, ledger);
		if (status === "fail" || status === "fixed-but-listed") {
			throw new Error(`${fix.name} [${status}]: ${problems.join("; ")}`);
		}
		expect(["pass", "known-gap"]).toContain(status);
	});
}

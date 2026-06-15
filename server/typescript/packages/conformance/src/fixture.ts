// Fixture discovery — the single-root, multi-expectation-file corpus model.

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * A fixture is "docs-only" when it ships an `expected/` directory of `.md`
 * doc goldens but NONE of the strict metadata expectation files. Such fixtures
 * exist solely to drive the docs-conformance runner (which byte-matches the
 * `.md` files); the strict metadata conformance runner skips them rather than
 * flagging them as "declares no expectation files".
 */
export function isDocsOnlyFixture(fix: Fixture): boolean {
	return (
		fix.hasDocsExpected &&
		!fix.hasExpected &&
		!fix.hasExpectedEffective &&
		!fix.hasExpectedErrors &&
		!fix.hasExpectedWarnings &&
		!fix.hasScript
	);
}

/**
 * A fixture is "contract-only" when it ships a custom layout/contract manifest
 * (`expected-paths.json`) but NONE of the strict metadata expectation files.
 * Such fixtures exist solely to drive a bespoke conformance runner (e.g. the
 * cross-port api-docs layout contract, where the TS and Java api-docs tests both
 * assert against the same `expected-paths.json`); the strict metadata
 * conformance runner skips them rather than flagging "declares no expectation
 * files". The fixture must still load with zero errors — that is asserted by the
 * bespoke runner, not here.
 */
export function isContractOnlyFixture(fix: Fixture): boolean {
	return (
		fix.hasContractManifest &&
		!fix.hasExpected &&
		!fix.hasExpectedEffective &&
		!fix.hasExpectedErrors &&
		!fix.hasExpectedWarnings &&
		!fix.hasScript &&
		!fix.hasDocsExpected
	);
}

// FR-033 S1-field-A: the default provider set for a fixture with no providers.json
// is the FULL core bundle (core types + the four concern providers), NOT
// core-types alone. The field's filter/sort/teaching/extract/storage attrs were
// re-homed out of core-types into the db/ui/prompt concern providers, so a fixture
// exercising @filterable/@storage/@example/@normalize/... needs those providers
// composed, which keeps the cross-port corpus's no-providers.json fixtures green.
// (The non-TS ports reconcile their fixture-default provider sets in S5.)
const DEFAULT_PROVIDERS = [
	"metaobjects-core-types",
	"metaobjects-db",
	"metaobjects-documentation",
	"metaobjects-prompt",
	"metaobjects-ui",
];

export interface Fixture {
	/** Scenario directory name. */
	readonly name: string;
	/** Absolute path to the scenario directory. */
	readonly dir: string;
	/** Absolute path to the input/ directory. */
	readonly inputDir: string;
	/** Provider ids to compose for this fixture (providers.json, or the core default). */
	readonly providers: readonly string[];
	readonly hasExpected: boolean;
	readonly hasExpectedEffective: boolean;
	readonly hasExpectedErrors: boolean;
	readonly hasExpectedWarnings: boolean;
	readonly hasScript: boolean;
	/** True when `expected/` exists and contains at least one `.md` doc golden. */
	readonly hasDocsExpected: boolean;
	/** True when a custom contract manifest (`expected-paths.json`) is present —
	 *  a bespoke-runner fixture (see isContractOnlyFixture). */
	readonly hasContractManifest: boolean;
}

/** True when `dir/expected/` exists and holds at least one `.md` file. */
async function hasDocsExpectedDir(dir: string): Promise<boolean> {
	const expectedDir = join(dir, "expected");
	try {
		const entries = await readdir(expectedDir, { withFileTypes: true });
		return entries.some((e) => e.isFile() && e.name.endsWith(".md"));
	} catch (e: unknown) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw e;
	}
}

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch (e: unknown) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw e;
	}
}

/** Discover every scenario directory under a corpus root, sorted by name. */
export async function discoverFixtures(corpusRoot: string): Promise<Fixture[]> {
	const entries = (await readdir(corpusRoot, { withFileTypes: true }))
		.filter((e) => e.isDirectory())
		.map((e) => e.name)
		.sort();

	const fixtures: Fixture[] = [];
	for (const name of entries) {
		const dir = join(corpusRoot, name);
		const inputDir = join(dir, "input");
		if (!(await exists(inputDir))) {
			throw new Error(`Fixture '${name}' has no input/ directory`);
		}
		let providers: readonly string[] = DEFAULT_PROVIDERS;
		try {
			const raw: unknown = JSON.parse(
				await readFile(join(dir, "providers.json"), "utf8"),
			);
			if (!Array.isArray(raw) || !raw.every((p) => typeof p === "string")) {
				throw new Error(
					`Fixture '${name}': providers.json must be a JSON array of strings`,
				);
			}
			providers = raw;
		} catch (e: unknown) {
			if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
		}
		fixtures.push({
			name,
			dir,
			inputDir,
			providers,
			hasExpected: await exists(join(dir, "expected.json")),
			hasExpectedEffective: await exists(join(dir, "expected-effective.json")),
			hasExpectedErrors: await exists(join(dir, "expected-errors.json")),
			hasExpectedWarnings: await exists(join(dir, "expected-warnings.json")),
			hasScript: await exists(join(dir, "script.json")),
			hasDocsExpected: await hasDocsExpectedDir(dir),
			hasContractManifest: await exists(join(dir, "expected-paths.json")),
		});
	}
	return fixtures;
}

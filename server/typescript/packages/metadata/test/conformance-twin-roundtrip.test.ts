// Two source-independence gates over the shared conformance corpus (ADR-0059).
//
// Gate 1 — YAML twin. Every fixture's input loads once as canonical JSON and once
// with the SAME texts read as YAML sources, in the same order. JSON is valid YAML,
// so the second load goes through the YAML desugar. Both loads must report the same
// ordered error codes and, when clean, serialize identically. A reference means the
// same thing whatever source it was written in, so any difference is a defect.
//
// Gate 2 — round trip. Every fixture's `expected.json` loads as the only input and
// must serialize back to itself byte for byte (trailing whitespace aside, as the corpus
// runner compares). Canonical JSON is an output format,
// so what the serializer writes has to load back to the same model.
//
// Exclusions live in shared files beside the corpus, one reason per entry, so every
// port skips the same fixtures for the same reasons.

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import {
	discoverFixtures,
	isContractOnlyFixture,
	isDocsOnlyFixture,
	type Fixture,
} from "@metaobjectsdev/conformance";
import { composeRegistry, type MetaDataTypeProvider } from "../src/provider.js";
import { MetaDataLoader } from "../src/loader/meta-data-loader.js";
import { InMemoryStringSource, type MetaDataSource } from "../src/loader/meta-data-source.js";
import { DirectorySource } from "../src/loader/sources/directory-source.js";
import { canonicalSerialize, canonicalSerializeEffective } from "../src/serializer-json.js";
import type { TypeRegistry } from "../src/registry.js";
import { PROVIDERS } from "./conformance/adapter.js";

const CORPUS =
	process.env.METAOBJECTS_CONFORMANCE_CORPUS ??
	join(import.meta.dir, "../../../../../fixtures/conformance");

interface Exclusions {
	readonly exclusions: Readonly<Record<string, string>>;
}

async function readExclusions(file: string): Promise<Readonly<Record<string, string>>> {
	const parsed = JSON.parse(await readFile(join(CORPUS, file), "utf8")) as Exclusions;
	return parsed.exclusions;
}

const twinExclusions = await readExclusions("yaml-twin-exclusions.json");
const roundTripExclusions = await readExclusions("round-trip-exclusions.json");
const fixtures = (await discoverFixtures(CORPUS)).filter(
	(f) => !isDocsOnlyFixture(f) && !isContractOnlyFixture(f),
);
const fixtureNames = new Set(fixtures.map((f) => f.name));

/** The fixture's registry, or undefined when its providers do not compose (the
 *  provider-composition fixtures — their outcome is a composition error, not a tree). */
function registryFor(fix: Fixture): TypeRegistry | undefined {
	const providers: MetaDataTypeProvider[] = [];
	for (const id of fix.providers) {
		const p = PROVIDERS[id];
		if (p === undefined) return undefined;
		providers.push(p);
	}
	try {
		return composeRegistry(providers);
	} catch {
		return undefined;
	}
}

interface Loaded {
	readonly codes: readonly string[];
	readonly canonical?: string;
	readonly effective?: string;
}

async function loadAll(sources: MetaDataSource[], registry: TypeRegistry): Promise<Loaded> {
	const result = await new MetaDataLoader({ registry, strict: true }).load(sources);
	const codes = result.errors.map((e) => {
		const code = (e as { code?: unknown }).code;
		return typeof code === "string" ? code : "ERR_UNKNOWN";
	});
	if (codes.length > 0) return { codes };
	return {
		codes,
		canonical: canonicalSerialize(result.root),
		effective: canonicalSerializeEffective(result.root),
	};
}

describe("exclusion files", () => {
	test("every excluded fixture exists", () => {
		for (const name of [...Object.keys(twinExclusions), ...Object.keys(roundTripExclusions)]) {
			expect(fixtureNames.has(name)).toBe(true);
		}
	});
});

describe("gate 1: YAML twin", () => {
	for (const fix of fixtures) {
		if (twinExclusions[fix.name] !== undefined) continue;
		test(`twin: ${fix.name}`, async () => {
			const registry = registryFor(fix);
			if (registry === undefined) return; // provider-composition fixture: no tree to twin
			const files = await new DirectorySource(fix.inputDir).expand();
			const texts = await Promise.all(files.map((f) => f.read()));
			const asJson = files.map((f, i) => new InMemoryStringSource(texts[i]!, { id: f.id, format: f.format }));
			// Only canonical-JSON inputs get a twin; a file already authored as YAML stays YAML.
			const asYaml = files.map(
				(f, i) =>
					new InMemoryStringSource(texts[i]!, {
						id: f.id,
						format: extname(f.id).toLowerCase() === ".json" ? "yaml" : f.format,
					}),
			);
			const json = await loadAll(asJson, registry);
			const yaml = await loadAll(asYaml, registry);
			expect(yaml.codes).toEqual(json.codes);
			if (json.canonical !== undefined) {
				expect(yaml.canonical).toBe(json.canonical);
				if (fix.hasExpectedEffective) expect(yaml.effective).toBe(json.effective);
			}
		});
	}
});

describe("gate 2: round trip", () => {
	for (const fix of fixtures) {
		if (!fix.hasExpected || roundTripExclusions[fix.name] !== undefined) continue;
		test(`round-trip: ${fix.name}`, async () => {
			const registry = registryFor(fix);
			if (registry === undefined) return;
			const text = await readFile(join(fix.dir, "expected.json"), "utf8");
			const reloaded = await loadAll([new InMemoryStringSource(text, { id: "expected.json" })], registry);
			expect(reloaded.codes).toEqual([]);
			// Trimmed, as the corpus runner compares goldens: a golden's trailing blank line is not content.
			expect(reloaded.canonical?.trim()).toBe(text.trim());
		});
	}
});

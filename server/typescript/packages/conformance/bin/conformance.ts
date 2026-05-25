#!/usr/bin/env bun
// Conformance CLI — thin wrapper over library functions.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { discoverFixtures } from "../src/fixture.js";
import { lintFixture } from "../src/fixture-lint.js";
import { deriveManifest } from "../src/manifest.js";
import { renderDashboard } from "../src/aggregator.js";
import { generateMetadata } from "../src/generator.js";
import type { ConformanceReport } from "../src/report.js";

const [, , subcommand, ...rest] = process.argv;

switch (subcommand) {
  case "lint": {
    const corpusRoot = rest[0];
    if (!corpusRoot) { console.error("Usage: conformance lint <corpusRoot>"); process.exit(1); }

    const fixtures = await discoverFixtures(corpusRoot);
    const errorCodesRaw: unknown = JSON.parse(
      readFileSync(join(corpusRoot, "ERROR-CODES.json"), "utf8"));
    // Fix 9: guard the shape — a missing or non-object `codes` key would cause
    // Object.keys(undefined) to throw an opaque TypeError at runtime.
    if (
      typeof errorCodesRaw !== "object" ||
      errorCodesRaw === null ||
      typeof (errorCodesRaw as Record<string, unknown>).codes !== "object" ||
      (errorCodesRaw as Record<string, unknown>).codes === null
    ) {
      console.error("lint: ERROR-CODES.json must be an object with a 'codes' object property");
      process.exit(1);
    }
    const errorCodes = Object.keys(
      (errorCodesRaw as { codes: Record<string, string> }).codes);

    let anyProblems = false;
    for (const fix of fixtures) {
      for (const problem of lintFixture(fix, errorCodes)) {
        console.log(problem);
        anyProblems = true;
      }
    }
    if (anyProblems) {
      process.exit(1);
    } else {
      console.log(`lint: ${fixtures.length} fixture(s) clean`);
    }
    break;
  }

  case "manifest": {
    const corpusRoot = rest[0];
    if (!corpusRoot) { console.error("Usage: conformance manifest <corpusRoot>"); process.exit(1); }

    const fixtures = await discoverFixtures(corpusRoot);
    const manifest = deriveManifest(fixtures);
    const outPath = join(corpusRoot, "CAPABILITIES.json");
    writeFileSync(outPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
    console.log(`manifest: wrote ${outPath} (${manifest.capabilities.length} capability-id(s))`);
    break;
  }

  case "aggregate": {
    const reportFiles = rest;
    if (reportFiles.length === 0) {
      console.error("Usage: conformance aggregate <report.json> [<report.json>...]");
      process.exit(1);
    }

    const reports: ConformanceReport[] = reportFiles.map((f) =>
      JSON.parse(readFileSync(f, "utf8")) as ConformanceReport);
    const md = renderDashboard(reports);
    const outPath = join(process.cwd(), "CONFORMANCE.md");
    writeFileSync(outPath, md, "utf8");
    console.log(`aggregate: wrote ${outPath}`);
    break;
  }

  case "generate": {
    const corpusRoot = rest[0];
    const countStr = rest[1];
    const startSeedStr = rest[2];
    if (!corpusRoot || !countStr) {
      console.error("Usage: conformance generate <corpusRoot> <count> [startSeed]");
      process.exit(1);
    }
    // Fix 8: use Number() + Number.isInteger() so "5abc" is rejected (parseInt
    // would silently accept it as 5).
    const count = Number(countStr);
    if (!Number.isInteger(count) || count < 1) {
      console.error("generate: <count> must be a positive integer");
      process.exit(1);
    }
    const startSeed = startSeedStr !== undefined ? Number(startSeedStr) : 1;
    if (!Number.isInteger(startSeed)) {
      console.error("generate: [startSeed] must be an integer");
      process.exit(1);
    }

    // Import the TS oracle — public API only (no test helpers).
    const { MetaDataLoader, InMemoryStringSource, canonicalSerialize } =
      await import("@metaobjectsdev/metadata");

    for (let i = 0; i < count; i++) {
      const seed = startSeed + i;
      const doc = generateMetadata(seed);
      const inputJson = JSON.stringify(doc, null, 2) + "\n";

      // Run through TS reference (oracle) to capture golden expected.json.
      // A generated document that fails to load is a generator bug — abort loudly.
      const loader = new MetaDataLoader();
      const source = new InMemoryStringSource(inputJson, { id: "meta.json", format: "json" });
      const result = await loader.load([source]);
      if (result.errors.length > 0) {
        const details = result.errors
          .map((e) => `  - ${"code" in e ? `[${(e as { code: string }).code}] ` : ""}${e.message}`)
          .join("\n");
        console.error(`generate: seed ${seed} produced invalid metadata (generator bug):\n${details}`);
        process.exit(1);
      }

      // Write input/meta.json
      const fixtureDir = join(corpusRoot, `generated-${seed}`);
      const inputDir = join(fixtureDir, "input");
      mkdirSync(inputDir, { recursive: true });
      writeFileSync(join(inputDir, "meta.json"), inputJson, "utf8");

      const golden = canonicalSerialize(result.root) + "\n";
      writeFileSync(join(fixtureDir, "expected.json"), golden, "utf8");

      console.log(`generate: wrote ${fixtureDir}`);
    }
    break;
  }

  default: {
    console.error("Usage: conformance <lint|manifest|aggregate|generate> [args...]");
    process.exit(1);
  }
}

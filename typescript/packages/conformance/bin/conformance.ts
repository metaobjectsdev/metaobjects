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
    const errorCodes = Object.keys(
      (errorCodesRaw as { codes: Record<string, string> }).codes);

    const allProblems: string[] = [];
    for (const fix of fixtures) {
      const problems = lintFixture(fix, errorCodes);
      for (const p of problems) {
        console.log(p);
        allProblems.push(p);
      }
    }
    if (allProblems.length > 0) {
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
    const manifest = deriveManifest(fixtures, corpusRoot);
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
    const count = parseInt(countStr, 10);
    const startSeed = startSeedStr !== undefined ? parseInt(startSeedStr, 10) : 1;
    if (isNaN(count) || count < 1) {
      console.error("generate: <count> must be a positive integer");
      process.exit(1);
    }

    // Import the TS oracle — public API only (no test helpers).
    const { MetaDataLoader, InMemorySource, canonicalSerialize } =
      await import("@metaobjects/metadata");

    for (let i = 0; i < count; i++) {
      const seed = startSeed + i;
      const doc = generateMetadata(seed);
      const inputJson = JSON.stringify(doc, null, 2) + "\n";

      // Write input/meta.json
      const fixtureDir = join(corpusRoot, `generated-${seed}`);
      const inputDir = join(fixtureDir, "input");
      mkdirSync(inputDir, { recursive: true });
      writeFileSync(join(inputDir, "meta.json"), inputJson, "utf8");

      // Run through TS reference (oracle) to capture golden expected.json
      const loader = new MetaDataLoader();
      const source = new InMemorySource(inputJson, { id: "meta.json", format: "json" });
      const result = await loader.load([source]);
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

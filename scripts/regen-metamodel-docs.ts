#!/usr/bin/env bun
//
// regen-metamodel-docs.ts
//
// Regenerates the byte-gated metamodel-docs conformance fixture
// fixtures/metamodel-docs/expected/ from the TS reference renderer. The
// metamodel-docs engine is the TS neutral reference (FR-033 S3); cross-port is a
// later deferral.
//
// These docs describe the METAMODEL ITSELF (the type/subtype/attr vocabulary of
// the strict registry) — distinct from `meta docs --model` (a user's entities).
// Committing the expected output makes a vocabulary/description change drift-
// gated: it must regenerate the docs to stay green.
//
// Run:
//   bun run scripts/regen-metamodel-docs.ts

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { composeRegistry } from "../server/typescript/packages/metadata/src/provider.js";
import { coreProviders } from "../server/typescript/packages/metadata/src/core-types.js";
import { renderCoreMetamodelDocs } from "../server/typescript/packages/metadata/src/metamodel-docs/index.js";

/** Walk up to the dir containing both spec/ and server/ — no hardcoded paths. */
function findRepoRoot(start: string): string {
  let dir = start;
  while (true) {
    if (existsSync(join(dir, "spec")) && existsSync(join(dir, "server"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error("Could not locate repo root (dir containing spec/ and server/)");
    }
    dir = parent;
  }
}

const repoRoot = findRepoRoot(dirname(fileURLToPath(import.meta.url)));
const expectedDir = join(repoRoot, "fixtures", "metamodel-docs", "expected");

// Clean + recreate so a removed type/subtype drops its stale page.
rmSync(expectedDir, { recursive: true, force: true });
mkdirSync(expectedDir, { recursive: true });

const docs = renderCoreMetamodelDocs(composeRegistry(coreProviders));
let bytes = 0;
for (const [rel, content] of [...docs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
  const path = join(expectedDir, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  bytes += content.length;
}

process.stdout.write(
  `Wrote ${docs.size} metamodel-docs file(s) (${bytes} bytes) → ${expectedDir}\n`,
);

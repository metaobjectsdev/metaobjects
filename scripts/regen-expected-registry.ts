#!/usr/bin/env bun
//
// regen-expected-registry.ts
//
// Regenerates the cross-port registry-conformance canonical
// fixtures/registry-conformance/expected-registry.json from the TS reference
// emitter. TS is the reference port: it pins both the canonical AND the exact
// serialization the other four ports (C#, Java, Kotlin, Python) must byte-match.
//
// FR-033 Phase 2 regenerates this repeatedly (as the declarative provider data
// in spec/metamodel/*.json grows the documentation surface + constraint graph),
// so a small committed regen script is justified, not premature.
//
// Run:
//   bun run scripts/regen-expected-registry.ts
//
// After regenerating, run every port's registry-conformance runner to confirm
// they still byte-match — reconciling any newly-surfaced divergence at source
// (a grown canonical is EXPECTED to RED-flag the other four ports until they
// reconcile; the same documented intermediate state as the FR-032 sweep).

import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { composeRegistry } from "../server/typescript/packages/metadata/src/provider.js";
import { coreProviders } from "../server/typescript/packages/metadata/src/core-types.js";
import { emitRegistryManifest } from "../server/typescript/packages/metadata/src/registry-manifest.js";

// Resolve the repo root relative to THIS script (walk up to the dir containing
// both spec/ and server/). No hardcoded absolute paths.
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
const canonicalPath = join(
  repoRoot,
  "fixtures",
  "registry-conformance",
  "expected-registry.json",
);

const manifest = emitRegistryManifest(composeRegistry(coreProviders));
writeFileSync(canonicalPath, manifest);

process.stdout.write(`Wrote ${canonicalPath} (${manifest.length} bytes)\n`);

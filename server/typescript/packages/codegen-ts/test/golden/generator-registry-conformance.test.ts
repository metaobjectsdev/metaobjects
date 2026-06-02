// Conformance gate (ADR-0021 D3): the shipped TS generator registry MUST match
// the canonical cross-port stable-name manifest at
// fixtures/generator-registry-conformance/registry.json.
//
// The manifest is the single source of truth. For THIS port (`typescript`) the
// README contract is:
//   1. Every stable name the TS registry exposes appears in the manifest.
//   2. Presence both ways — every manifest entry whose `ports` includes
//      `typescript` IS in the TS registry, and the TS registry exposes NO name
//      whose `ports` omits `typescript`. (Set equality catches both at once.)
//   3. Tier agreement — a manifest name marked `tier: "neutral"` is flagged
//      neutral in the TS registry; native manifest names are NOT neutral.
//
// If this test fails, the manifest and the TS registry DISAGREE: report the diff;
// do NOT mutate the manifest to force a pass (the manifest is reconciled
// cross-port, not per-port).

import { describe, it, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { generatorRegistry } from "../../src/generator-registry.js";

const PORT = "typescript" as const;

// Walk UP from this test file's dir until we find a dir containing BOTH
// fixtures/ and server/ — that's the repo root. No hardcoded absolute paths.
// (Same strategy as templates-canonical / docs-file-conformance tests.)
function findRepoRoot(start: string): string {
  let dir = start;
  // eslint-disable-next-line no-constant-condition
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

interface ManifestEntry {
  concept: string;
  tier: "native" | "neutral";
  note?: string;
  ports: string[];
}

interface Manifest {
  ports: string[];
  generators: Record<string, ManifestEntry>;
}

const repoRoot = findRepoRoot(import.meta.dir);
const manifestPath = join(
  repoRoot,
  "fixtures",
  "generator-registry-conformance",
  "registry.json",
);
const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as Manifest;

// Names the manifest says `typescript` is expected to expose.
const expectedNames = new Set(
  Object.entries(manifest.generators)
    .filter(([, entry]) => entry.ports.includes(PORT))
    .map(([name]) => name),
);

// Names the TS registry actually exposes (key === entry.name by contract).
const actualNames = new Set(Object.keys(generatorRegistry));

describe("generator registry — conforms to canonical stable-name manifest (ADR-0021 D3)", () => {
  it(`manifest lists ${PORT} for this registry's fixture`, () => {
    expect(manifest.ports).toContain(PORT);
  });

  it(`TS registry names == manifest's ${PORT} slice (no rogue, no missing)`, () => {
    const extraInRegistry = [...actualNames]
      .filter((n) => !expectedNames.has(n))
      .sort();
    const missingFromRegistry = [...expectedNames]
      .filter((n) => !actualNames.has(n))
      .sort();

    const message = [
      `TS generator registry disagrees with the canonical manifest for port "${PORT}".`,
      `  extra in registry (name registered but manifest's ${PORT} omits it): [${extraInRegistry.join(", ")}]`,
      `  missing from registry (manifest expects ${PORT} but not registered): [${missingFromRegistry.join(", ")}]`,
      `  manifest: ${manifestPath}`,
    ].join("\n");

    // Assert the symmetric difference is empty (actionable on failure).
    expect(
      { extraInRegistry, missingFromRegistry },
      message,
    ).toEqual({ extraInRegistry: [], missingFromRegistry: [] });
  });

  // Tier agreement — only over names present in BOTH sets.
  const sharedNames = [...expectedNames].filter((n) => actualNames.has(n)).sort();
  for (const name of sharedNames) {
    const manifestTier = manifest.generators[name]!.tier;
    it(`tier agreement: "${name}" is ${manifestTier} in both manifest and TS registry`, () => {
      const registryTier = generatorRegistry[name]!.tier;
      if (manifestTier === "neutral") {
        expect(registryTier).toBe("neutral");
      } else {
        expect(registryTier).not.toBe("neutral");
      }
    });
  }
});

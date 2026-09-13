// Conformance gate (ADR-0021 D3): the shipped TS generator registry MUST match
// the canonical cross-port stable-name manifest at
// fixtures/generator-registry-conformance/registry.json.
//
// The manifest is the single source of truth. For THIS port (`typescript`) the
// README contract is:
//   1. Every stable name the TS registry exposes appears in the manifest.
//   2. Tier agreement — a manifest name marked `tier: "neutral"` is flagged
//      neutral in the TS registry; native manifest names are NOT neutral.
//   3. Layer agreement — a manifest name's `layer` equals the TS registry's.
//   4. Every manifest entry declares one of the six layers.
//
// PRESENCE BOTH WAYS IS ASSERTED ELSEWHERE. `codegen-ts` is one SLICE of the
// TypeScript catalog: `form` lives in `codegen-ts-react` and `hooks`/`grid`/
// `grid-hook` in `codegen-ts-tanstack`, and this package cannot import its own
// dependents to see them. Set equality against the manifest's `typescript` slice is
// therefore a property of the COMPOSED catalog and is asserted in
// `packages/cli/test/catalog-conformance.test.ts`, which is the only place all three
// slices are visible at once. What is checkable here is the one direction that does
// not need them: no rogue names.
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
  layer: string;
  note?: string;
  ports: string[];
}

// The closed set, mirrored from GENERATOR_LAYERS. Spelled out here rather than
// imported so this gate fails if the CODE's union and the MANIFEST's values ever
// diverge from the six the design ruled — importing the union would make the test
// agree with whatever the code says.
const LAYERS = ["model", "persistence", "api", "client", "docs", "capability"] as const;

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

  it(`no rogue names — every name codegen-ts registers is a ${PORT} name in the manifest`, () => {
    const extraInRegistry = [...actualNames]
      .filter((n) => !expectedNames.has(n))
      .sort();

    const message = [
      `The codegen-ts registry exposes names the canonical manifest does not give to "${PORT}".`,
      `  extra in registry: [${extraInRegistry.join(", ")}]`,
      `  manifest: ${manifestPath}`,
      "  (The other direction — every manifest typescript name IS registered — is asserted",
      "   on the COMPOSED catalog in packages/cli/test/catalog-conformance.test.ts, because",
      "   codegen-ts is one slice of three.)",
    ].join("\n");

    expect(extraInRegistry, message).toEqual([]);
  });

  it("every manifest entry declares one of the six layers", () => {
    const bad = Object.entries(manifest.generators)
      .filter(([, e]) => !(LAYERS as readonly string[]).includes(e.layer))
      .map(([n, e]) => `${n}=${String(e.layer)}`)
      .sort();
    expect(
      bad,
      `entries with a missing or unknown layer (allowed: ${LAYERS.join(", ")}): ${bad.join(", ")}`,
    ).toEqual([]);
  });

  // Tier + layer agreement — only over names present in BOTH sets.
  const sharedNames = [...expectedNames].filter((n) => actualNames.has(n)).sort();
  for (const name of sharedNames) {
    const manifestTier = manifest.generators[name]!.tier;
    const manifestLayer = manifest.generators[name]!.layer;
    it(`tier agreement: "${name}" is ${manifestTier} in both manifest and TS registry`, () => {
      const registryTier = generatorRegistry[name]!.tier;
      if (manifestTier === "neutral") {
        expect(registryTier).toBe("neutral");
      } else {
        expect(registryTier).not.toBe("neutral");
      }
    });
    it(`layer agreement: "${name}" is ${manifestLayer} in both manifest and TS registry`, () => {
      // Compared as plain strings: the manifest is the source of truth and its value is
      // untyped here on purpose, so narrowing it to the code's union would make the
      // gate agree with whatever the code says.
      expect(String(generatorRegistry[name]!.layer)).toBe(manifestLayer);
    });
  }
});

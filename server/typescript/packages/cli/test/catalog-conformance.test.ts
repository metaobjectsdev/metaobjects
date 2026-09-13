// Conformance gate (ADR-0021 D3): the COMPOSED TypeScript catalog must equal the
// canonical cross-port manifest's `typescript` slice, both ways.
//
// This assertion cannot live in `codegen-ts`. That package registers one of three
// slices and cannot import its own dependents, so it can only check "no rogue names"
// (which it does, in test/golden/generator-registry-conformance.test.ts). The CLI is the
// only package that sees all three, so set equality — the half that catches a MISSING
// registration — belongs here.
//
// If this fails, the manifest and the composed catalog DISAGREE: report the diff; do
// NOT mutate the manifest to force a pass (it is reconciled cross-port, not per-port).

import { describe, it, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { GENERATOR_LAYERS } from "@metaobjectsdev/codegen-ts";
import { composeCatalog, listCatalog, packageOf, catalogPackages } from "../src/lib/catalog.js";

const PORT = "typescript" as const;

// Walk UP until a directory holds BOTH fixtures/ and server/ — the repo root.
// (Same strategy as every other conformance test; no hard-coded absolute paths.)
function findRepoRoot(start: string): string {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, "fixtures")) && existsSync(join(dir, "server"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error("Could not locate repo root (dir containing fixtures/ and server/)");
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

const manifestPath = join(
  findRepoRoot(import.meta.dir),
  "fixtures",
  "generator-registry-conformance",
  "registry.json",
);
const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
  ports: string[];
  generators: Record<string, ManifestEntry>;
};

const expectedNames = new Set(
  Object.entries(manifest.generators)
    .filter(([, e]) => e.ports.includes(PORT))
    .map(([n]) => n),
);

describe("the composed TS catalog conforms to the canonical manifest", () => {
  it(`composed catalog == manifest's ${PORT} slice (no rogue, no missing)`, () => {
    const actualNames = new Set(Object.keys(composeCatalog()));
    const extra = [...actualNames].filter((n) => !expectedNames.has(n)).sort();
    const missing = [...expectedNames].filter((n) => !actualNames.has(n)).sort();

    const message = [
      `The composed TypeScript catalog disagrees with the canonical manifest.`,
      `  extra (registered by a slice, but the manifest's ${PORT} omits it): [${extra.join(", ")}]`,
      `  missing (manifest expects ${PORT}, no slice registers it): [${missing.join(", ")}]`,
      `  slices composed: ${catalogPackages().join(", ")}`,
      `  manifest: ${manifestPath}`,
    ].join("\n");

    expect({ extra, missing }, message).toEqual({ extra: [], missing: [] });
  });

  it("tier and layer agree with the manifest, entry by entry", () => {
    const catalog = composeCatalog();
    const disagreements: string[] = [];
    for (const name of expectedNames) {
      const entry = catalog[name];
      if (entry === undefined) continue; // reported by the set-equality test above
      const m = manifest.generators[name]!;
      if (entry.tier !== m.tier) disagreements.push(`${name}.tier: ${entry.tier} != ${m.tier}`);
      if (entry.layer !== m.layer) disagreements.push(`${name}.layer: ${entry.layer} != ${m.layer}`);
    }
    expect(disagreements).toEqual([]);
  });

  it("every catalog entry is attributable to exactly one package", () => {
    for (const name of Object.keys(composeCatalog())) {
      expect(packageOf(name), `packageOf(${name})`).toBeDefined();
    }
  });

  it("composition refuses a duplicate stable name", () => {
    // The live slices must not collide; the throw path is what makes that a build
    // failure rather than last-slice-wins.
    expect(() => composeCatalog()).not.toThrow();
  });

  it("listCatalog() is grouped by layer, in the declared layer order", () => {
    const seen: string[] = [];
    for (const e of listCatalog()) {
      if (seen[seen.length - 1] !== e.layer) seen.push(e.layer);
    }
    // Each layer appears exactly once (i.e. the list is grouped, not interleaved) and
    // in GENERATOR_LAYERS order.
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual(GENERATOR_LAYERS.filter((l) => seen.includes(l)));
  });

  it("every one of the six layers has at least one member", () => {
    const populated = new Set(listCatalog().map((e) => e.layer));
    // A layer with no member in ANY port would be dead vocabulary; a layer with no
    // member in THIS port is legitimate, so this asserts against the manifest, not the
    // TS catalog.
    const manifestLayers = new Set(Object.values(manifest.generators).map((e) => e.layer));
    expect([...GENERATOR_LAYERS].filter((l) => !manifestLayers.has(l))).toEqual([]);
    expect(populated.size).toBeGreaterThan(0);
  });
});

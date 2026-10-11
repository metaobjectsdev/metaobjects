import { describe, test, expect } from "bun:test";
import {
  generatorRegistry,
  listGenerators,
  getGenerator,
  GENERATOR_LAYERS,
  type GeneratorRegistryEntry,
} from "../src/generator-registry.js";
import { REFERENCE_GENERATOR_NAMES } from "../src/reference-templates.js";
import { isPackagedDocsGenerator } from "../src/packaged-docs-generators.js";

// ADR-0021 D3 — stable-name generator registry. The stable names are the
// cross-port contract; this test pins them + asserts each entry carries a
// non-empty description and a working factory (constructing it must not throw).

// The recommended NATIVE gen suite (Tier-1). `docs` is deliberately NOT in this
// list (D1: it is owned by `meta docs`).
const EXPECTED_NATIVE = [
  "entity",
  "queries",
  "callable",
  "routes",
  "routes-hono",
  "barrel",
  "names",
  "prompt-render",
  "output-parser",
  "extractor",
  "output-prompt",
  "render-helper",
  "template",
  "api-docs",
  "trace-helper",
  "requirement-tests",
  "cube-model",
  "shared-model",
] as const;

// Neutral / `meta docs`-owned (Tier-2). Present in the registry for identity +
// discoverability, but flagged so they are NOT part of the recommended native
// `meta gen` surface.
const EXPECTED_NEUTRAL = ["docs", "requirements", "agent-docs"] as const;

describe("generator-registry (ADR-0021 D3)", () => {
  test("contains every expected stable name", () => {
    const names = Object.keys(generatorRegistry).sort();
    const expected = [...EXPECTED_NATIVE, ...EXPECTED_NEUTRAL].sort();
    expect(names).toEqual(expected);
  });

  test("every entry has a non-empty one-line description", () => {
    for (const [id, entry] of Object.entries(generatorRegistry)) {
      expect(entry.name, `${id}.name`).toBe(id);
      expect(entry.description.length, `${id}.description`).toBeGreaterThan(0);
      expect(entry.description.includes("\n"), `${id}.description single-line`).toBe(false);
    }
  });

  test("every entry has a tier of native or neutral", () => {
    for (const [id, entry] of Object.entries(generatorRegistry)) {
      expect(["native", "neutral"], `${id}.tier`).toContain(entry.tier);
    }
  });

  test("native generators are flagged native; docs flagged neutral", () => {
    for (const n of EXPECTED_NATIVE) {
      expect(generatorRegistry[n]?.tier, `${n} tier`).toBe("native");
    }
    for (const n of EXPECTED_NEUTRAL) {
      expect(generatorRegistry[n]?.tier, `${n} tier`).toBe("neutral");
    }
  });

  test("neutral entries carry a note pointing at the canonical door", () => {
    expect(generatorRegistry["docs"]?.note ?? "").toContain("meta docs");
  });

  // Resolved, not listed: the set is whatever the RUNNER skips. `api-docs` is native,
  // so the neutral check above never reached it, and its row presented a generator
  // `meta gen` refuses to run as something to wire.
  test("every entry `meta gen` skips says on its row that the door is `meta docs`", () => {
    const skipped = Object.values(generatorRegistry).filter((e) => isPackagedDocsGenerator(e.factory().name));
    expect(skipped.map((e) => e.name).sort()).toEqual(["api-docs", "docs"]);
    for (const entry of skipped) {
      expect(entry.note ?? "", `${entry.name}.note`).toContain("meta docs");
      expect(entry.layer, `${entry.name}.layer`).toBe("docs");
    }
  });

  // The other direction. The standalone `mermaid-er` generator was the one docs-layer
  // entry `meta gen` still ran by design; 1.1 removed it.
  test("the docs-layer entries `meta gen` does not skip are the two `meta docs` engines", () => {
    const run = Object.values(generatorRegistry)
      .filter((e) => e.layer === "docs" && !isPackagedDocsGenerator(e.factory().name));
    // `requirements` and `agent-docs` are the engines behind `meta docs` and
    // `meta docs --agent`. They were in no registry until the eject census found them
    // (ADR-0034 Amendment 8), and `meta gen` does not skip a wired factory of either, as
    // it did not before they had rows. Pinned, so a third cannot join unnoticed.
    expect(run.map((e) => e.name).sort()).toEqual(["agent-docs", "requirements"]);
  });

  // Two definitions have to agree: the runner skips by implementation name
  // (packaged-docs-generators.ts) and the catalog reads `docsSurface` off the row (it
  // decides the eject wiring and whether a row prints a `generators` import). A row
  // carrying one and not the other would be skipped by `meta gen` yet offered an import
  // for `generators`, or the reverse.
  test("an entry carries `docsSurface` exactly when `meta gen` skips its generator", () => {
    for (const entry of Object.values(generatorRegistry)) {
      expect(entry.docsSurface !== undefined, entry.name).toBe(isPackagedDocsGenerator(entry.factory().name));
    }
  });

  test("every factory constructs a Generator with a name without throwing", () => {
    for (const [id, entry] of Object.entries(generatorRegistry)) {
      const gen = entry.factory();
      expect(typeof gen.name, `${id} produces a named Generator`).toBe("string");
      expect(gen.name.length).toBeGreaterThan(0);
      expect(typeof gen.generate, `${id}.generate is callable`).toBe("function");
    }
  });

  test("listGenerators() returns native-then-neutral, each well-formed", () => {
    const list = listGenerators();
    expect(list.length).toBe(EXPECTED_NATIVE.length + EXPECTED_NEUTRAL.length);
    const native = list.filter((e) => e.tier === "native").map((e) => e.name);
    const neutral = list.filter((e) => e.tier === "neutral").map((e) => e.name);
    expect(native.sort()).toEqual([...EXPECTED_NATIVE].sort());
    expect(neutral.sort()).toEqual([...EXPECTED_NEUTRAL].sort());
  });

  test("getGenerator() resolves a known id and returns undefined otherwise", () => {
    const entry = getGenerator("entity") as GeneratorRegistryEntry;
    expect(entry?.name).toBe("entity");
    expect(getGenerator("does-not-exist")).toBeUndefined();
  });

  test("names is selectable by stable name (the C#/Python parity path)", () => {
    const entry = getGenerator("names");
    expect(entry?.name).toBe("names");
    expect(entry?.tier).toBe("native");
    // The factory must construct without throwing — `--list` calls every factory.
    const gen = entry?.factory();
    expect(gen?.name).toBe("names");
    // §A6: the marker the runner aggregates into includeNames. Registering the
    // generator without it would emit the artifact while every template still
    // embedded its own literal.
    expect(gen?.emitsNames).toBe(true);
  });

  // ----- the catalog facets (opt-in codegen design §D2b) --------------------

  test("every entry declares kind, a known layer, and ejectable", () => {
    for (const [id, entry] of Object.entries(generatorRegistry)) {
      expect(entry.kind, `${id}.kind`).toBe("generator");
      expect(GENERATOR_LAYERS, `${id}.layer`).toContain(entry.layer);
      expect(typeof entry.ejectable, `${id}.ejectable`).toBe("boolean");
    }
  });

  test("ejectable is DERIVED from the shipped reference templates, never hand-kept", () => {
    const templates = new Set<string>(REFERENCE_GENERATOR_NAMES);
    for (const [id, entry] of Object.entries(generatorRegistry)) {
      expect(entry.ejectable, `${id}.ejectable`).toBe(templates.has(id));
    }
    // ...and every template this package ships has an entry to be reached through.
    for (const name of templates) {
      expect(Object.keys(generatorRegistry), `template ${name} has a registry entry`).toContain(name);
    }
  });

  test("cube-model is a capability-layer reference helper whose output needs nothing installed", () => {
    // FR-044 Plan 4: Cube reads the YAML from its own project, so the emitted files import no
    // MetaObjects package and no third-party one, and depend on no other generator's output.
    const entry = getGenerator("cube-model") as GeneratorRegistryEntry;
    expect(entry.layer).toBe("capability");
    expect(entry.tier).toBe("native");
    expect(entry.ejectable).toBe(true);
    expect(entry.requires).toEqual([]);
    expect(entry.runtimePackages).toEqual([]);
    expect(entry.runtimePeers).toEqual([]);
    expect(entry.configKeys).toEqual(["dialect", "columnNamingStrategy"]);
    expect(entry.options).toBe("dialect?, filter?, target?");
    expect(entry.description).toContain("model/cubes/*.yml");
    expect(entry.factory().name).toBe("cube-model");
  });

  test("requires only names entries this slice actually contains", () => {
    // codegen-ts is self-contained: nothing here may require a react/tanstack name,
    // because this package cannot see those slices to resolve one.
    for (const [id, entry] of Object.entries(generatorRegistry)) {
      for (const dep of entry.requires ?? []) {
        expect(Object.keys(generatorRegistry), `${id} requires ${dep}`).toContain(dep);
      }
    }
  });

  test("no entry declares a framework — every codegen-ts generator but routes is neutral", () => {
    // The two `api`-layer route generators are the only framework-bearing entries in
    // this package; `client` (react/tanstack) lives in the other two slices.
    const framed = Object.values(generatorRegistry)
      .filter((e) => e.framework !== undefined)
      .map((e) => `${e.name}=${e.framework}`)
      .sort();
    expect(framed).toEqual(["routes-hono=hono", "routes=fastify"]);
  });
});

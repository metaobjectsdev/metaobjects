import { describe, test, expect } from "bun:test";
import {
  generatorRegistry,
  listGenerators,
  getGenerator,
  GENERATOR_LAYERS,
  type GeneratorRegistryEntry,
} from "../src/generator-registry.js";
import { REFERENCE_GENERATOR_NAMES } from "../src/reference-templates.js";

// ADR-0021 D3 — stable-name generator registry. The stable names are the
// cross-port contract; this test pins them + asserts each entry carries a
// non-empty description and a working factory (constructing it must not throw).

// NATIVE: idiomatic per-port output.
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

// NEUTRAL: language-neutral pages about the model. A description of the output only: every
// entry, either tier, runs when the project lists it (ADR-0034 Amendment 9).
const EXPECTED_NEUTRAL = ["docs", "requirements", "agent-docs", "metamodel-docs", "docs-site"] as const;

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

  // ADR-0034 Amendment 9: documentation is written into the `docs` target unless a factory is
  // told otherwise, and never into the code's output directory by default.
  test("every docs-layer entry writes to the docs target by default", () => {
    const docsLayer = Object.values(generatorRegistry).filter((e) => e.layer === "docs");
    expect(docsLayer.map((e) => e.name).sort()).toEqual(
      ["agent-docs", "api-docs", "docs", "docs-site", "metamodel-docs", "requirements"],
    );
    for (const entry of docsLayer) expect(entry.factory().target, entry.name).toBe("docs");
  });

  // No row names a door: there is one way to generate, so no row may point anywhere else.
  test("no entry's note or description points at a docs command", () => {
    for (const entry of Object.values(generatorRegistry)) {
      expect(`${entry.description} ${entry.note ?? ""}`, entry.name).not.toContain("meta docs");
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
    expect(entry.configKeys).toEqual(["dialect"]);
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

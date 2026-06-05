import { describe, test, expect } from "bun:test";
import {
  generatorRegistry,
  listGenerators,
  getGenerator,
  type GeneratorRegistryEntry,
} from "../src/generator-registry.js";

// ADR-0021 D3 — stable-name generator registry. The stable names are the
// cross-port contract; this test pins them + asserts each entry carries a
// non-empty description and a working factory (constructing it must not throw).

// The recommended NATIVE gen suite (Tier-1). docs/mermaid are deliberately NOT
// in this list (D1: docs is owned by `meta docs`; mermaid by the neutral docs
// engine per ADR-0020).
const EXPECTED_NATIVE = [
  "entity",
  "queries",
  "callable",
  "routes",
  "routes-hono",
  "barrel",
  "prompt-render",
  "output-parser",
  "extractor",
  "output-prompt",
  "render-helper",
  "template",
  "trace-helper",
] as const;

// Neutral / `meta docs`-owned (Tier-2). Present in the registry for identity +
// discoverability, but flagged so they are NOT part of the recommended native
// `meta gen` surface.
const EXPECTED_NEUTRAL = ["docs", "mermaid-er"] as const;

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

  test("native generators are flagged native; docs/mermaid flagged neutral", () => {
    for (const n of EXPECTED_NATIVE) {
      expect(generatorRegistry[n]?.tier, `${n} tier`).toBe("native");
    }
    for (const n of EXPECTED_NEUTRAL) {
      expect(generatorRegistry[n]?.tier, `${n} tier`).toBe("neutral");
    }
  });

  test("neutral entries carry a note pointing at the canonical door", () => {
    expect(generatorRegistry["docs"]?.note ?? "").toContain("meta docs");
    expect((generatorRegistry["mermaid-er"]?.note ?? "").length).toBeGreaterThan(0);
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
});

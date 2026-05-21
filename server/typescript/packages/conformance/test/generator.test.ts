import { test, expect } from "bun:test";
import { generateMetadata } from "../src/generator.js";
import { MetaDataLoader, InMemorySource } from "@metaobjects/metadata";

test("the same seed produces the same metadata (deterministic)", () => {
  const a = generateMetadata(42);
  const b = generateMetadata(42);
  expect(JSON.stringify(a)).toBe(JSON.stringify(b));
});

test("different seeds produce different metadata", () => {
  expect(JSON.stringify(generateMetadata(1)))
    .not.toBe(JSON.stringify(generateMetadata(2)));
});

test("generated metadata is a canonical-shaped root", () => {
  const md = generateMetadata(7) as Record<string, unknown>;
  expect(Object.keys(md)).toEqual(["metadata.root"]);
});

test("generateMetadata produces valid metadata for seeds 1–20 (loader roundtrip)", async () => {
  for (let seed = 1; seed <= 20; seed++) {
    const doc = generateMetadata(seed);
    const inputJson = JSON.stringify(doc, null, 2);
    const loader = new MetaDataLoader();
    const source = new InMemorySource(inputJson, { id: "meta.json", format: "json" });
    const result = await loader.load([source]);
    expect(
      result.errors,
      `seed ${seed} produced loader errors: ${result.errors.map((e) => e.message).join("; ")}`
    ).toHaveLength(0);
  }
});

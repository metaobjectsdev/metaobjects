import { test, expect } from "bun:test";
import { generateMetadata } from "../src/generator.js";

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

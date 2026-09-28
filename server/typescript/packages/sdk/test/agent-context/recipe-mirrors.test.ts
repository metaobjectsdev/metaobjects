// test/agent-context/recipe-mirrors.test.ts
//
// Two recipes are shipped INSIDE the scaffolded codegen skill, because an agent in an
// adopter's project has no copy of this repository's docs/: it only has what `meta init`
// wrote. The copies must not drift from the originals, which are the tested ones —
// docs/recipes/generators/typescript/mongo-repository.ts is copied into a fresh project and
// run against MongoDB by the integration suite (document-store-recipe.test.ts).
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "../../../../../..");
const REFS = join(REPO, "agent-context/skills/metaobjects-codegen/references");

test("the shipped MongoDB repository generator is the tested recipe, byte for byte", () => {
  const shipped = readFileSync(join(REFS, "typescript-document-store.md"), "utf8");
  const block = /## The generator\n\n```ts\n([\s\S]*)\n```\n$/.exec(shipped);
  expect(block).not.toBeNull();
  const original = readFileSync(join(REPO, "docs/recipes/generators/typescript/mongo-repository.ts"), "utf8");
  expect(block![1] + "\n").toBe(original);
});

test("the shipped MySQL guide carries the recipe's setup, DDL and behaviour sections unchanged", () => {
  const MARK = "## TypeScript setup";
  const shipped = readFileSync(join(REFS, "typescript-mysql.md"), "utf8");
  const original = readFileSync(join(REPO, "docs/recipes/mysql.md"), "utf8");
  expect(shipped.includes(MARK)).toBe(true);
  expect(shipped.slice(shipped.indexOf(MARK))).toBe(original.slice(original.indexOf(MARK)));
});

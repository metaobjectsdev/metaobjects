// test/agent-context/recipe-mirrors.test.ts
//
// Three recipes are shipped INSIDE the scaffolded codegen skill, because an agent in an
// adopter's project has no copy of this repository's docs/: it only has what `meta init`
// wrote. The copies must not drift from the originals, which are the tested ones —
// docs/recipes/generators/typescript/mongo-repository.ts is copied into a fresh project and
// run against MongoDB by the integration suite (document-store-recipe.test.ts).
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "../../../../../..");
const REFS = join(REPO, "agent-context/skills/metaobjects-codegen/references");
const AUTHORING_REFS = join(REPO, "agent-context/skills/metaobjects-authoring/references");
const BROWNFIELD = join(REPO, "examples/brownfield");

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

test("the shipped Prisma guide carries the recipe's setup, workflow, mapping and refusal sections unchanged", () => {
  const MARK = "## TypeScript setup";
  const shipped = readFileSync(join(REFS, "typescript-prisma.md"), "utf8");
  const original = readFileSync(join(REPO, "docs/recipes/prisma.md"), "utf8");
  expect(shipped.includes(MARK)).toBe(true);
  expect(shipped.slice(shipped.indexOf(MARK))).toBe(original.slice(original.indexOf(MARK)));
});

test("the shipped adoption guide carries the recipe unchanged", () => {
  const MARK = "## The recipe";
  const shipped = readFileSync(join(AUTHORING_REFS, "adopting-existing-models.md"), "utf8");
  const original = readFileSync(join(REPO, "docs/features/adopting-existing-models.md"), "utf8");
  expect(original.includes(MARK)).toBe(true);
  expect(shipped.slice(shipped.lastIndexOf(`\n${MARK}\n`) + 1)).toBe(original.slice(original.indexOf(`\n${MARK}\n`) + 1));
});

// The recipe prints these helpers for an agent to copy. brownfield-recipe.test.ts and
// test_brownfield_recipe.py run the example copies, so the printed text must be those.
test("the helpers the adoption recipe prints are the tested ones, byte for byte", () => {
  const recipe = readFileSync(join(REPO, "docs/features/adopting-existing-models.md"), "utf8");
  const differs = readFileSync(join(BROWNFIELD, "drizzle/proof/differs.ts"), "utf8");
  expect(readFileSync(join(BROWNFIELD, "zod/proof/differs.ts"), "utf8")).toBe(differs);
  expect(recipe).toContain(`\`\`\`ts\n${differs}\`\`\``);
  const python = readFileSync(join(BROWNFIELD, "pydantic/proof/test_equivalence.py"), "utf8");
  const body = python.slice(python.indexOf("from typing import Any"));
  expect(recipe).toContain(`\`\`\`python\n${body}\`\`\``);
});

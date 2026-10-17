// test/agent-context/codegen-skill-overwrite-claim.test.ts
//
// Pins two corrections to `metaobjects-codegen/SKILL.md` found by a product audit
// (docs/features/codegen-concepts.md §7 + own-your-codegen.md are the source of truth):
//
// 1. The overwrite-policy claim used to be stated as one universal rule ("refuses any
//    file that does NOT carry the `@generated` header; overwrites the ones that do").
//    That was true for TypeScript until the mechanism changed to a hash manifest on
//    2026-08-17, and it was never true for C#/Python. It remains true for Java/Kotlin
//    only. Stating it unqualified told an adopter that deleting the header takes
//    ownership of a TypeScript/C#/Python file — backwards, since editing the content
//    (which breaks the hash) is what takes ownership there. From Maven 8.1.0 (ADR-0059)
//    Java and Kotlin use the same manifest, so the skill now states one rule for every
//    port and names the JVM's one difference: a first-run adoption of files carrying the
//    `GENERATED` token.
// 2. The skill's only cross-reference to `docs/features/codegen-concepts.md` pointed at
//    §3/§10 (authoring mechanisms), never at §5-§7, which is where the write-once /
//    base-plus-extension question is actually answered.
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveAgentContextRoot } from "../../src/agent-context/content-root.js";

function readSkill(name: string): string {
  return readFileSync(join(resolveAgentContextRoot(), "skills", name, "SKILL.md"), "utf8");
}

test("the skill does not state the retired header-ownership overwrite claim", () => {
  const skill = readSkill("metaobjects-codegen");
  // The retired claim. Stating it unqualified told an adopter that deleting the header
  // takes ownership of a file, which is backwards on every port now.
  expect(skill).not.toMatch(/Refuses to overwrite any file that does NOT carry the `@generated` header/);
  // The 8.0.x JVM rule (the marker decides, removing it takes ownership) is retired too.
  expect(skill).not.toMatch(/Remove that token and\s+regeneration never touches the file again/);
});

test("the skill points at the sections that answer the write-once question", () => {
  // codegen-concepts.md §5-§7 is where "MetaObjects ships exactly one hand-edit
  // strategy, no shipped generator emits a base/extension pair, and no write path is
  // write-if-absent" is stated. The skill cross-referenced that file but only at §3/§10,
  // so an agent following the pointer never arrived at the answer.
  const skill = readSkill("metaobjects-codegen");
  expect(skill).toMatch(/§5-§7|§5–§7/);
  expect(skill).toMatch(/write-if-absent/);
});

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
//    (which breaks the hash) is what takes ownership there.
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

test("the skill states the overwrite policy PER PORT, not as one universal rule", () => {
  const skill = readSkill("metaobjects-codegen");
  // The retired claim. It was true for TS until 2026-08-17 and is still true for the
  // JVM, which is exactly why stating it unqualified is worse than stating nothing.
  expect(skill).not.toMatch(/Refuses to overwrite any file that does NOT carry the `@generated` header/);
  // The hash manifest is what actually decides in three of five ports; an adopter who
  // does not know that will delete the header and believe the file is theirs.
  expect(skill).toMatch(/hash manifest/i);
  // The per-port split has to name both halves, or a reader still walks away thinking
  // one rule covers every port.
  expect(skill).toMatch(/TypeScript,\s*C#,\s*Python/);
  expect(skill).toMatch(/Java,\s*Kotlin/);
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

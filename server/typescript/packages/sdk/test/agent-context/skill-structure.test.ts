// test/agent-context/skill-structure.test.ts
//
// The shape Anthropic's skill-authoring guidance asks for, enforced on the shipped skills
// rather than left to whoever edits one next: a SKILL.md body under 500 lines, a contents
// list at the top of every long reference file, and every reference file reachable from its
// SKILL.md in one hop (a reference linked only from another reference is read partially).
import { test, expect, describe } from "bun:test";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const SKILLS_ROOT = join(import.meta.dir, "../../../../../../agent-context/skills");
const SKILLS = readdirSync(SKILLS_ROOT).sort();

const lineCount = (text: string): number => text.replace(/\n$/, "").split("\n").length;
const referenceFiles = (skill: string): string[] => {
  const dir = join(SKILLS_ROOT, skill, "references");
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")).sort() : [];
};

describe("shipped skill structure", () => {
  test("there are skills to check", () => {
    expect(SKILLS.length).toBeGreaterThanOrEqual(7);
  });

  test("every SKILL.md is under 500 lines", () => {
    const over = SKILLS.filter((s) => lineCount(readFileSync(join(SKILLS_ROOT, s, "SKILL.md"), "utf8")) > 500);
    expect(over).toEqual([]);
  });

  test("every reference file over 100 lines opens with a `## Contents` list", () => {
    const missing: string[] = [];
    for (const skill of SKILLS) {
      for (const file of referenceFiles(skill)) {
        const text = readFileSync(join(SKILLS_ROOT, skill, "references", file), "utf8");
        if (lineCount(text) <= 100) continue;
        const head = text.split("\n").slice(0, 40);
        if (!head.some((l) => /^## Contents\s*$/.test(l))) missing.push(`${skill}/references/${file}`);
      }
    }
    expect(missing).toEqual([]);
  });

  test("every reference file is named in its own SKILL.md (one hop, not two)", () => {
    const unlinked: string[] = [];
    for (const skill of SKILLS) {
      const body = readFileSync(join(SKILLS_ROOT, skill, "SKILL.md"), "utf8");
      for (const file of referenceFiles(skill)) {
        if (!body.includes(file)) unlinked.push(`${skill}/references/${file}`);
      }
    }
    expect(unlinked).toEqual([]);
  });
});

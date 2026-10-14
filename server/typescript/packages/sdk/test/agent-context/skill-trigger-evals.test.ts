// test/agent-context/skill-trigger-evals.test.ts
//
// The trigger evaluation itself drives live model sessions and cannot run in CI
// (agent-context/evals/README.md has the manual command). This keeps the part that is
// deterministic: every case parses, names a skill that exists, and each skill carries
// both should-trigger and should-not-trigger cases.
import { test, expect, describe } from "bun:test";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const AGENT_CONTEXT = join(import.meta.dir, "../../../../../../agent-context");
const SKILLS = new Set(readdirSync(join(AGENT_CONTEXT, "skills")));
const EVALS = join(AGENT_CONTEXT, "evals/skill-triggers");

const frontmatter = (text: string): Record<string, string> => {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) throw new Error("no frontmatter");
  const out: Record<string, string> = {};
  for (const line of m[1]!.split("\n")) {
    const kv = /^([A-Za-z_]+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]!] = kv[2]!;
  }
  return out;
};

const cases = readdirSync(EVALS).flatMap((skill) =>
  readdirSync(join(EVALS, skill)).map((name) => ({ skill, name, dir: join(EVALS, skill, name) })),
);

describe("skill trigger eval cases", () => {
  test("only the two evaluated skills have case sets", () => {
    expect(readdirSync(EVALS).sort()).toEqual(["metaobjects-codegen", "metaobjects-prompts"]);
  });

  test("every case directory parses and names an existing skill", () => {
    for (const c of cases) {
      expect(SKILLS.has(c.skill)).toBe(true);
      const prompt = join(c.dir, "prompt.md");
      expect(existsSync(prompt)).toBe(true);
      const body = readFileSync(prompt, "utf8").replace(/^---\n[\s\S]*?\n---\n/, "").trim();
      expect(body.length).toBeGreaterThan(0);
      const graders = readdirSync(join(c.dir, "graders"));
      expect(graders.length).toBeGreaterThan(0);
      for (const g of graders) {
        const fm = frontmatter(readFileSync(join(c.dir, "graders", g), "utf8"));
        expect(fm.type).toBe("tool_used");
        expect(fm.tool).toBe("Skill");
        expect(fm.input_match).toBe(c.skill);
      }
    }
  });

  test("each skill has should-trigger and should-not-trigger cases", () => {
    for (const skill of readdirSync(EVALS)) {
      const kinds = cases.filter((c) => c.skill === skill).map((c) => (c.name.includes("-pos-") ? "pos" : "neg"));
      expect(kinds.filter((k) => k === "pos").length).toBeGreaterThanOrEqual(5);
      expect(kinds.filter((k) => k === "neg").length).toBeGreaterThanOrEqual(5);
    }
  });

  test("positive cases require a firing, negative cases forbid one", () => {
    for (const c of cases) {
      const fm = frontmatter(readFileSync(join(c.dir, "graders", "trigger.md"), "utf8"));
      if (c.name.includes("-pos-")) expect(fm.min).toBe("1");
      else expect([fm.min, fm.max]).toEqual(["0", "0"]);
    }
  });
});

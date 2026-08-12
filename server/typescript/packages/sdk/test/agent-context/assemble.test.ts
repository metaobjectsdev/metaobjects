// test/agent-context/assemble.test.ts
import { test, expect, describe } from "bun:test";
import { join } from "node:path";
import { assemble } from "../../src/agent-context/assemble.js";
import { makeStack } from "../../src/agent-context/resolve.js";

const CONTENT_ROOT = join(import.meta.dir, "../../../../../../agent-context"); // test/agent-context/ → repo root is 6 levels up

function paths(files: { path: string }[]): string[] {
  return files.map((f) => f.path).sort();
}

describe("assemble", () => {
  test("emits AGENTS.md + CLAUDE.md with the stack line + codegen command substituted", () => {
    const stack = makeStack(["typescript"], ["react"]);
    const files = assemble({ contentRoot: CONTENT_ROOT, stack });
    const agents = files.find((f) => f.path === ".metaobjects/AGENTS.md")!;
    const claude = files.find((f) => f.path === ".metaobjects/CLAUDE.md")!;
    expect(agents).toBeDefined();
    expect(claude.contents).toBe(agents.contents);
    expect(agents.contents).not.toContain("{{stackLine}}");
    expect(agents.contents).not.toContain("{{codegenCommand}}");
    expect(agents.contents).toContain("npx meta gen");
    expect(agents.contents.toLowerCase()).toContain("typescript");
    expect(agents.contents.toLowerCase()).toContain("react");
  });

  test("stack-scoped: installs only the stack's language/framework reference fragments", () => {
    const stack = makeStack(["typescript"], ["react"]); // a narrow stack...
    const p = paths(assemble({ contentRoot: CONTENT_ROOT, stack }));
    // ...gets only its own language's codegen reference, not the others:
    expect(p).toContain(".claude/skills/metaobjects-codegen/references/typescript.md");
    expect(p).not.toContain(".claude/skills/metaobjects-codegen/references/java.md");
    expect(p).not.toContain(".claude/skills/metaobjects-codegen/references/kotlin.md");
    expect(p).not.toContain(".claude/skills/metaobjects-codegen/references/csharp.md");
    expect(p).not.toContain(".claude/skills/metaobjects-codegen/references/python.md");
    // ...its client ref, not the client frameworks it doesn't use:
    expect(p).toContain(".claude/skills/metaobjects-runtime-ui/references/react.md");
    expect(p).not.toContain(".claude/skills/metaobjects-runtime-ui/references/tanstack.md");
    // universal (non-language) fragments always install:
    expect(p).toContain(".claude/skills/metaobjects-verify/references/migration.md");
    expect(p).toContain(".claude/skills/metaobjects-audit/references/capability-checklist.md");
    for (const s of ["authoring", "codegen", "runtime-ui", "prompts", "verify"]) {
      expect(p).toContain(`.claude/skills/metaobjects-${s}/SKILL.md`);
    }
  });

  test("a java-only stack gets its java references, not other languages or unused clients", () => {
    const p = paths(assemble({ contentRoot: CONTENT_ROOT, stack: makeStack(["java"], []) }));
    expect(p).toContain(".claude/skills/metaobjects-codegen/references/java.md");
    expect(p).not.toContain(".claude/skills/metaobjects-codegen/references/typescript.md");
    // its language fragment in every skill that has one:
    expect(p).toContain(".claude/skills/metaobjects-runtime-ui/references/java.md");
    // no client in the stack → no client-framework refs:
    expect(p).not.toContain(".claude/skills/metaobjects-runtime-ui/references/react.md");
    expect(p).not.toContain(".claude/skills/metaobjects-runtime-ui/references/tanstack.md");
    // universal fragments still present:
    expect(p).toContain(".claude/skills/metaobjects-verify/references/migration.md");
  });

  test("a kotlin-primary stack assembles without throwing and uses the kotlin codegen command", () => {
    const stack = makeStack(["kotlin"], []);
    const files = assemble({ contentRoot: CONTENT_ROOT, stack });
    const agents = files.find((f) => f.path === ".metaobjects/AGENTS.md")!;
    expect(agents.contents.toLowerCase()).toContain("kotlin");
    expect(agents.contents).toContain("mvn metaobjects:generate");
  });

  test("a stack whose primary server has no meta file falls back to a default codegen command (no throw)", () => {
    // csharp.meta.json exists now, but the guard must not throw even if a meta file were absent.
    const stack = makeStack(["csharp"], []);
    expect(() => assemble({ contentRoot: CONTENT_ROOT, stack })).not.toThrow();
  });

  test("requirements concern: the gated fragment installs only when the token is present", () => {
    const withReq = paths(assemble({ contentRoot: CONTENT_ROOT, stack: makeStack(["typescript"], [], ["requirements"]) }));
    const withoutReq = paths(assemble({ contentRoot: CONTENT_ROOT, stack: makeStack(["typescript"], []) }));
    expect(withReq).toContain(".claude/skills/metaobjects-authoring/references/requirements.md");
    expect(withoutReq).not.toContain(".claude/skills/metaobjects-authoring/references/requirements.md");
    // an unrelated stack-scoped fragment is unaffected by the concern axis:
    expect(withoutReq).toContain(".claude/skills/metaobjects-codegen/references/typescript.md");
  });

  test("output is deterministic (stable order + identical across runs)", () => {
    const stack = makeStack(["typescript"], ["react"]);
    const a = assemble({ contentRoot: CONTENT_ROOT, stack });
    const b = assemble({ contentRoot: CONTENT_ROOT, stack });
    expect(a).toEqual(b);
    expect(a.map((f) => f.path)).toEqual([...a.map((f) => f.path)].sort());
  });
});

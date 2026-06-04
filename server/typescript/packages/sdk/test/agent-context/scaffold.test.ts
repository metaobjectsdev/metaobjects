import { test, expect, describe } from "bun:test";
import { hashContents, planScaffold, AGENT_CONTEXT_MANIFEST_PATH, type Manifest } from "../../src/agent-context/scaffold.js";
import { makeStack } from "../../src/agent-context/resolve.js";
import type { AssembledFile } from "../../src/agent-context/types.js";

const stack = makeStack(["typescript"], ["react"]);
const files: AssembledFile[] = [
  { path: ".metaobjects/AGENTS.md", contents: "always-on v2" },
  { path: ".claude/skills/metaobjects-codegen/SKILL.md", contents: "---\nname: x\n---\nbody v2" },
];

describe("planScaffold", () => {
  test("manifest path is the dotfile under .metaobjects", () => {
    expect(AGENT_CONTEXT_MANIFEST_PATH).toBe(".metaobjects/.agent-context.json");
  });

  test("all-new project: every file is a write; manifest records hashes; no conflicts", () => {
    const d = planScaffold({ stack, assembled: files, prior: undefined, readCurrent: () => undefined });
    expect(d.writes.map((w) => w.path).sort()).toEqual(files.map((f) => f.path).sort());
    expect(d.conflicts).toEqual([]);
    expect(d.manifest.files[".metaobjects/AGENTS.md"]).toBe(hashContents("always-on v2"));
    expect(d.manifest.servers).toEqual(["typescript"]);
    expect(d.manifest.clients).toEqual(["react"]);
  });

  test("unmodified file (on-disk hash matches prior manifest) → overwrite, not conflict", () => {
    const prior: Manifest = { version: 1, servers: ["typescript"], clients: ["react"], files: { ".metaobjects/AGENTS.md": hashContents("always-on v1") } };
    const d = planScaffold({
      stack, assembled: [files[0]!], prior,
      readCurrent: (p) => (p === ".metaobjects/AGENTS.md" ? "always-on v1" : undefined),
    });
    expect(d.writes.map((w) => w.path)).toEqual([".metaobjects/AGENTS.md"]);
    expect(d.conflicts).toEqual([]);
  });

  test("hand-edited file (on-disk differs from prior hash) → .new conflict + keep original", () => {
    const prior: Manifest = { version: 1, servers: ["typescript"], clients: ["react"], files: { ".metaobjects/AGENTS.md": hashContents("always-on v1") } };
    const d = planScaffold({
      stack, assembled: [files[0]!], prior,
      readCurrent: () => "I HAND EDITED THIS",
    });
    expect(d.writes).toEqual([]);
    expect(d.conflicts).toEqual([{ path: ".metaobjects/AGENTS.md", newPath: ".metaobjects/AGENTS.md.new", contents: "always-on v2" }]);
  });

  test("file present but no prior manifest record → treat as hand-edited (.new), never clobber", () => {
    const d = planScaffold({ stack, assembled: [files[0]!], prior: undefined, readCurrent: () => "pre-existing unknown" });
    expect(d.conflicts.map((c) => c.path)).toEqual([".metaobjects/AGENTS.md"]);
  });

  test("a file in the prior manifest no longer assembled (stack shrank) is reported as removed", () => {
    const prior: Manifest = { version: 1, servers: ["typescript", "java"], clients: ["react"], files: { ".claude/skills/metaobjects-codegen/references/java.md": "abc" } };
    const d = planScaffold({ stack, assembled: files, prior, readCurrent: () => undefined });
    expect(d.removed).toEqual([".claude/skills/metaobjects-codegen/references/java.md"]);
  });
});

import { test, expect } from "bun:test";
import { run } from "../src/index.js";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("meta agent-docs --server csharp scaffolds the agent-context (no metaobjects/ project)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "meta-agentdocs-"));
  const code = await run(["agent-docs", "--server", "csharp", "--cwd", dir]);
  expect(code).toBe(0);
  expect(existsSync(join(dir, ".claude/skills/metaobjects-codegen/references/csharp.md"))).toBe(true);
  expect(existsSync(join(dir, ".claude/skills/metaobjects-codegen/references/python.md"))).toBe(true); // deploy-all
  expect(existsSync(join(dir, ".metaobjects/AGENTS.md"))).toBe(true);
  // codegenCommand for csharp comes from servers/csharp.meta.json
  expect(require("node:fs").readFileSync(join(dir, ".metaobjects/AGENTS.md"), "utf8")).toContain("dotnet meta gen");
});

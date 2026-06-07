// test/agent-context/size-gate.test.ts
import { test, expect } from "bun:test";
import { join } from "node:path";
import { assemble } from "../../src/agent-context/assemble.js";
import { makeStack } from "../../src/agent-context/resolve.js";

const CONTENT_ROOT = join(import.meta.dir, "../../../../../../agent-context");

test("the always-on body stays <= 120 lines (cheap to import into a root CLAUDE.md)", () => {
  const files = assemble({ contentRoot: CONTENT_ROOT, stack: makeStack(["typescript"], ["react", "tanstack"]) });
  const agents = files.find((f) => f.path === ".metaobjects/AGENTS.md")!;
  const lines = agents.contents.split("\n").length;
  expect(lines).toBeLessThanOrEqual(120);
});

// A stack change leaves fragments behind. `meta init --refresh-docs --server typescript`
// on a project scaffolded as python used to leave `python.md` on disk forever — reported
// once as "orphaned (safe to delete)" and never mentioned again — while every SKILL.md
// footer told the reader to read every `references/*.md` file in the directory, "one per
// server language in this project's stack". So the context instructed an agent to read
// guidance for a language the project no longer uses.
//
// This is the real gap behind #351, which reported the inverse symptom (a python fragment
// present in a TypeScript project) and was otherwise not reproducible: stack-scoped
// selection is correct, and this is the ONLY path that puts one there.
//
// Deleting is gated on the same hash predicate that already decides overwrite-vs-.new:
// a fragment we wrote and nobody edited is ours to remove; a hand-edited one never is.
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init } from "../../src/commands/init.js";

let cwd: string;
beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), "init-orphan-")); });
afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });

const PY = ".claude/skills/metaobjects-codegen/references/python.md";
const TS = ".claude/skills/metaobjects-codegen/references/typescript.md";
const MANIFEST = ".metaobjects/.agent-context.json";

describe("meta init — a fragment the stack no longer uses", () => {
  test("an untouched orphan is deleted, and the new fragment installs", async () => {
    await init({ cwd, servers: ["python"], clients: [] });
    expect(existsSync(join(cwd, PY))).toBe(true);

    const r = await init({ cwd, servers: ["typescript"], clients: [], refreshDocs: true });

    expect(existsSync(join(cwd, TS))).toBe(true);
    expect(existsSync(join(cwd, PY))).toBe(false);
    expect(r.removed).toContain(PY);
    // Deleted, not merely announced: nothing should tell the user to go do it by hand.
    expect(r.warnings.join("\n")).not.toContain(PY);
  });

  test("a pruned orphan leaves the manifest, so it is not re-reported forever", async () => {
    await init({ cwd, servers: ["python"], clients: [] });
    await init({ cwd, servers: ["typescript"], clients: [], refreshDocs: true });
    const manifest = JSON.parse(readFileSync(join(cwd, MANIFEST), "utf8")) as { files: Record<string, string> };
    expect(Object.keys(manifest.files)).not.toContain(PY);
    expect(Object.keys(manifest.files)).toContain(TS);
  });

  test("a HAND-EDITED orphan is kept, and the run says why and what to do", async () => {
    await init({ cwd, servers: ["python"], clients: [] });
    writeFileSync(join(cwd, PY), "# my own notes about the python port\n", "utf8");

    const r = await init({ cwd, servers: ["typescript"], clients: [], refreshDocs: true });

    // Losing an adopter's writing is worse than leaving a stale file behind.
    expect(existsSync(join(cwd, PY))).toBe(true);
    expect(readFileSync(join(cwd, PY), "utf8")).toContain("my own notes");
    expect(r.removed).not.toContain(PY);
    const warning = r.warnings.find((w) => w.includes(PY));
    expect(warning).toBeDefined();
    expect(warning).toContain("hand-edited");
  });

  test("--print-only deletes nothing", async () => {
    await init({ cwd, servers: ["python"], clients: [] });
    await init({ cwd, servers: ["typescript"], clients: [], refreshDocs: true, printOnly: true });
    // A dry run that removed a file would be claiming a preview while acting.
    expect(existsSync(join(cwd, PY))).toBe(true);
  });

  test("a stack that changes nothing prunes nothing", async () => {
    await init({ cwd, servers: ["python"], clients: [] });
    const r = await init({ cwd, servers: ["python"], clients: [], refreshDocs: true });
    expect(r.removed).toEqual([]);
    expect(existsSync(join(cwd, PY))).toBe(true);
  });
});

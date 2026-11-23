import { describe, test, expect } from "bun:test";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { makeScratchDir, removeTree, scratchRoot } from "../src/scratch-dir.js";

describe("scratch-dir", () => {
  test("makeScratchDir is unique, under the scratch root, and removeTree clears a populated tree", () => {
    const a = makeScratchDir("scratch-dir-test-");
    const b = makeScratchDir("scratch-dir-test-");
    expect(a).not.toBe(b);
    expect(a.startsWith(scratchRoot())).toBe(true);
    mkdirSync(join(a, "x", "y"), { recursive: true });
    writeFileSync(join(a, "x", "y", "f.txt"), "1");
    removeTree(a);
    removeTree(b);
    expect(existsSync(a)).toBe(false);
    expect(existsSync(b)).toBe(false);
  });

  test("removeTree of an absent path is not an error", () => {
    const a = makeScratchDir("scratch-dir-test-");
    removeTree(a);
    expect(() => removeTree(a)).not.toThrow();
  });

  // A run with no project keeps its gen-state in the scratch root for the process's later runs.
  // Before this, every such process left `meta-gen-state-<pid>` behind for good, and the test
  // harnesses that generate with no project filled a RAM-backed scratch root with them.
  test("a run with no project leaves no gen-state behind once its process exits", () => {
    const root = makeScratchDir("scratch-dir-exit-");
    try {
      const runner = resolve(import.meta.dir, "../src/runner.ts");
      writeFileSync(join(root, "meta.t.json"), JSON.stringify({ "metadata.root": { package: "t", children: [{ "object.entity": { name: "Thing", children: [{ "field.string": { name: "label" } }] } }] } }));
      const script = `
        import { runGen } from ${JSON.stringify(runner)};
        import { loadUris } from "@metaobjectsdev/metadata";
        import { pathToFileURL } from "node:url";
        const { root: metadata } = await loadUris([pathToFileURL(${JSON.stringify(join(root, "meta.t.json"))}).href]);
        const out = ${JSON.stringify(join(root, "out"))};
        await runGen({ metadata, config: { outDir: out, generators: [{ name: "one", generate: () => [{ path: "one.txt", content: "1" }] }] } });
        const state = (await import("node:fs")).readdirSync(${JSON.stringify(root)}).filter((n) => n.startsWith("meta-gen-state-"));
        if (state.length !== 1) throw new Error("expected the run's gen-state while the process runs, found " + (await import("node:fs")).readdirSync(${JSON.stringify(root)}).join(","));
      `;
      const child = Bun.spawnSync(["bun", "-e", script], { env: { ...process.env, DEV_SCRATCH: root }, stderr: "pipe" });
      expect({ exit: child.exitCode, stderr: child.stderr.toString() }).toEqual({ exit: 0, stderr: "" });
      expect(existsSync(join(root, "out", "one.txt"))).toBe(true);
      expect(readdirSync(root).filter((n) => n.startsWith("meta-gen-"))).toEqual([]);
    } finally {
      removeTree(root);
    }
  });
});

// A generator or owned template that throws reaches `meta gen` wrapped by the runner as
// `[<generator>] <message>`, with the original throw as `cause`. `meta gen` used to print only the
// wrapper's message, so an owned template broken by an engine API change (1.3.0's
// `valueObjectModuleSpecifier`, found by a downstream pre-release check) read as a bare
// "node.resolutionKey is not a function" with nothing naming the file that threw. It now prints
// the cause and the frame it was thrown at, and the whole stack under --verbose.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { run } from "../src/index.js";
import { describeErrorCause } from "../src/lib/error-text.js";

const WORKSPACE_TMP = resolve(import.meta.dirname, "fixtures", "__tmp__");

function setupRepo(): string {
  mkdirSync(WORKSPACE_TMP, { recursive: true });
  const root = mkdtempSync(join(WORKSPACE_TMP, "gen-throw-cause-"));
  mkdirSync(join(root, "metaobjects"), { recursive: true });
  writeFileSync(join(root, "metaobjects", "meta.app.json"), JSON.stringify({
    "metadata.root": { package: "app", children: [
      { "object.entity": { name: "Note", children: [
        { "source.rdb": { "@table": "notes" } }, { "field.long": { name: "id" } },
        { "identity.primary": { "@fields": "id" } } ] } },
    ] },
  }), "utf8");
  mkdirSync(join(root, ".metaobjects"), { recursive: true });
  writeFileSync(join(root, ".metaobjects", "config.json"), JSON.stringify({ schema_version: 1, sources: [] }), "utf8");
  // An owned template in its own file, so the frame `meta gen` prints names it.
  mkdirSync(join(root, "codegen"), { recursive: true });
  writeFileSync(join(root, "codegen", "broken-template.ts"), `
export function renderBroken(): string {
  const node = {} as { resolutionKey: () => string };
  return node.resolutionKey();
}
`);
  writeFileSync(join(root, "metaobjects.config.ts"), `
import { defineConfig } from "@metaobjectsdev/codegen-ts";
import { renderBroken } from "./codegen/broken-template";
export default defineConfig({
  outDir: ${JSON.stringify(join(root, "generated"))},
  dialect: "postgres",
  extStyle: "none",
  generators: [{ name: "owned-broken", generate: () => [{ path: "x.ts", content: renderBroken() }] }],
});
`);
  return root;
}

let out: string[];
let err: string[];
let origLog: typeof console.log;
let origErr: typeof console.error;
beforeEach(() => {
  out = [];
  err = [];
  origLog = console.log;
  origErr = console.error;
  console.log = (...a: unknown[]) => { out.push(a.map(String).join(" ")); };
  console.error = (...a: unknown[]) => { err.push(a.map(String).join(" ")); };
});
afterEach(() => {
  console.log = origLog;
  console.error = origErr;
});

describe("meta gen — a generator throw names its cause", () => {
  test("prints the cause, the frame it was thrown at and the --verbose hint", async () => {
    const root = setupRepo();
    try {
      expect(await run(["gen", "--cwd", root, "--format", "text"])).toBe(1);
      const text = err.join("\n");
      expect(text).toMatch(/gen failed: \[owned-broken\] .*resolutionKey is not a function/);
      // The runtime's own wording follows the message; the frame closes the line.
      expect(text).toMatch(/caused by: TypeError: .*resolutionKey is not a function.* \(at .*broken-template\.ts:\d+:\d+\)\)?$/m);
      expect(text).toContain("run again with --verbose for the full stack");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("--verbose prints the stack of the error the template threw", async () => {
    const root = setupRepo();
    try {
      expect(await run(["gen", "--cwd", root, "--format", "text", "--verbose"])).toBe(1);
      const text = err.join("\n");
      expect(text).toMatch(/caused by: TypeError: .*resolutionKey is not a function/);
      expect(text).toMatch(/^(meta: )? {4}at .*broken-template\.ts/m);
      expect(text).not.toContain("run again with --verbose");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("describeErrorCause", () => {
  test("an error with no cause adds nothing, and only its stack under verbose", () => {
    const e = new Error("plain");
    expect(describeErrorCause(e, false)).toEqual([]);
    expect(describeErrorCause(e, true).every((l) => l.startsWith("    at "))).toBe(true);
  });

  test("walks the whole cause chain and stops on a cycle", () => {
    const inner = new RangeError("inner");
    const mid = new Error("mid", { cause: inner });
    const outer = new Error("outer", { cause: mid });
    (inner as { cause?: unknown }).cause = outer;
    const lines = describeErrorCause(outer, false);
    expect(lines.filter((l) => l.startsWith("caused by:")).map((l) => l.replace(/ \(at .*\)$/, ""))).toEqual([
      "caused by: Error: mid",
      "caused by: RangeError: inner",
    ]);
  });

  test("a non-Error cause is printed as text", () => {
    expect(describeErrorCause(new Error("x", { cause: "socket closed" }), false)[0]).toBe("caused by: socket closed");
  });
});

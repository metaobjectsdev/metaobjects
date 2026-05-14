import { describe, test, expect } from "bun:test";
import { parseInitArgs } from "../src/lib/args.js";
import { run } from "../src/index.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("parseInitArgs", () => {
  test("default flags are all false", () => {
    expect(parseInitArgs([])).toEqual({ force: false, quiet: false, printOnly: false, refreshDocs: false });
  });
  test("--force toggles force", () => {
    expect(parseInitArgs(["--force"])).toEqual({ force: true, quiet: false, printOnly: false, refreshDocs: false });
  });
  test("--quiet toggles quiet", () => {
    expect(parseInitArgs(["--quiet"])).toEqual({ force: false, quiet: true, printOnly: false, refreshDocs: false });
  });
  test("--print-only toggles printOnly", () => {
    expect(parseInitArgs(["--print-only"])).toEqual({ force: false, quiet: false, printOnly: true, refreshDocs: false });
  });
  test("multiple flags compose", () => {
    expect(parseInitArgs(["--force", "--quiet"])).toEqual({
      force: true,
      quiet: true,
      printOnly: false,
      refreshDocs: false,
    });
  });
  test("throws on unknown flag", () => {
    expect(() => parseInitArgs(["--foo"])).toThrow();
  });
});

describe("run() — top-level dispatcher", () => {
  test("returns 0 for --version", async () => {
    expect(await run(["--version"])).toBe(0);
  });
  test("returns 0 for -v", async () => {
    expect(await run(["-v"])).toBe(0);
  });
  test("returns 0 for --help", async () => {
    expect(await run(["--help"])).toBe(0);
  });
  test("returns 0 for -h", async () => {
    expect(await run(["-h"])).toBe(0);
  });
  test("returns 0 for no args (prints help)", async () => {
    expect(await run([])).toBe(0);
  });
  test("returns 2 for unknown command", async () => {
    expect(await run(["bogus"])).toBe(2);
  });
  test("dispatches init", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "metaobjects-run-"));
    const orig = process.cwd();
    process.chdir(tmp);
    try {
      expect(await run(["init"])).toBe(0);
    } finally {
      process.chdir(orig);
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("dispatches gen (returns 2 without metaobjects/ dir)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "metaobjects-run-gen-"));
    const orig = process.cwd();
    process.chdir(tmp);
    try {
      expect(await run(["gen"])).toBe(2);
    } finally {
      process.chdir(orig);
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("dispatches migrate (returns 2 outside .meta/ context with no config)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "metaobjects-run-migrate-"));
    const orig = process.cwd();
    process.chdir(tmp);
    try {
      expect(await run(["migrate"])).toBe(2);
    } finally {
      process.chdir(orig);
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("snapshot stability", () => {
  test("help output is stable", async () => {
    const captured: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => { captured.push(msg); };
    try {
      await run(["--help"]);
    } finally {
      console.log = origLog;
    }
    expect(captured.join("\n")).toMatchSnapshot();
  });

  test("version output is stable", async () => {
    const captured: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => { captured.push(msg); };
    try {
      await run(["--version"]);
    } finally {
      console.log = origLog;
    }
    expect(captured.join("\n")).toMatchSnapshot();
  });
});

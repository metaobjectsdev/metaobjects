import { test, expect } from "bun:test";
import { run } from "../src/index.js";

test("each subcommand supports --help and exits 0", async () => {
  for (const c of ["gen", "migrate", "verify", "export", "docs", "init"]) {
    expect(await run([c, "--help"])).toBe(0);
  }
});

test("each subcommand supports -h and exits 0", async () => {
  for (const c of ["gen", "verify", "export", "docs", "init"]) {
    expect(await run([c, "-h"])).toBe(0);
  }
});

test("prompt-snapshot supports --help and exits 0", async () => {
  expect(await run(["prompt-snapshot", "--help"])).toBe(0);
});

test("prompt-snapshot supports -h and exits 0", async () => {
  expect(await run(["prompt-snapshot", "-h"])).toBe(0);
});

test("unknown command exits 2 (usage error)", async () => {
  expect(await run(["bogus"])).toBe(2);
});

test("bare meta (no args) exits 0", async () => {
  expect(await run([])).toBe(0);
});

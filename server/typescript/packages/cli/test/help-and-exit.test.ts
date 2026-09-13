import { test, expect, spyOn } from "bun:test";
import { run } from "../src/index.js";

// These assert EXIT CODES (help/usage handling), not performance — so they must
// not be timing-sensitive. `run()` lazily imports each command's (sometimes heavy:
// migrate-ts, codegen) module on first dispatch; on a cold/contended CI runner that
// first cold-start import can exceed bun's default 5s test timeout, flaking the
// suite even though every call returns instantly once warm (~115ms for the whole
// file locally). A generous explicit timeout eliminates that flake while still
// failing loudly on a genuine hang or wrong exit code.
const HELP_TIMEOUT_MS = 30_000;

test("each subcommand supports --help and exits 0", async () => {
  for (const c of ["gen", "migrate", "verify", "export", "docs", "init"]) {
    expect(await run([c, "--help"])).toBe(0);
  }
}, HELP_TIMEOUT_MS);

test("each subcommand supports -h and exits 0", async () => {
  for (const c of ["gen", "verify", "export", "docs", "init"]) {
    expect(await run([c, "-h"])).toBe(0);
  }
}, HELP_TIMEOUT_MS);

test("prompt-snapshot supports --help and exits 0", async () => {
  expect(await run(["prompt-snapshot", "--help"])).toBe(0);
}, HELP_TIMEOUT_MS);

test("prompt-snapshot supports -h and exits 0", async () => {
  expect(await run(["prompt-snapshot", "-h"])).toBe(0);
}, HELP_TIMEOUT_MS);

test("unknown command exits 2 (usage error)", async () => {
  expect(await run(["bogus"])).toBe(2);
}, HELP_TIMEOUT_MS);

test("bare meta (no args) exits 0", async () => {
  expect(await run([])).toBe(0);
}, HELP_TIMEOUT_MS);

// `meta eject --help` used to name a fixed COUNT of the generators `meta init`
// scaffolded eagerly — a literal that fell out of sync the moment the scaffold set grew
// from four to five, telling an adopter the names generator was eject-only when it had
// already been wired for them. The whole class of defect is gone: init scaffolds NONE,
// so there is no count to keep in step. What has to be true instead is that the help
// does not still claim otherwise — a stale sentence promising five generators would send
// a fresh adopter looking for files that are not there.
test("eject --help says init scaffolds nothing, and points at the catalog", async () => {
  const lines: string[] = [];
  const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  let exitCode: number;
  try {
    exitCode = await run(["eject", "--help"]);
  } finally {
    spy.mockRestore();
  }
  expect(exitCode).toBe(0);
  const helpText = lines.join("\n");

  expect(helpText).toContain("copies NO generators");
  expect(helpText).toContain("meta gen --list");
  // The retired claim, in either of the two spellings it ever had.
  expect(helpText).not.toContain("copies five generators");
  expect(helpText).not.toContain("copies four generators");
}, HELP_TIMEOUT_MS);

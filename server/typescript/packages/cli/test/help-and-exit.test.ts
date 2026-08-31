import { test, expect, spyOn } from "bun:test";
import { run } from "../src/index.js";
import { SCAFFOLDED_GENERATOR_NAMES } from "../src/commands/init.js";

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

// Finding 1 (fix round 1): `meta eject --help` used to name a fixed count of `meta
// init`'s eagerly-scaffolded generators — a literal that fell out of sync the moment
// Task 4 grew the scaffold set from four to five (adding "names"), telling an adopter
// the names generator was eject-only when it had already been scaffolded and wired for
// them. Deriving the expected text from SCAFFOLDED_GENERATOR_NAMES itself — rather than
// hardcoding "five" here, which would just move the same bug one level down — means the
// next person who extends the scaffold set cannot leave this string behind unnoticed.
const COUNT_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

test("eject --help enumerates every scaffolded generator name and states the count", async () => {
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

  const countWord = COUNT_WORDS[SCAFFOLDED_GENERATOR_NAMES.length];
  expect(countWord).toBeDefined();
  // Pins the count AND the exact, ordered enumeration in one assertion — a transposed
  // or dropped name fails this even if the bare count happens to still read right.
  expect(helpText).toContain(`${countWord} generators (${SCAFFOLDED_GENERATOR_NAMES.join(", ")})`);
}, HELP_TIMEOUT_MS);

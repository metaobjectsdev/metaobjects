// FR-023 Phase 1a, Task 14 — `parseDepsArgs` subverb + flag parsing.
//
// `meta deps` takes a required subverb positional (`sync | check | list`), any
// further positionals are dependency NAMES (a filter — only meaningful to
// `sync` in this task; `check` is Task 15's), and `--dry-run` is the one flag
// this task adds. `--format` is a GLOBAL flag `index.ts` strips before a
// command ever sees its argv (see `args.ts`'s `MIGRATE_OPTIONS` comment: "the
// flag is --migration-format, not --format: `--format` is already consumed by
// the top-level parser") — so, unlike the task brief's shorthand, DEPS_OPTIONS
// carries no "format" key; `meta deps` is format-aware the same way
// gen/verify/migrate are, via the `fmt` parameter `index.ts` passes to the
// command, not via its own parser.
import { describe, test, expect } from "bun:test";
import { parseDepsArgs } from "../../src/lib/args.js";

describe("parseDepsArgs", () => {
  test("sync with no names — dry-run defaults false", () => {
    expect(parseDepsArgs(["sync"])).toEqual({ subverb: "sync", names: [], dryRun: false });
  });

  test("sync with one or more dependency names", () => {
    expect(parseDepsArgs(["sync", "acme-common"])).toEqual({
      subverb: "sync",
      names: ["acme-common"],
      dryRun: false,
    });
    expect(parseDepsArgs(["sync", "acme-common", "other-lib"])).toEqual({
      subverb: "sync",
      names: ["acme-common", "other-lib"],
      dryRun: false,
    });
  });

  test("--dry-run", () => {
    expect(parseDepsArgs(["sync", "--dry-run"])).toEqual({
      subverb: "sync",
      names: [],
      dryRun: true,
    });
  });

  test("list", () => {
    expect(parseDepsArgs(["list"])).toEqual({ subverb: "list", names: [], dryRun: false });
  });

  test("check — parses; this task does not implement its behavior", () => {
    expect(parseDepsArgs(["check"])).toEqual({ subverb: "check", names: [], dryRun: false });
  });

  test("no subverb at all is a usage error", () => {
    expect(() => parseDepsArgs([])).toThrow(/subcommand/);
  });

  test("an unknown subverb is a usage error", () => {
    expect(() => parseDepsArgs(["bogus"])).toThrow(/unknown subcommand "bogus"/);
  });

  test("an unknown flag is a usage error", () => {
    expect(() => parseDepsArgs(["sync", "--foo"])).toThrow(/Unknown option '--foo'/);
  });
});

// Every flag the CLI ACCEPTS must be findable in that command's `--help`.
//
// Found on an adopter estate: `meta init` prints, on success, "Re-run
// --docs-only --refresh-docs to update" — and `--docs-only` was the one flag
// `meta init --help` did not list. The flag a user is explicitly told to type
// was the flag they could not look up. It was not alone: the same help omitted
// `--server`, `--client` and `--no-skills`, all of which the parser accepts and
// the command's own error messages recommend.
//
// The gate is DERIVED from the parser's own option table rather than from a
// second list of flag names kept beside it — a hand-kept list is the same defect
// one level up, and would go stale the first time someone adds a flag. Both
// halves are read from the shipping code: `*_OPTIONS` is the object
// `parseArgs` is actually called with, and `COMMAND_HELP` is the text `--help`
// actually prints.
//
// Deliberately one-directional: help may document MORE than the parser table
// (`--help` itself is not a parsed flag, and a command may document a positional
// or an env var). What it may not do is accept a flag it never mentions.

import { describe, expect, test } from "bun:test";

import {
  AGENT_DOCS_OPTIONS,
  DEPS_OPTIONS,
  EJECT_OPTIONS,
  EXPORT_OPTIONS,
  GEN_OPTIONS,
  INIT_OPTIONS,
  MIGRATE_OPTIONS,
  PROMPT_SNAPSHOT_OPTIONS,
  VERIFY_OPTIONS,
} from "../src/lib/args.js";
import { COMMAND_HELP } from "../src/index.js";
// `meta migrate` prints its own help from the command module rather than through
// COMMAND_HELP — it intercepts --help before the shared dispatch. The gate has to
// read the text the user actually sees, so it reads that one from its real home.
import { MIGRATE_HELP_TEXT } from "../src/commands/migrate.js";

/** command name in COMMAND_HELP → the flag table its parser is called with. */
const HELP_FOR: Readonly<Record<string, string | undefined>> = {
  ...COMMAND_HELP,
  migrate: MIGRATE_HELP_TEXT,
};

const COMMANDS: ReadonlyArray<readonly [string, Readonly<Record<string, unknown>>]> = [
  ["init", INIT_OPTIONS],
  ["agent-docs", AGENT_DOCS_OPTIONS],
  ["gen", GEN_OPTIONS],
  ["export", EXPORT_OPTIONS],
  ["verify", VERIFY_OPTIONS],
  ["prompt-snapshot", PROMPT_SNAPSHOT_OPTIONS],
  ["migrate", MIGRATE_OPTIONS],
  ["eject", EJECT_OPTIONS],
  ["deps", DEPS_OPTIONS],
];

describe("every accepted flag appears in its command's --help", () => {
  // Proves the table below reaches real help text at all: a typo'd command name
  // would otherwise make the per-command assertions vacuous.
  test("every command in the table has help text", () => {
    for (const [cmd] of COMMANDS) {
      expect(`${cmd}: ${typeof HELP_FOR[cmd]}`).toBe(`${cmd}: string`);
    }
  });

  for (const [cmd, options] of COMMANDS) {
    test(`meta ${cmd} --help documents all ${Object.keys(options).length} of its flags`, () => {
      const help = HELP_FOR[cmd] ?? "";
      const undocumented = Object.keys(options).filter(
        // Word-boundary matched: `--config` must not be satisfied by
        // `--config-only` appearing in the text.
        (flag) => !new RegExp(`--${flag}(?![A-Za-z0-9-])`).test(help),
      );
      expect(undocumented).toEqual([]);
    });
  }
});

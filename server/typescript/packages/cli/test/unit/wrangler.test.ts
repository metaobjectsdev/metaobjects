import { test, expect, describe } from "bun:test";
import { buildWranglerExecuteArgs, wranglerFailureReason } from "../../src/lib/wrangler.js";

describe("buildWranglerExecuteArgs", () => {
  test("local execution with command", () => {
    expect(buildWranglerExecuteArgs({
      binding: "DB",
      remote: false,
      command: "SELECT 1",
      configPath: "wrangler.toml",
    })).toEqual([
      "d1", "execute", "DB",
      "--local",
      "--json",
      "--command", "SELECT 1",
      "--config", "wrangler.toml",
    ]);
  });

  test("remote execution swaps --local for --remote", () => {
    const args = buildWranglerExecuteArgs({
      binding: "DB",
      remote: true,
      command: "SELECT 1",
      configPath: "wrangler.toml",
    });
    expect(args).toContain("--remote");
    expect(args).not.toContain("--local");
  });

  test("omits --config when configPath undefined", () => {
    const args = buildWranglerExecuteArgs({
      binding: "DB",
      remote: false,
      command: "SELECT 1",
      configPath: undefined,
    });
    expect(args).not.toContain("--config");
  });
});


// ── the failure REASON: wrangler --json puts its error on STDOUT ──────────────
//
// Found by running an estate's own `verify:prod-schema` gate against a live D1 for
// the first time. It failed, and the reason MetaObjects printed was:
//
//   failed to introspect D1 binding 'DB': wrangler d1 execute … failed:
//     ▲ [WARNING] Processing wrangler.toml configuration:
//       - "unsafe" fields are experimental and may change or break at any time.
//
// A WARNING, reported as the cause of a failure. The actual cause was on stdout,
// where `--json` puts it: "In a non-interactive environment, it's necessary to set a
// CLOUDFLARE_API_TOKEN environment variable". The runner read stderr and discarded
// stdout, so every adopter whose wrangler.toml warns about anything gets that warning
// named as the reason their schema gate failed.
describe("wranglerFailureReason", () => {
  const TOKEN_ERROR =
    "In a non-interactive environment, it's necessary to set a CLOUDFLARE_API_TOKEN environment variable";

  test("prefers the structured error wrangler --json writes to stdout", () => {
    const reason = wranglerFailureReason(
      JSON.stringify({ error: { text: TOKEN_ERROR } }),
      '▲ [WARNING] Processing wrangler.toml configuration:\n  - "unsafe" fields are experimental.\n',
      "Command failed with exit code 1",
    );
    expect(reason).toContain("CLOUDFLARE_API_TOKEN");
    // The warning must not be presented as the cause.
    expect(reason).not.toContain("experimental");
  });

  test("reads the array envelope shape too", () => {
    const reason = wranglerFailureReason(
      JSON.stringify([{ success: false, error: "no such table: Member" }]),
      "",
      "exit 1",
    );
    expect(reason).toBe("no such table: Member");
  });

  test("falls back to stderr when stdout carries no structured error", () => {
    const reason = wranglerFailureReason("", "Authentication error [code: 10000]\n", "exit 1");
    expect(reason).toBe("Authentication error [code: 10000]");
  });

  test("falls back to the process message when both streams are empty", () => {
    expect(wranglerFailureReason("", "", "Command failed with exit code 1"))
      .toBe("Command failed with exit code 1");
  });

  test("unparseable stdout does not swallow stderr", () => {
    const reason = wranglerFailureReason("not json at all", "real stderr cause\n", "exit 1");
    expect(reason).toBe("real stderr cause");
  });

  test("keeps stdout when it is the only thing that said anything", () => {
    // No structured error, no stderr — the raw stdout is still better than "exit 1".
    const reason = wranglerFailureReason("something went wrong upstream", "", "exit 1");
    expect(reason).toContain("something went wrong upstream");
  });
});

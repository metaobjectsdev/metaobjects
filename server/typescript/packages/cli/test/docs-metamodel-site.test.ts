// `meta docs --metamodel --site` accepted a flag it then dropped.
//
// The flag parsed, the command exited 0, and it wrote sixteen markdown files and zero
// HTML — so a reader asking for a site got a success message and no site. That is the
// failure mode this release keeps finding: the tool saying something untrue about work it
// had just done. `--metamodel` returns before the `--site` branch is ever reached.
//
// The fix is a REFUSAL, not an implementation. `--site` builds HTML from a MODEL through
// docs-site's own loader and templates; the metamodel surface is a different renderer over
// the registry, and there is no markdown renderer in the package to bridge them. Building
// one would add a rendering dependency to a published package for a single surface. The
// website renders it instead, keeping that dependency dev-only.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { docsCommand } from "../src/commands/docs.js";

const scratch = () => mkdtempSync(join(tmpdir(), "meta-docs-metamodel-"));

describe("meta docs --metamodel --site", () => {
  test("refuses explicitly rather than silently ignoring --site", async () => {
    const out = scratch();
    const exit = await docsCommand(["--metamodel", "--site", "--out", out], out);
    expect(exit).not.toBe(0);
  });

  test("writes NOTHING when it refuses — a refusal that half-ran is worse", async () => {
    // The original defect wrote sixteen files and reported success. A refusal that still
    // wrote them would leave the same misleading directory behind, with a non-zero exit
    // nobody reads in a script that only checks output exists.
    const out = scratch();
    await docsCommand(["--metamodel", "--site", "--out", out], out);
    expect(readdirSync(out)).toEqual([]);
  });

  test("--metamodel alone still writes the markdown pages", async () => {
    const out = scratch();
    const exit = await docsCommand(["--metamodel", "--out", out], out);
    expect(exit).toBe(0);
    // An explicit `--out` is the whole destination — the pages land directly in it, not
    // under an added `metamodel/` segment (that segment is part of the DEFAULT,
    // ./docs/metamodel). Asserted against what the command does, not what its comment says.
    expect(readdirSync(out)).toContain("INDEX.md");
    expect(readdirSync(join(out, "types")).length).toBeGreaterThan(10);
  });

  test("--site alone is untouched by the refusal", async () => {
    // The guard must be scoped to the COMBINATION. A `--site` run with no `--metamodel`
    // is the normal adopter path; a guard that fired on `--site` at all would break it.
    // Asserted on the message rather than the exit code, because `--site` in a scratch
    // directory fails for its own reason (no model to load) and both are non-zero — an
    // exit-code assertion would pass for the wrong reason.
    const out = scratch();
    const said: string[] = [];
    const real = console.error;
    console.error = (...a: unknown[]) => { said.push(a.join(" ")); };
    try {
      await docsCommand(["--site", "--out", out], out);
    } finally {
      console.error = real;
    }
    expect(said.join("\n")).not.toContain("--site is not supported with --metamodel");
  });
});

// `installSetFor(...).command` is documented as "a paste-ready shell line". Two ways it
// was not, both shipped in 1.0.4 on the most common selection an adopter makes
// (`meta eject entity queries routes names barrel`):
//
//   - a peer RANGE carries `>=`, `<` and a space. Unquoted, a shell reads
//     `drizzle-orm@>=0.36.0 <1.0.0` as a redirect to a file named `=0.36.0` and a read
//     from a file named `1.0.0`, so the pasted line exits 1 and leaves a stray file.
//   - the set was keyed by the whole spec, so `queries` (no runtime package, peer named
//     unpinned) and `entity` (the same peer with a range) put `drizzle-orm` in it twice.
//
// The shell test runs the real shell rather than pattern-matching the string: the
// contract is what a shell does with the line, and a regex can only restate a guess.

import { describe, test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatorRegistry } from "@metaobjectsdev/codegen-ts";
import { installSetFor } from "../../src/lib/install-set.js";

const ADOPTER_SELECTION = ["entity", "queries", "routes", "names", "barrel"];

function entriesFor(names: readonly string[]) {
  return names.map((n) => {
    const e = generatorRegistry[n];
    if (e === undefined) throw new Error(`no registry entry '${n}'`);
    return e;
  });
}

/** The package name of a spec — `@scope/pkg@range` → `@scope/pkg`. */
function nameOf(spec: string): string {
  const at = spec.indexOf("@", 1);
  return at === -1 ? spec : spec.slice(0, at);
}

describe("installSetFor", () => {
  test("names each package once, keeping the range when one generator knows it", () => {
    const { runtime } = installSetFor(entriesFor(ADOPTER_SELECTION));
    const names = runtime.map(nameOf);
    expect(names).toEqual([...new Set(names)]);
    const drizzle = runtime.find((s) => nameOf(s) === "drizzle-orm");
    expect(drizzle, "drizzle-orm is in the runtime set").toBeDefined();
    expect(drizzle, "the ranged spec wins over the unpinned one").not.toBe("drizzle-orm");
  });

  test("the command word-splits in a real shell to exactly the install set", () => {
    const set = installSetFor(entriesFor(ADOPTER_SELECTION));
    expect(set.runtime.some((s) => /[<>\s]/.test(s)), "the selection exercises a range").toBe(true);

    const cwd = mkdtempSync(join(tmpdir(), "install-set-shell-"));
    try {
      // `npm` is shadowed by a function that prints its argv one per line, so the shell
      // does all of its own parsing — quoting, redirection, splitting — and nothing runs.
      const script = `npm() { printf '%s\\n' "$@"; }\n${set.command}`;
      const r = spawnSync("bash", ["-c", script], { cwd, encoding: "utf8" });
      expect(r.stderr).toBe("");
      expect(r.status).toBe(0);
      expect(r.stdout.trim().split("\n")).toEqual([
        "i", "-D", ...set.dev,
        "i", ...set.runtime,
      ]);
      expect(readdirSync(cwd), "no redirect created a file").toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

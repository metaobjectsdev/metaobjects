import { test, expect, describe } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

const pkgDir = join(import.meta.dir, "../..");
const bundled = join(pkgDir, "agent-context");
// test/agent-context → sdk → packages → typescript → server → repo root
const source = join(pkgDir, "../../../..", "agent-context");

function filesUnder(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(relative(root, full));
    }
  };
  walk(root);
  return out.sort();
}

describe("bundled agent-context content", () => {
  test("the bundle script copies the content into the package", () => {
    expect(existsSync(join(bundled, "skills", "metaobjects-authoring", "SKILL.md"))).toBe(true);
  });

  // The bundle is gitignored, and `resolveAgentContextRoot()` finds it BEFORE the monorepo
  // source. So a bundle left over from an earlier build is what `meta init`, the shipped-tree
  // build and the conformance regen all read, with no signal that it is stale: an edited
  // skill would regenerate fixtures from the old text. Existence is not enough.
  // evals/ is the one directory the bundle leaves out: it is the skills' test harness, and the
  // bundle is what the npm package ships.
  test("the bundle is byte-identical to the monorepo agent-context/, without evals/", () => {
    const hint = "stale bundle: run `bun run --filter '@metaobjectsdev/sdk' bundle-agent-context`";
    const want = filesUnder(source).filter((rel) => rel.split(sep)[0] !== "evals");
    expect(want.length).toBeLessThan(filesUnder(source).length);
    expect(filesUnder(bundled), hint).toEqual(want);
    const differing = want.filter(
      (rel) => !readFileSync(join(source, rel)).equals(readFileSync(join(bundled, rel))),
    );
    expect(differing, hint).toEqual([]);
  });
});

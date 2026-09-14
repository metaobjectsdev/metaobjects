// Gate — every exports-map subpath must resolve under `tsconfig.scripts.json`'s `paths`.
//
// That file maps `@metaobjectsdev/<pkg>/*` to `<pkg>/src/*` so the repo-root `scripts/`
// typecheck reads workspace SOURCE rather than build output. The substitution resolves a
// subpath the way TypeScript resolves any module: `src/<name>.ts`, or `src/<name>/index.ts`
// if `<name>` is a directory. A subpath whose `package.json` entry points somewhere else —
// `./src/core/vocabulary-rewrite-yaml.ts`, say, which is a directory deeper than the
// substitution can reach — has nothing to land on.
//
// Missing is not the same as failing. tsc falls through to `node_modules`, finds the
// package's own `dist/**/*.d.ts`, and compiles clean — on a machine that has built. The
// `gates` lane runs `bun install` and never builds, so `dist/` is absent there and the same
// specifier is `TS2307`. Green locally, red on CI, and only for whoever imports it first.
//
// That is not hypothetical: `./library` shipped in exactly this state and took the lane
// down after the FR-043 merge. This gate is the general form of that fix, because the same
// mistake is available to every subpath added from here on.
import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

function findRepoRoot(start: string): string {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, "fixtures")) && existsSync(join(dir, "server"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("no repo root (a dir holding fixtures/ and server/)");
    dir = parent;
  }
}

const ROOT = findRepoRoot(import.meta.dir);

/** What TypeScript will try for a `paths` substitution that lands on `candidate`. */
function resolvesAsModule(candidate: string): boolean {
  const asFile = [".ts", ".tsx", ".d.ts", ".js", ".jsx"].some((ext) => existsSync(candidate + ext));
  const asDir = [".ts", ".tsx", ".d.ts", ".js", ".jsx"].some((ext) =>
    existsSync(join(candidate, `index${ext}`)),
  );
  return asFile || asDir;
}

interface Wildcard {
  /** The package specifier prefix, e.g. `@metaobjectsdev/metadata`. */
  pkg: string;
  /** Repo-relative directory the `*` expands under, e.g. `server/.../metadata/src`. */
  srcDir: string;
  /** Repo-relative package root, where its `package.json` lives. */
  pkgDir: string;
}

/** Every `@metaobjectsdev/<pkg>/*` entry in the scripts typecheck's `paths` map. */
function wildcards(): Wildcard[] {
  // `tsconfig.scripts.json` carries its rationale under a `"//"` KEY, which is ordinary
  // JSON — no comment stripping needed.
  const cfg = JSON.parse(readFileSync(join(ROOT, "tsconfig.scripts.json"), "utf8")) as {
    compilerOptions: { paths: Record<string, string[]> };
  };
  const out: Wildcard[] = [];
  for (const [spec, targets] of Object.entries(cfg.compilerOptions.paths)) {
    if (!spec.endsWith("/*")) continue;
    const target = targets[0];
    if (target === undefined || !target.endsWith("/*")) continue;
    const srcDir = target.replace(/^\.\//, "").slice(0, -2); // "./a/b/src/*" -> "a/b/src"
    out.push({ pkg: spec.slice(0, -2), srcDir, pkgDir: dirname(srcDir) });
  }
  return out;
}

describe("every exports-map subpath resolves under the scripts typecheck's paths map", () => {
  const entries = wildcards();

  test("the paths map was actually read", () => {
    // Guards every assertion below from passing over an empty list — the way a gate of
    // this shape silently stops gating.
    expect(entries.length, "no @metaobjectsdev/*/* wildcard entries found").toBeGreaterThan(10);
  });

  test("no declared subpath falls through to node_modules", () => {
    const misses: string[] = [];
    let checked = 0;

    for (const { pkg, srcDir, pkgDir } of entries) {
      const manifestPath = join(ROOT, pkgDir, "package.json");
      if (!existsSync(manifestPath)) continue; // a mapping with no package is its own problem
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        exports?: Record<string, string | Record<string, string>>;
      };
      for (const [sub, target] of Object.entries(manifest.exports ?? {})) {
        // `.` is the root entry, which `paths` maps separately (without the `/*`).
        // `./package.json` is resolved by `require.resolve`, never as a type-level import.
        if (sub === "." || sub === "./package.json") continue;
        // Only TypeScript modules are subject to this. An ASSET export — `./form.css`,
        // whose target is the stylesheet itself — is resolved by a bundler, never by tsc,
        // so `paths` having nothing to offer it is correct rather than a defect.
        const source = typeof target === "string" ? target : (target.bun ?? target.types ?? "");
        if (!/\.tsx?$/.test(source)) continue;
        checked++;
        if (!resolvesAsModule(join(ROOT, srcDir, sub.slice(2)))) {
          misses.push(
            `${pkg}${sub.slice(1)} — paths yields "${join(srcDir, sub.slice(2))}", ` +
              `and neither that file nor an index.ts under it exists`,
          );
        }
      }
    }

    expect(checked, "no subpaths were checked at all").toBeGreaterThan(0);
    expect(
      misses,
      "A declared subpath that `tsconfig.scripts.json` cannot resolve to source.\n" +
        "tsc will fall through to node_modules and read the package's built `dist/`, so this\n" +
        "compiles on a machine that has built and is TS2307 on a fresh CI checkout, where the\n" +
        "`gates` lane runs `bun install` and never builds.\n" +
        "Fix the package: point the subpath at `src/<name>.ts` or `src/<name>/index.ts`.\n" +
        "Do NOT add a per-subpath entry to `tsconfig.scripts.json` — the mapping is the\n" +
        "contract, and widening it per package is how it stops being one.\n  " +
        misses.join("\n  "),
    ).toEqual([]);
  });
});

// Gate — every exports-map subpath must resolve, under `tsconfig.scripts.json`'s `paths`,
// to THE SAME MODULE the package declares.
//
// That file maps `@metaobjectsdev/<pkg>/*` to `<pkg>/src/*` so the repo-root `scripts/`
// typecheck reads workspace SOURCE rather than build output. The `*` matches across `/`,
// so nesting is fine — `./templates/entity-file` substitutes to
// `src/templates/entity-file.ts` and is correct. The rule is narrower than "no nesting":
// the subpath NAME must mirror the layout under `src/`. `./vocabulary-rewrite-yaml` whose
// source sits at `src/core/vocabulary-rewrite-yaml.ts` breaks it, because the substitution
// yields `src/vocabulary-rewrite-yaml` and that is not where the module is.
//
// Missing is not the same as failing. tsc falls through to `node_modules`, finds the
// package's own `dist/**/*.d.ts`, and compiles clean — on a machine that has built. The
// `gates` lane runs `bun install` and never builds, so `dist/` is absent there and the same
// specifier is `TS2307`. Green locally, red on CI, and only for whoever imports it first.
// `./library` shipped in exactly that state and took the lane down after the FR-043 merge.
//
// Resolving to SOMETHING is not enough, which is the second half. If `paths` lands on one
// module and the `bun` condition names another, tsc and the runtime disagree silently —
// the type-level form of the cross-package identity defect `tsconfig.scripts.json`'s own
// rationale is written against. Following `src/library/index.ts`'s instruction to
// re-export new modules there, while `bun` still pointed at `library-sources.ts`, would
// typecheck clean and be `undefined` at runtime. So both are asserted: the substitution
// must land, and it must land on the declared file.
import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync, realpathSync } from "node:fs";
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
const MODULE_EXTS = [".ts", ".tsx", ".d.ts", ".js", ".jsx"] as const;

/** Where TypeScript lands for a `paths` substitution of `candidate`, or undefined. */
function resolveModule(candidate: string): string | undefined {
  for (const ext of MODULE_EXTS) if (existsSync(candidate + ext)) return candidate + ext;
  for (const ext of MODULE_EXTS) {
    const idx = join(candidate, `index${ext}`);
    if (existsSync(idx)) return idx;
  }
  return undefined;
}

type ExportTarget = string | Record<string, unknown>;

/**
 * The TypeScript SOURCE a subpath declares, by this repo's convention that the `bun`
 * condition names it. Undefined for an export that is not TypeScript source at all — an
 * asset like `./form.css`, whose target is the stylesheet and which a bundler resolves and
 * tsc never does.
 *
 * A conditions object that declares no `bun` is NOT silently skipped; it comes back as
 * `null` so the caller can fail it. Swallowing that is how a broken TS subpath would
 * escape a gate written to catch broken TS subpaths.
 */
function declaredSource(target: ExportTarget): string | undefined | null {
  if (typeof target === "string") return /\.tsx?$/.test(target) ? target : undefined;
  const bun = target["bun"];
  if (typeof bun === "string") return /\.tsx?$/.test(bun) ? bun : undefined;
  // No `bun` condition. If nothing here looks like a module at all, treat it as an asset;
  // otherwise it is a TS export the scripts typecheck cannot reach through source.
  const anyModule = JSON.stringify(target).includes(".js") || JSON.stringify(target).includes(".ts");
  return anyModule ? null : undefined;
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

  test("every mapped package's manifest is findable", () => {
    // `pkgDir` assumes the target is `<pkgRoot>/src/*`. A target a segment deeper would
    // point this at a directory with no `package.json`, and skipping it quietly would drop
    // that package from the gate with no signal — so it fails here instead.
    const unfindable = entries
      .filter(({ pkgDir }) => !existsSync(join(ROOT, pkgDir, "package.json")))
      .map(({ pkg, pkgDir }) => `${pkg} — no package.json at ${pkgDir}`);
    expect(unfindable, "a paths entry whose package root could not be derived").toEqual([]);
  });

  test("each subpath lands, and lands on the module the package declares", () => {
    const misses: string[] = [];
    const diverged: string[] = [];
    const unreachable: string[] = [];
    let checked = 0;

    for (const { pkg, srcDir, pkgDir } of entries) {
      const manifestPath = join(ROOT, pkgDir, "package.json");
      if (!existsSync(manifestPath)) continue; // reported by the test above
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        exports?: Record<string, ExportTarget>;
      };

      for (const [sub, target] of Object.entries(manifest.exports ?? {})) {
        // `.` is the root entry, which `paths` maps separately (without the `/*`).
        // `./package.json` is resolved by `require.resolve`, never as a type-level import.
        if (sub === "." || sub === "./package.json") continue;
        // A subpath PATTERN stands for many modules, so "does it resolve" has no single
        // answer; whatever it expands to is covered by the files themselves.
        if (sub.includes("*")) continue;

        const source = declaredSource(target);
        if (source === undefined) continue; // asset export — not tsc's to resolve
        if (source === null) {
          unreachable.push(`${pkg}${sub.slice(1)} — declares no \`bun\` condition naming source`);
          continue;
        }

        checked++;
        const viaPaths = resolveModule(join(ROOT, srcDir, sub.slice(2)));
        if (viaPaths === undefined) {
          misses.push(
            `${pkg}${sub.slice(1)} — paths yields "${join(srcDir, sub.slice(2))}", ` +
              `and neither that file nor an index under it exists`,
          );
          continue;
        }
        const declaredAbs = join(ROOT, pkgDir, source.replace(/^\.\//, ""));
        if (!existsSync(declaredAbs)) {
          misses.push(`${pkg}${sub.slice(1)} — declared source "${source}" does not exist`);
          continue;
        }
        if (realpathSync(viaPaths) !== realpathSync(declaredAbs)) {
          diverged.push(
            `${pkg}${sub.slice(1)} — paths reads "${viaPaths.slice(ROOT.length + 1)}" ` +
              `but \`bun\` declares "${source}"`,
          );
        }
      }
    }

    expect(checked, "no subpaths were checked at all").toBeGreaterThan(0);

    expect(
      misses,
      "A declared subpath that `tsconfig.scripts.json` cannot resolve to source.\n" +
        "tsc falls through to node_modules and reads the package's built `dist/`, so this\n" +
        "compiles where someone has built and is TS2307 on a fresh CI checkout, where the\n" +
        "`gates` lane runs `bun install` and never builds.\n" +
        "Fix the package: the subpath NAME must mirror the layout under `src/` (nesting is\n" +
        "fine — the `*` matches across `/`). Do NOT add a per-subpath entry to\n" +
        "`tsconfig.scripts.json`; the mapping is the contract.\n  " +
        misses.join("\n  "),
    ).toEqual([]);

    expect(
      diverged,
      "A subpath where tsc and the runtime read DIFFERENT modules. Types would be taken\n" +
        "from one file and values from another — an export added to only one of them\n" +
        "typechecks clean and is `undefined` at runtime.\n  " +
        diverged.join("\n  "),
    ).toEqual([]);

    expect(
      unreachable,
      "A TypeScript subpath with no `bun` condition. This repo's convention is that `bun`\n" +
        "names the source file; without it the scripts typecheck has only `dist/` to read,\n" +
        "which is the failure this gate exists to prevent.\n  " +
        unreachable.join("\n  "),
    ).toEqual([]);
  });
});

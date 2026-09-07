// A `require.resolve("<pkg>/package.json")` only works if that package EXPORTS the
// subpath. Most of ours do not.
//
// `meta init` reads `@metaobjectsdev/runtime-ts`'s peerDependencies to learn the version
// ranges it declares for the adopter, and asked for them with
// `resolve("@metaobjectsdev/runtime-ts/package.json")`. runtime-ts's exports map is
// `.` / `./drivers` / `./fastify` / `./drizzle-fastify` / `./hono` — no `./package.json` —
// so under real Node that throws ERR_PACKAGE_PATH_NOT_EXPORTED. The call site caught the
// throw and returned `{}`, so `meta init` declared ONE package instead of four and said
// nothing, and the project it had just scaffolded failed `npx tsc` with six TS2307s.
//
// It passed every test in this package. The workspace runs the CLI under bun against a
// symlinked source tree, where the subpath resolves; only a real external install has the
// exports map in force. The release smoke test caught it — after publishing rc.4.
//
// This check needs no install and no runtime: for each `resolve("X/package.json")` in the
// CLI's source, read X's own manifest and require that it either has no `exports` map
// (all subpaths open) or explicitly exports `./package.json`. Resolving a package's ENTRY
// is always allowed, so walking up from there is the portable form.
import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dirname, "..", "src");

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((e) => {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) return tsFiles(full);
    return full.endsWith(".ts") ? [full] : [];
  });
}

/** The package this repo publishes under `name`, or undefined if it is not ours. */
function workspaceManifest(name: string): Record<string, unknown> | undefined {
  const short = name.replace("@metaobjectsdev/", "");
  for (const root of ["server/typescript/packages", "client/web/packages"]) {
    const p = join(import.meta.dirname, "..", "..", "..", "..", "..", root, short, "package.json");
    if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
  }
  return undefined;
}

describe("the CLI never resolves a package.json subpath a package does not export", () => {
  test("every resolve(\"<pkg>/package.json\") names a package that exports it", () => {
    const offenders: string[] = [];
    for (const file of tsFiles(SRC)) {
      const source = readFileSync(file, "utf8");
      for (const m of source.matchAll(/resolve\(\s*["'`]([^"'`]+)\/package\.json["'`]/g)) {
        const pkg = m[1];
        if (pkg === undefined || pkg.startsWith(".")) continue;   // a path, not a specifier
        const manifest = workspaceManifest(pkg);
        // Not one of ours: we cannot read its exports map here, and asking for a
        // third party's package.json is the same gamble. Flag it either way.
        if (manifest === undefined) {
          offenders.push(`${file.replace(SRC, "src")}: ${pkg} (not a workspace package — exports unknown)`);
          continue;
        }
        const exportsMap = manifest.exports as Record<string, unknown> | undefined;
        if (exportsMap !== undefined && !("./package.json" in exportsMap)) {
          offenders.push(
            `${file.replace(SRC, "src")}: ${pkg} has an exports map without "./package.json" — ` +
            "this throws ERR_PACKAGE_PATH_NOT_EXPORTED on a real install",
          );
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("runtime-ts really does withhold ./package.json, so the rule above is not vacuous", () => {
    // If runtime-ts ever exports it, this test says so rather than quietly becoming a
    // check with nothing left to check.
    const manifest = workspaceManifest("@metaobjectsdev/runtime-ts");
    expect(manifest).toBeDefined();
    const exportsMap = manifest?.exports as Record<string, unknown> | undefined;
    expect(exportsMap).toBeDefined();
    expect(Object.keys(exportsMap ?? {})).not.toContain("./package.json");
  });
});

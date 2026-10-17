import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The installed `@metaobjectsdev/cli` version, read from its own package.json so it
 * never goes stale. Walks up from this module to the cli package root; returns
 * "0.0.0" if not found.
 */
export function cliVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      try {
        const pkg = JSON.parse(readFileSync(candidate, "utf8")) as { name?: string; version?: string };
        if (pkg.name === "@metaobjectsdev/cli" && pkg.version) return pkg.version;
      } catch {
        // not our manifest / unreadable — keep walking up
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "0.0.0";
}

/**
 * True when `version` carries a semver prerelease identifier (`-rc.4`, `-alpha.1`,
 * `-beta`, `-SNAPSHOT`, …) — the same shape `tools/prerelease/detect-prerelease-pins.sh`'s
 * `PRERELEASE_RE` matches. Used to warn when a pre-release CLI is about to stamp its own
 * version into committed state (`.metaobjects/.agent-context.json`'s `generatedBy`),
 * which that detector now also flags on the tree side.
 */
export function isPrereleaseVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+-[0-9A-Za-z.-]+$/.test(version.trim());
}

/** The three spellings that print the bare version: `--version`, `-v` and `-V`. */
const VERSION_FLAGS: readonly string[] = ["--version", "-v", "-V"];

export function isVersionFlag(arg: string | undefined): boolean {
  return arg !== undefined && VERSION_FLAGS.includes(arg);
}

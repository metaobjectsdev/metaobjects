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

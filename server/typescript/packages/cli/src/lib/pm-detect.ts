import { access } from "node:fs/promises";
import { join } from "node:path";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

/**
 * Detect the package manager in use by looking for the lockfile closest to
 * `dir`. Walks up to the root. Returns "bun" as the default when no lockfile
 * is found.
 */
export async function detectPackageManager(dir: string): Promise<PackageManager> {
  // Check in the given dir first, then parent dirs up to the FS root.
  let current = dir;
  while (true) {
    const candidates: [string, PackageManager][] = [
      [join(current, "package-lock.json"), "npm"],
      [join(current, "pnpm-lock.yaml"), "pnpm"],
      [join(current, "yarn.lock"), "yarn"],
      [join(current, "bun.lockb"), "bun"],
      [join(current, "bun.lock"), "bun"],
    ];
    for (const [path, pm] of candidates) {
      try {
        await access(path);
        return pm;
      } catch {
        // not found, try next
      }
    }
    const parent = join(current, "..");
    if (parent === current) break; // reached root
    current = parent;
  }
  // Default: bun (most common for this toolchain)
  return "bun";
}

/**
 * Returns the install command for a missing package, using the detected PM.
 */
export async function installCommand(pkg: string, dir: string): Promise<string> {
  const pm = await detectPackageManager(dir);
  switch (pm) {
    case "npm":
      return `npm install ${pkg}`;
    case "pnpm":
      return `pnpm add ${pkg}`;
    case "yarn":
      return `yarn add ${pkg}`;
    case "bun":
      return `bun add ${pkg}`;
  }
}

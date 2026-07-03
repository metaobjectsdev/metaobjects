import { access } from "node:fs/promises";
import { join } from "node:path";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

/**
 * Options for `detectPackageManager`.
 */
export interface DetectPackageManagerOptions {
  /**
   * Stop walking up the directory tree at this path (inclusive). Useful in
   * tests or isolated environments where walking above the project root would
   * accidentally find a lockfile in an unrelated ancestor directory (e.g. a
   * stale `/tmp/package-lock.json` on a shared CI machine).
   *
   * If omitted the walk continues all the way to the filesystem root.
   */
  stopAt?: string;
}

/**
 * Detect the package manager in use by looking for the lockfile closest to
 * `dir`. Walks up to the filesystem root (or `options.stopAt`, if supplied).
 * Returns "bun" as the default when no lockfile is found.
 */
export async function detectPackageManager(
  dir: string,
  options?: DetectPackageManagerOptions,
): Promise<PackageManager> {
  // Check in the given dir first, then parent dirs up to the FS root (or stopAt).
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
    // Honor the stopAt boundary before walking up further.
    if (options?.stopAt !== undefined && current === options.stopAt) break;
    const parent = join(current, "..");
    if (parent === current) break; // reached filesystem root
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

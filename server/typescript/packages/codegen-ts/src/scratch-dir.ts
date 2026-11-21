// Throwaway directories: where they live and how they are removed.
//
// Bun's `rmSync(dir, { recursive: true })` has been seen failing with
// `EFAULT: bad address in system call argument` while other tests in the same process
// were also touching the filesystem (its recursive remove shares native state across
// calls). The failure is in the remover, not in the directory, so removal falls back to a
// plain readdir/unlink/rmdir walk, which does not go through that code path. A path that is
// already gone is success, never an error: another remover may have beaten us to it.
import { mkdtempSync, readdirSync, rmSync, rmdirSync, unlinkSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** `$DEV_SCRATCH` (RAM-backed) when set and non-empty, else the OS temp directory. */
export function scratchRoot(): string {
  const scratch = process.env.DEV_SCRATCH;
  return scratch !== undefined && scratch !== "" ? scratch : tmpdir();
}

/** A fresh, uniquely named directory under {@link scratchRoot}. */
export function makeScratchDir(prefix: string): string {
  return mkdtempSync(join(scratchRoot(), prefix));
}

const isGone = (e: unknown): boolean => (e as NodeJS.ErrnoException).code === "ENOENT";

function walkRemove(path: string): void {
  let isDir: boolean;
  try {
    isDir = lstatSync(path).isDirectory();
  } catch (e) {
    if (isGone(e)) return;
    throw e;
  }
  try {
    if (!isDir) {
      unlinkSync(path);
      return;
    }
    for (const name of readdirSync(path)) walkRemove(join(path, name));
    rmdirSync(path);
  } catch (e) {
    if (!isGone(e)) throw e;
  }
}

/** Remove a directory tree, tolerating it being absent and Bun's intermittent EFAULT. */
export function removeTree(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EFAULT") throw e;
    walkRemove(path);
  }
}

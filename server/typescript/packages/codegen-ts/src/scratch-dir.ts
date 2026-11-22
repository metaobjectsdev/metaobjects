// Throwaway directories: where they live and how they are removed.
//
// Bun's `rmSync(dir, { recursive: true })` has been seen failing with
// `EFAULT: bad address in system call argument` while other tests in the same process
// were also touching the filesystem (observed on Bun 1.3.x; local Bun 1.3.14). The failure
// is in the remover, not in the directory, so removal never calls it: it always walks the
// tree with readdir/unlink/rmdir. A path that is already gone is success, never an error:
// another remover may have beaten us to it.
import { mkdtempSync, readdirSync, rmdirSync, unlinkSync, lstatSync } from "node:fs";
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

/** Remove a directory tree, tolerating it being absent. Never uses Bun's recursive `rmSync`. */
export function removeTree(path: string): void {
  walkRemove(path);
}

const removedAtExit = new Set<string>();

/**
 * Remove `path` when this process exits normally (the `exit` event; a process killed by a signal
 * leaves it behind). For state a process shares across its own runs and no
 * later process reads (runGen's gen-state for a run with no project): without it, every process
 * that ever ran one left a directory in the scratch root.
 */
export function removeTreeAtExit(path: string): void {
  if (removedAtExit.has(path)) return;
  if (removedAtExit.size === 0) {
    process.once("exit", () => {
      for (const p of removedAtExit) {
        try {
          removeTree(p);
        } catch {
          // An exit handler must not throw: a directory it cannot remove is left behind.
        }
      }
    });
  }
  removedAtExit.add(path);
}

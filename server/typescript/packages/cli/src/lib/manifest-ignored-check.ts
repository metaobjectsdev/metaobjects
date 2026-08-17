// Advisory: is the codegen hash manifest git-ignored?
//
// `.gen-state/.hashes.json` is what lets `meta gen` tell "this file is exactly what
// I wrote" from "somebody edited this" on a machine that did not generate it. If it
// is ignored, that knowledge never leaves the generating machine, and on every other
// machine a hand-edited generated file cannot be recognised as such.
//
// The reason this check exists rather than only a migration doc: the failure is
// INVISIBLE. A project with the manifest ignored looks completely normal — `meta gen`
// succeeds, output is correct — right up until a fresh clone refuses a wall of files
// or (before the fix) silently ate an edit. This repo's own 0.23.1 lesson was that a
// fix ships with the check that would have caught it, or it survives as folklore.
//
// Deliberately advisory. It cannot be an error: a project that genuinely does not
// commit generated output has no use for the manifest, and failing its build over an
// unused artifact would be wrong.

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { log } from "./log.js";

/** Project-relative path of the manifest — the one artifact of `.gen-state/` that is
 *  meant to be committed. */
export const HASH_MANIFEST_REL = join(".metaobjects", ".gen-state", ".hashes.json");

/**
 * Ask git whether `relPath` is ignored, or undefined when the question cannot be
 * answered (not a repository, git missing).
 *
 * `check-ignore` is the only reliable answer: parsing `.gitignore` by hand would have
 * to reimplement precedence, negation and nested ignore files — and the specific trap
 * this check exists to catch (`.gen-state/` excluding a directory so a `!` negation
 * inside it can never apply) is exactly the rule a hand-rolled parser gets wrong.
 */
function isGitIgnored(cwd: string, relPath: string): boolean | undefined {
  const gitBin = process.env.META_GEN_GIT ?? "git";
  let res;
  try {
    res = spawnSync(gitBin, ["-C", cwd, "check-ignore", "-q", "--", relPath], {
      encoding: "utf-8",
    });
  } catch {
    return undefined;
  }
  if (res.error !== undefined) return undefined;
  // 0 = ignored, 1 = not ignored, 128 = not a git repo / other git error.
  if (res.status === 0) return true;
  if (res.status === 1) return false;
  return undefined;
}

/**
 * Warn once when the hash manifest is git-ignored, naming the fix.
 *
 * Silent when: it is tracked correctly, the project is not a git repository, git is
 * unavailable, or no generated output has ever been produced (nothing to protect yet).
 * Never throws, never blocks.
 */
export function warnIfManifestIgnored(cwd: string): void {
  // Nothing generated yet ⇒ nothing at risk ⇒ nothing worth saying.
  if (!existsSync(join(cwd, HASH_MANIFEST_REL))) return;

  if (isGitIgnored(cwd, HASH_MANIFEST_REL) !== true) return;

  log.warn(
    `${HASH_MANIFEST_REL} is git-ignored, so it never reaches another machine — ` +
      `on a fresh clone or CI runner 'meta gen' cannot tell your hand edits from its ` +
      `own stale output, and will refuse to overwrite rather than guess. Fix it in ` +
      `.metaobjects/.gitignore by replacing '.gen-state/' with '.gen-state/*' plus ` +
      `'!.gen-state/.hashes.json' (the glob matters — git will not descend into an ` +
      `excluded directory, so a negation under '.gen-state/' can never apply), then ` +
      `commit the manifest. If you deliberately do not commit generated output, ignore this.`,
  );
}

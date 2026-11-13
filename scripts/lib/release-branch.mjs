// Which branch a release may be cut from — shared by `scripts/release.mjs` and
// `scripts/finish-release.mjs`, so the two cannot disagree about it.
//
// Two kinds of branch qualify:
//
//  - `main`, for every release, as before.
//  - a maintenance branch named `release/<major>.<minor>`, for a PATCH on a line `main`
//    has moved past. It may cut only versions on its own line: `release/1.2` cuts 1.2.x
//    and nothing else, because a 1.3.0 cut from it would ship a minor without the work
//    `main` holds for that minor.
//
// The caller pushes to, and compares HEAD against, `origin/<branch>` — never `origin/main`
// when it is on a maintenance branch.

/** The pattern a maintenance branch name must match. */
export const MAINTENANCE_BRANCH = /^release\/(\d+)\.(\d+)$/;

/**
 * Why `version` may not be released from `branch`, or `null` when it may.
 *
 * @param {string} branch the current branch, as `git rev-parse --abbrev-ref HEAD` prints it
 * @param {string} version the version being cut (`1.2.2`, or `1.2.2-rc.1` for release.mjs)
 * @returns {string | null}
 */
export function releaseBranchRefusal(branch, version) {
  if (branch === "main") return null;
  const m = MAINTENANCE_BRANCH.exec(branch);
  if (m === null) {
    return `not on main or a release/<major>.<minor> maintenance branch (you are on ${branch})`;
  }
  const [, major, minor] = m;
  const v = /^(\d+)\.(\d+)\./.exec(version);
  if (v === null || v[1] !== major || v[2] !== minor) {
    return `${branch} is the ${major}.${minor} maintenance branch and cuts only ${major}.${minor}.x — ` +
      `${version} is not on that line (cut it from main, or from its own release/<major>.<minor>)`;
  }
  return null;
}

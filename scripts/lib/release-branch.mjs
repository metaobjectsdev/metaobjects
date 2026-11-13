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

/**
 * The newest tag on the npm release line, the way the site deploy resolves it: the newest
 * `vN.N.N` whose `server/typescript/packages/cli/package.json` is versioned as the tag —
 * the property that DEFINES the npm line, never a version prefix (the JVM `v7.20.12` ships
 * cli `0.20.11` and must not count). `""` when no release tag exists.
 *
 * @param {(cmd: string) => string} out run a command and return its trimmed stdout, like
 *   each script's own `out`
 * @returns {string}
 */
export function newestNpmReleaseTag(out) {
  return out(`git tag -l 'v*' | grep -E '^v[0-9]+\\.[0-9]+\\.[0-9]+$' | sort -rV || true`)
    .split("\n").map((t) => t.trim()).filter(Boolean)
    .find((t) => {
      const pkg = out(`git show ${t}:server/typescript/packages/cli/package.json 2>/dev/null || true`);
      try { return JSON.parse(pkg).version === t.slice(1); } catch { return false; }
    }) ?? "";
}

/**
 * Why `version` may not be released while `newestTag` is the newest release tag, or `null`
 * when it may. `bun publish` tags `latest`, so a version older than the newest release
 * would move `latest` backwards — including an `-rc` cut on a line a newer release passed.
 *
 * @param {string} version the version being cut (`1.2.4`, or `1.2.4-rc.1`)
 * @param {string} newestTag the newest npm-line release tag (`v1.3.0`), or `""` if none
 * @returns {string | null}
 */
export function latestRegressionRefusal(version, newestTag) {
  if (newestTag === "") return null;
  const a = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  const b = /^v(\d+)\.(\d+)\.(\d+)$/.exec(newestTag);
  if (a === null || b === null) return null;
  for (let i = 1; i <= 3; i++) {
    if (Number(a[i]) === Number(b[i])) continue;
    if (Number(a[i]) > Number(b[i])) return null;
    return `${version} is older than ${newestTag.slice(1)}, the newest release — npm publishes to ` +
      `\`latest\`, so this would move \`latest\` backwards. A patch on a line a newer release ` +
      `has passed needs a non-\`latest\` dist-tag path this script does not yet offer.`;
  }
  return null;
}

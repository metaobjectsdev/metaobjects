// The decisions scripts/prerelease.mjs makes before it publishes anything, as pure functions so
// scripts/test-prerelease-version.mjs can hold them to the cases that burned version numbers.
//
// A version number is spent the moment it is published, so each of these answers "what number
// does this cut get?" from a source that cannot be wrong in the way the old one was.

/** Compare two plain x.y.z versions: negative, zero or positive. */
export function cmpVer(a, b) {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

const PLAIN = /^\d+\.\d+\.\d+$/;

/** Every `## [x.y.z]` section header in a CHANGELOG, in file order. `[Unreleased]` is not one. */
export function changelogVersions(markdown) {
  return [...markdown.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)].map((m) => m[1]);
}

/** The highest release tag `v<major>.y.z` (no prerelease suffix), or null. Only the npm major
 *  line counts: the repository also carries `v7.*` tags from the Maven numbering of 0.x. */
export function latestReleaseTag(tags, major) {
  const versions = tags
    .map((t) => t.trim().replace(/^v/, ""))
    .filter((v) => PLAIN.test(v) && Number(v.split(".")[0]) === major);
  return versions.sort(cmpVer).pop() ?? null;
}

/**
 * What is RELEASED: the newer of public npm's `latest` for the CLI and the highest release tag.
 *
 * Not `package.json`. Release preparation bumps `package.json` to the version being prepared
 * before anything is published, so reading it as "released" made the CHANGELOG's top section look
 * already shipped, and every rc cut between the prep PR and the release was numbered one minor
 * too high (`1.2.0-rc.3` while `1.1.0` was the work in hand). Null when neither source answers.
 */
export function releasedVersion({ npmLatest, tags, major }) {
  const candidates = [npmLatest, latestReleaseTag(tags, major)].filter((v) => v && PLAIN.test(v));
  return candidates.sort(cmpVer).pop() ?? null;
}

/**
 * The version this cut is FOR: `{ base, source }`, or throws an Error whose message says why not.
 *
 * - A CHANGELOG section newer than the release is unpublished work; the lowest one is the next
 *   release, and the cut is for it.
 * - `--base` may name that version, or any version when every section is published. It may not
 *   name an already released version, and it may not SKIP an unpublished section: that is the
 *   mis-numbering this exists to refuse, reached by hand instead of by guess.
 * - With every section published and no `--base`, the next minor is guessed.
 */
export function decideBase({ released, changelog, explicit }) {
  if (explicit != null && !PLAIN.test(explicit)) throw new Error(`--base must be a plain x.y.z, got ${explicit}`);
  if (released == null) {
    if (explicit != null) return { base: explicit, source: "--base (what is released could not be read)" };
    throw new Error(
      "cannot tell which version is released: public npm did not answer and no release tag was found. " +
        "Pass --base <x.y.z> (the CHANGELOG section being prepared).",
    );
  }
  const unpublished = changelog.filter((v) => cmpVer(v, released) > 0).sort(cmpVer);
  if (explicit != null) {
    if (cmpVer(explicit, released) <= 0)
      throw new Error(`--base ${explicit} is not newer than the released ${released}`);
    if (unpublished.length > 0 && cmpVer(explicit, unpublished[0]) > 0)
      throw new Error(
        `--base ${explicit} would skip the unpublished CHANGELOG section [${unpublished[0]}]: ` +
          `${unpublished[0]} has not been released, so a cut for a later version mis-numbers it.`,
      );
    return { base: explicit, source: "--base" };
  }
  if (unpublished.length > 0) return { base: unpublished[0], source: "CHANGELOG.md" };
  const [maj, min] = released.split(".").map(Number);
  return { base: `${maj}.${min + 1}.0`, source: `guessed from released ${released}` };
}

/**
 * Every item of a paged listing: `fetchPage(page, limit)` returns one page's array, and the walk
 * stops at the first short page. A registry that caps a page (Gitea serves 50 whatever `limit`
 * asks for) used to hide every used iteration past the first page from the counter.
 */
export async function collectPages(fetchPage, limit = 50, maxPages = 1000) {
  const all = [];
  for (let page = 1; page <= maxPages; page++) {
    const items = await fetchPage(page, limit);
    all.push(...items);
    if (items.length < limit) return all;
  }
  throw new Error(`the listing did not end within ${maxPages} pages`);
}

/**
 * Run `restore` when the process ends by any route a supervisor or a terminal takes: a normal
 * exit, Ctrl-C, a kill or a timeout (SIGTERM) and a closed terminal (SIGHUP). SIGTERM was missing,
 * so a killed run left every `package.json`, pom and `pyproject.toml` bumped.
 */
export function installRestoreHandlers(restore, proc = process) {
  proc.on("exit", restore);
  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]]) {
    proc.on(signal, () => {
      restore();
      proc.exit(code);
    });
  }
}

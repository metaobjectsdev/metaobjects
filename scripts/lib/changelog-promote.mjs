// How `scripts/release.mjs` dates the CHANGELOG section of the version it releases.
//
// Two layouts reach a release:
//
//  1. Entries under `## [Unreleased]`: they become `## [<version>] — <today>`.
//  2. `[Unreleased]` empty and the section for <version> already written (a MINOR prepared
//     over several release candidates, as 1.1.0 was). That section carries the date it was
//     STARTED, not the date it ships, so the release restamps it with today.
//
// Entries under `[Unreleased]` above a prepared section for <version> (fragments assembled on
// top of a prepared MINOR) are "split": promoting them would open a second `[<version>]`, and
// where they belong inside the prepared section is the release author's call. The release
// stops and says so; nothing is rewritten.
//
// Anything else (an empty `[Unreleased]` above some other version) is left as it is and
// reported, because there is nothing for this release to promote.

/**
 * @param {string} changelog the CHANGELOG.md text
 * @param {string} version the version being released (e.g. "1.1.0")
 * @param {string} today YYYY-MM-DD
 * @param {string} subtitle the italic line written under a newly promoted heading
 * @returns {{ text: string, action: "promoted" | "redated" | "unchanged" | "nothing" | "split" }}
 */
export function promoteChangelog(changelog, version, today, subtitle) {
  const head = /## \[Unreleased\]\n([\s\S]*?)^## \[([^\]]+)\]/m.exec(changelog);
  if (head !== null && (head[1] ?? "").trim() !== "" && head[2] === version) return { text: changelog, action: "split" };
  const empty = /## \[Unreleased\]\s*\n\s*\n## \[([^\]]+)\] — (\S+)/.exec(changelog);
  if (empty === null) {
    const text = changelog.replace(/## \[Unreleased\]\n/, `## [Unreleased]\n\n## [${version}] — ${today}\n\n${subtitle}\n`);
    return { text, action: text === changelog ? "nothing" : "promoted" };
  }
  const [, next, date] = empty;
  if (next !== version) return { text: changelog, action: "nothing" };
  if (date === today) return { text: changelog, action: "unchanged" };
  const heading = `## [${version}] — ${date}`;
  return { text: changelog.replace(heading, `## [${version}] — ${today}`), action: "redated" };
}

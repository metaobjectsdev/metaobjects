// Advisory: did the scaffold land in a directory this repository ignores?
//
// `meta init` reports "(11 files)". Eight of them go under `.claude/skills/`, and many
// projects git-ignore `.claude/` — commonly under a comment about credentials, which is a
// defensible convention, not a mistake. Ignored, those files exist only on the machine that
// ran the command: never committed, absent from CI and from a fresh clone, invisible to a
// teammate — while `.metaobjects/.agent-context.json`, which IS committed, records every one
// of them. The count says eleven; the repository gets three.
//
// The failure is INVISIBLE, which is why it is worth a check rather than a doc: nothing
// errors, nothing looks wrong, and the whole downstream agent-context design is simply void
// for that repo.
//
// Deliberately ADVISORY. Ignoring `.claude/` may be exactly what the project wants — it is a
// per-repo policy call, and a scaffolder has no standing to fail a build over it.

import { relative } from "node:path";
import { log } from "./log.js";
import { gitIgnored } from "./git-ignore.js";

/**
 * Warn when some of the scaffolded paths are git-ignored, naming how many and where.
 *
 * Silent when: nothing is ignored, the project is not a git repository, or git cannot be
 * consulted — "cannot say" must never be reported as "there is a problem".
 *
 * `honourGlobalExcludes: false` for the same reason the docs-drift gate uses it: this is a
 * property of the REPOSITORY, and a personal `~/.gitignore` is not something a teammate
 * shares. A warning that fires for one developer and not another is worse than none.
 */
export function reportIgnoredScaffold(cwd: string, created: readonly string[]): void {
  const rels = created
    .map((p) => relative(cwd, p) || p)
    .map((p) => p.split("\\").join("/"))
    .filter((p) => p.length > 0 && !p.startsWith(".."));
  if (rels.length === 0) return;

  const res = gitIgnored(cwd, rels, { honourGlobalExcludes: false });
  if ("unavailable" in res) return;   // not a git repo, or git could not answer
  const ignored = rels.filter((p) => res.ignored.has(p));
  if (ignored.length === 0) return;

  // Report the DIRECTORIES rather than every path: an adopter fixes this by editing one
  // `.gitignore` line, and a wall of forty filenames buries that.
  const dirs = [...new Set(ignored.map((p) => {
    const i = p.indexOf("/");
    return i < 0 ? p : p.slice(0, i) + "/";
  }))].sort();

  log.warn(
    `${ignored.length} of ${rels.length} scaffolded file(s) are git-ignored (${dirs.join(", ")}), ` +
      "so they exist only on this machine — not committed, absent from CI and from a fresh " +
      "clone, invisible to a teammate — while .metaobjects/.agent-context.json is committed " +
      "and records them. If the agent context is meant to be shared, un-ignore those paths; " +
      "if it is deliberately local, nothing to do.",
  );
}

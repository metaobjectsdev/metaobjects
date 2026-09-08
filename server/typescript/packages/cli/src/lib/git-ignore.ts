// "Does this project deliberately not commit these files?" — asked of git, once.
//
// `check-ignore` is the only reliable answer. Parsing `.gitignore` by hand would have
// to reimplement precedence, negation and nested ignore files, and the traps are
// exactly the rules a hand-rolled parser gets wrong: a directory pattern (`docs/`)
// makes a `!` negation inside it unreachable, and a TRACKED file is never reported
// ignored no matter what pattern matches it.
//
// That last property is what makes this usable as an exemption: a page the project
// has committed is always compared, whatever its `.gitignore` says. So a rule built
// on this cannot be used to hide a file the project actually tracks.
//
// Paths are evaluated BY NAME — a path need not exist on disk for git to answer. That
// is deliberate and load-bearing for the docs gate: the exemption is computed over
// the set a fresh run WOULD emit, so the verdict is identical on a developer box
// where those files are present and on a CI runner where they are not.

import { spawnSync } from "node:child_process";
import { toPosix } from "./rel-posix.js";

/** Ignored paths, or the reason the question could not be asked. */
export type GitIgnoreResult =
  | { readonly ignored: ReadonlySet<string> }
  | { readonly unavailable: string };

export interface GitIgnoreOptions {
  /**
   * Whether a per-user ignore file (`core.excludesFile`) may contribute to the
   * verdict.
   *
   * `false` for anything whose answer must be a property of the REPOSITORY — a gate
   * that passes on the author's machine and fails in CI because of a personal ignore
   * file is worse than no gate. Implemented by pointing `core.excludesFile` at a path
   * that does not exist, which is the only way to neutralise it.
   *
   * `true` where the question is genuinely about this machine — "will this file reach
   * anyone else?" is answered by every rule that applies here, personal ones included.
   *
   * Note `.git/info/exclude` is per-clone and CANNOT be neutralised; it is reported
   * like any other rule, and the caller's count line is what exposes it.
   */
  readonly honourGlobalExcludes: boolean;
}

/** A path that cannot exist, used to neutralise a per-user excludes file. */
const NO_SUCH_EXCLUDES_FILE = "/dev/null/metaobjects-no-global-excludes";

/**
 * Ask git which of `rels` are ignored, relative to `dir`.
 *
 * Returns `unavailable` — never throws, never guesses — when git is not on PATH or
 * `dir` is not inside a repository. A caller must decide what that means for it;
 * silently treating "cannot say" as "nothing is ignored" is a fallback that lies, and
 * the callers here say so out loud instead.
 */
export function gitIgnored(
  dir: string,
  rels: readonly string[],
  opts: GitIgnoreOptions,
): GitIgnoreResult {
  if (rels.length === 0) return { ignored: new Set() };

  const gitBin = process.env.META_GEN_GIT ?? "git";
  const args: string[] = [];
  if (!opts.honourGlobalExcludes) {
    args.push("-c", `core.excludesFile=${NO_SUCH_EXCLUDES_FILE}`);
  }
  args.push("-C", dir, "check-ignore", "--stdin", "-z");

  // Forward slashes: git speaks them on every platform, and `listFiles` hands us
  // platform separators.
  const input = rels.map(toPosix).join("\0");

  let res;
  try {
    res = spawnSync(gitBin, args, { encoding: "utf-8", input });
  } catch (err) {
    return { unavailable: `git could not be run (${(err as Error).message})` };
  }
  if (res.error !== undefined) {
    return { unavailable: "git is not on PATH" };
  }
  // 0 = at least one ignored, 1 = none ignored, anything else = not a repository
  // (or a git error), which is a different fact from "nothing is ignored".
  if (res.status === 1) return { ignored: new Set() };
  if (res.status !== 0) {
    const stderr = (res.stderr ?? "").split("\n")[0]?.trim();
    return {
      unavailable:
        stderr !== undefined && stderr !== ""
          ? stderr
          : `'${dir}' is not inside a git repository`,
    };
  }

  const ignored = new Set(
    (res.stdout ?? "").split("\0").map((p) => p.trim()).filter((p) => p !== ""),
  );
  return { ignored };
}

/**
 * Single-path convenience: true / false / undefined when git cannot say.
 *
 * `honourGlobalExcludes` is the caller's decision — see the option's doc.
 */
export function isGitIgnored(
  dir: string,
  rel: string,
  opts: GitIgnoreOptions,
): boolean | undefined {
  const res = gitIgnored(dir, [rel], opts);
  if ("unavailable" in res) return undefined;
  return res.ignored.has(toPosix(rel));
}

/**
 * WHICH rule ignores `rel` — the `.gitignore` file, its line, and the pattern.
 *
 * Advisories that tell an adopter to fix an ignore rule have to name the rule that is
 * actually in force, not a conventional location. The exclusion can live in ANY
 * `.gitignore` up the tree, in `.git/info/exclude`, or in a per-user excludes file, and an
 * advisory that assumes one of them sends the reader to edit a file that does not hold the
 * rule — after which the same advisory prints again, unchanged. `git check-ignore -v`
 * answers it exactly, so nothing has to be assumed.
 *
 * `undefined` when git cannot say or nothing matches. The verdict itself still comes from
 * `isGitIgnored`; this is only for the message, so a failure here degrades the wording
 * rather than the check.
 */
export function gitIgnoreSource(
  dir: string,
  rel: string,
  opts: GitIgnoreOptions,
): { file: string; line: string; pattern: string } | undefined {
  const gitBin = process.env.META_GEN_GIT ?? "git";
  const args: string[] = [];
  if (!opts.honourGlobalExcludes) {
    args.push("-c", `core.excludesFile=${NO_SUCH_EXCLUDES_FILE}`);
  }
  args.push("-C", dir, "check-ignore", "-v", "--", toPosix(rel));

  let res;
  try {
    res = spawnSync(gitBin, args, { encoding: "utf-8" });
  } catch {
    return undefined;
  }
  if (res.error !== undefined || res.status !== 0) return undefined;
  // `<source>:<line>:<pattern>\t<path>` — the source may itself contain a colon on
  // Windows, so split from the RIGHT of the first tab-delimited field.
  const first = (res.stdout ?? "").split("\n")[0];
  if (first === undefined || first === "") return undefined;
  const lhs = first.split("\t")[0];
  if (lhs === undefined) return undefined;
  const m = /^(.*):(\d+):(.*)$/.exec(lhs);
  if (m === null) return undefined;
  return { file: m[1]!, line: m[2]!, pattern: m[3]! };
}

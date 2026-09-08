// One spelling of "a path, with forward slashes".
//
// Six modules under lib/ carried this rule inline — `git-ignore`, `docs-drift` (twice),
// `anti-patterns`, `base-url-advisory` and `ignored-scaffold-check` — and one of the six
// was spelled differently: `.split("\\").join("/")` rather than `.split(sep).join("/")`.
// On Windows those agree, because `sep` IS a backslash. On POSIX they do not: `sep` is
// already "/" so the correct form is a no-op, while splitting on a literal backslash
// rewrites a filename that legitimately CONTAINS one. That is the drift six copies of a
// one-line rule invite, and it had already happened.
//
// Comparisons against git's output are the reason the rule exists at all: `git check-ignore`
// and `git ls-files` speak forward slashes on every platform, so a Windows path has to be
// normalized before it can be looked up in a set built from git's answer.

import { relative, sep } from "node:path";

/** A path with the platform separator replaced by "/" — a no-op on POSIX. */
export function toPosix(p: string): string {
  return p.split(sep).join("/");
}

/** `abs` relative to `root`, forward-slashed. */
export function relPosix(root: string, abs: string): string {
  return toPosix(relative(root, abs));
}

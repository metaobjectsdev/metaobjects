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
import { join } from "node:path";
import { log } from "./log.js";
import { gitIgnoreSource, isGitIgnored } from "./git-ignore.js";

/** Project-relative path of the manifest — the one artifact of `.gen-state/` that is
 *  meant to be committed. */
export const HASH_MANIFEST_REL = join(".metaobjects", ".gen-state", ".hashes.json");

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

  // honourGlobalExcludes: TRUE here, and that is the opposite call to the docs gate.
  // The question this warning asks is "will this file reach another machine?", and a
  // per-user ignore file answers it just as truly as a committed .gitignore does.
  if (isGitIgnored(cwd, HASH_MANIFEST_REL, { honourGlobalExcludes: true }) !== true) return;

  // WHERE the rule actually lives, asked of git rather than assumed. This used to name
  // `.metaobjects/.gitignore` and the literal pattern `.gen-state/`, which is only one of
  // the places the exclusion can sit: an adopter estate had it in the ROOT `.gitignore` as
  // `.metaobjects/.gen-state/`, so following this advisory to the letter edited a file that
  // did not hold the rule, changed nothing, and printed this same line again — the loop
  // shape. `git check-ignore -v` knows the answer, so nothing is guessed. When git cannot
  // say, the wording degrades to the generic form rather than asserting a location.
  const src = gitIgnoreSource(cwd, HASH_MANIFEST_REL, { honourGlobalExcludes: true });
  const where =
    src !== undefined
      ? `The rule is '${src.pattern}' at ${src.file}:${src.line} — replace it there with ` +
        `a '/*' form plus a '!' negation for the manifest ` +
        `(e.g. '${src.pattern.replace(/\/$/, "")}/*' and '!${src.pattern.replace(/\/$/, "")}/.hashes.json')`
      : `Find the rule with 'git check-ignore -v ${HASH_MANIFEST_REL}' and replace it with ` +
        `a '/*' form plus a '!' negation for the manifest`;

  log.warn(
    `${HASH_MANIFEST_REL} is git-ignored, so it never reaches another machine — ` +
      `on a fresh clone or CI runner 'meta gen' cannot tell your hand edits from its ` +
      `own stale output, and will refuse to overwrite rather than guess. ${where} ` +
      `(the glob matters — git will not descend into an excluded directory, so a negation ` +
      `INSIDE an excluded directory can never apply), then commit the manifest. ` +
      `If you deliberately do not commit generated output, ignore this.`,
  );
}

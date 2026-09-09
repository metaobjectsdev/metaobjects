/**
 * Is this file text a HUMAN wrote, or a bundler's output?
 *
 * Both advisory scanners — the base-URL one and the anti-pattern one — exist to teach the
 * author of a file something about the file. A bundle is not authored: nobody can act on a
 * finding in it, the fix belongs in the source it was built from, and naming a generated
 * artifact spends the scanners' whole false-positive budget in one line.
 *
 * The rule is a property of the ARTIFACT, not of a directory name. An estate proved why:
 * its build output is `public/`, which no ignore list would have guessed (the lists cover
 * `dist`, `build`, `.next`, `.output`, `out`), so `meta verify` reported
 * `public/main.js:243 — <EntityFetcherProvider> is mounted with no baseUrl` while
 * `client/src/main.tsx:26` — the source, the file a person edits — passes `baseUrl="/api"`
 * correctly. Adding `public` to a list would have fixed that estate and nobody else.
 *
 * The two scanners keep their own walkers, deliberately (they diverge on eight axes and
 * unifying them needs ~6 options for two callers). What they share is this judgment, so it
 * lives here once rather than being decided twice.
 */

/**
 * Bundlers emit lines in the thousands-to-hundreds-of-thousands of characters; the estate
 * bundle that produced the false positive has a longest line of 266,226. Authored source
 * does not reach 5,000 — the threshold sits an order of magnitude above the longest line
 * any human writes and an order of magnitude below what minification produces, so it is a
 * wide gap rather than a tuned one.
 *
 * NOT `>= 512KB`, which `anti-patterns.ts` already applies for a different reason (cost):
 * that gate is about how much work a scan does, and a 300KB bundle sails through it while
 * being exactly as unauthored as a 700KB one.
 */
const BUNDLED_LINE_LENGTH = 5000;

/** True when `text` looks like build output rather than source someone edits. */
export function looksBundled(text: string): boolean {
  // Scan for a long line without splitting the whole file: a 700KB bundle would otherwise
  // allocate an array of it, and this runs per file on every `meta verify` / `meta gen`.
  let lineStart = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) !== 10 /* \n */) continue;
    if (i - lineStart >= BUNDLED_LINE_LENGTH) return true;
    lineStart = i + 1;
  }
  return text.length - lineStart >= BUNDLED_LINE_LENGTH;
}

export type MatchResult =
  | { ok: true; positions: number[] }
  | { ok: false; failedAt: number; line: string };

/**
 * The ONLY way callers may turn file text into lines.
 *
 * `split("\n")` on a newline-terminated file leaves a trailing "" that matches the
 * first blank line at or after the cursor, consuming a position and skewing every
 * later elision — and every real caller reads a newline-terminated file.
 */
export function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Is every inline line present, IN ORDER, in the real generated file?
 *
 * Subsequence rather than contiguous block on purpose: the site shows exports 1, 3
 * and 7 of a file and skips the rest, so a contiguous match could not express what
 * the page already does. Compared trimmed so trailing whitespace cannot fail it.
 *
 * Catches a declaration renamed or dropped, a type changing on a shown line, and
 * reordering. Does NOT catch new output appearing in a gap — the excerpt stays true
 * but not exhaustive, and the full file ships beside it, so the addition is one
 * click away rather than hidden.
 *
 * Greedy-leftmost is a correct subsequence test: if any embedding exists, taking the
 * earliest match at each step preserves at least as much of the remaining tail.
 */
export function matchSubsequence(inline: string[], full: string[]): MatchResult {
  const positions: number[] = [];
  let cursor = 0;
  for (const [i, line] of inline.entries()) {
    const want = line.trim();
    const at = full.findIndex((l, j) => j >= cursor && l.trim() === want);
    if (at === -1) return { ok: false, failedAt: i, line };
    positions.push(at);
    cursor = at + 1;
  }
  return { ok: true, positions };
}

/**
 * Elisions are COMPUTED, not authored. Because the match knows where lines were
 * skipped, the page cannot imply contiguity it does not have — which is exactly how
 * the landing page came to claim "this exact model" while eliding three members.
 */
export function renderWithElisions(
  inline: string[], positions: number[], fullLength: number,
): string[] {
  const out: string[] = [];
  // `positions` is parallel to `inline` by construction — it is what matchSubsequence
  // returned for these very lines — so every read below is checked rather than
  // asserted, and a short array simply elides nothing instead of arithmetic on NaN.
  const first = positions[0];
  if (first !== undefined && first > 0) out.push("…");
  for (const [i, line] of inline.entries()) {
    out.push(line);
    const here = positions[i];
    const next = positions[i + 1];
    if (here !== undefined && next !== undefined && next > here + 1) out.push("…");
  }
  const last = positions[positions.length - 1];
  if (last !== undefined && last < fullLength - 1) out.push("…");
  return out;
}

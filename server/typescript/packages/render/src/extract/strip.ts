// Stage 1: remove markdown code-fence markers. Prose around the payload is left for Locate.
// Mirrors Java Strip.

// An opening fence: a run of 3+ backticks, an optional language tag (json/xml/etc, dropped), a line end.
const OPEN = /(`{3,})[a-zA-Z0-9_-]*\s*\r?\n/g;

interface Fence {
  /** Index of the opening backticks. */
  start: number;
  /** Index just past the closing backticks. */
  end: number;
  body: string;
}

/**
 * Every fenced block, in order. A fence closes at a line that starts with a backtick run at least
 * as long as the opening one and carries nothing else, so backticks inside the payload (a JSON
 * string holding `make` or a nested code sample) do not truncate it. A reply that closes on the
 * payload's own line (`{...}` + three backticks) is accepted when that run ends the text.
 */
function fences(raw: string): Fence[] {
  const out: Fence[] = [];
  OPEN.lastIndex = 0;
  for (let m = OPEN.exec(raw); m != null; m = OPEN.exec(raw)) {
    const bodyStart = m.index + m[0].length;
    const close = findClose(raw, bodyStart, m[1]?.length ?? 3);
    if (close == null) continue;
    out.push({ start: m.index, end: close.end, body: raw.substring(bodyStart, close.bodyEnd) });
    OPEN.lastIndex = close.end;
  }
  return out;
}

function findClose(raw: string, from: number, width: number): { bodyEnd: number; end: number } | null {
  for (let ls = from; ls <= raw.length; ) {
    let i = ls;
    while (i < raw.length && (raw.charAt(i) === " " || raw.charAt(i) === "\t") && i - ls < 4) i++;
    let j = i;
    while (j < raw.length && raw.charAt(j) === "`") j++;
    if (j - i >= width) {
      let k = j;
      while (k < raw.length && (raw.charAt(k) === " " || raw.charAt(k) === "\t")) k++;
      if (k >= raw.length || raw.charAt(k) === "\n" || raw.charAt(k) === "\r") {
        return { bodyEnd: bodyEnd(raw, from, ls), end: j };
      }
    }
    const nl = raw.indexOf("\n", ls);
    if (nl < 0) break;
    ls = nl + 1;
  }
  // No closing line: accept a final backtick run that ends the text on the payload's own line.
  const tail = raw.trimEnd();
  let k = tail.length;
  while (k > from && tail.charAt(k - 1) === "`") k--;
  if (tail.length - k >= width && k > from) return { bodyEnd: k, end: tail.length };
  return null;
}

function bodyEnd(raw: string, from: number, lineStart: number): number {
  let e = lineStart;
  if (e > from && raw.charAt(e - 1) === "\n") e--;
  if (e > from && raw.charAt(e - 1) === "\r") e--;
  return e;
}

export function strip(raw: string | null | undefined): string {
  if (raw == null) return "";
  const f = fences(raw)[0];
  if (f != null) return (raw.substring(0, f.start) + f.body + raw.substring(f.end)).trim();
  return raw.trim();
}

/** The body of every fenced block, in order. Locate searches these before the whole text,
 *  because a model told to fence its answer puts the answer there. */
export function fencedBodies(raw: string | null | undefined): string[] {
  if (raw == null) return [];
  return fences(raw).map((f) => f.body);
}

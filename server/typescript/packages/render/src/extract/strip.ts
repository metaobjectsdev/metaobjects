// Stage 1: remove markdown code-fence markers. Prose around the payload is left for Locate.
// Mirrors Java Strip.

// Captures the body inside a fenced block; optional language tag (json/xml/etc) is dropped.
const FENCE = /```[a-zA-Z0-9_-]*\s*\r?\n([\s\S]*?)\r?\n?```/;

export function strip(raw: string | null | undefined): string {
  if (raw == null) return "";
  const m = FENCE.exec(raw);
  if (m && m.index >= 0) {
    const before = raw.substring(0, m.index);
    const body = m[1] ?? "";
    const after = raw.substring(m.index + m[0].length);
    return (before + body + after).trim();
  }
  return raw.trim();
}

/** The body of every fenced block, in order. Locate searches these before the whole text,
 *  because a model told to fence its answer puts the answer there. */
export function fencedBodies(raw: string | null | undefined): string[] {
  if (raw == null) return [];
  const all = new RegExp(FENCE.source, "g");
  const out: string[] = [];
  for (let m = all.exec(raw); m != null; m = all.exec(raw)) out.push(m[1] ?? "");
  return out;
}

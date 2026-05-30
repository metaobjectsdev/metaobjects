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

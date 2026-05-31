// Stage-4 tolerant XML reader for the bounded corpus malformation set. Never throws.
// Mirrors Java XmlForgivingReader. Must not index-out-of-range on a leading close tag.

function quote(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Find first regex match at index >= `from` (emulates Java Matcher.find(int)). */
function matchFrom(source: string, flags: string, text: string, from: number): RegExpExecArray | null {
  const g = new RegExp(source, flags.includes("g") ? flags : flags + "g");
  g.lastIndex = from;
  return g.exec(text);
}

const OPEN_TAG_SRC = "<([A-Za-z_][A-Za-z0-9_]*)(\\s[^>]*)?>";

export function readXml(span: string | null | undefined, caseInsensitive: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (span == null || span.trim().length === 0) return out;
  const gt = span.indexOf(">");
  if (gt < 0) return out;
  const rootEnd = span.lastIndexOf("</");
  const inner = span.substring(gt + 1, rootEnd < 0 || rootEnd <= gt ? span.length : rootEnd);
  parseChildren(inner, caseInsensitive, out);
  return out;
}

function parseChildren(inner: string, ci: boolean, out: Record<string, unknown>): void {
  const flags = ci ? "i" : "";
  let pos = 0;
  for (;;) {
    const m = matchFrom(OPEN_TAG_SRC, flags, inner, pos);
    if (m == null) break;
    const tag = m[1] ?? "";
    const key = ci ? tag.toLowerCase() : tag;
    const contentStart = m.index + m[0].length;

    const closeRe = `</${quote(tag)}\\s*>`;
    const close = matchFrom(closeRe, flags, inner, contentStart);

    let contentEnd: number;
    let next: number;
    if (close != null) {
      contentEnd = close.index;
      next = close.index + close[0].length;
    } else {
      // unclosed tag: extract text up to the next sibling open tag
      const sib = matchFrom(OPEN_TAG_SRC, flags, inner, contentStart);
      if (sib != null) {
        contentEnd = sib.index;
        next = contentEnd;
      } else {
        contentEnd = inner.length;
        next = inner.length;
      }
    }

    const content = inner.substring(contentStart, contentEnd);
    const value: unknown = content.includes("<") ? nestedOrText(content, ci) : content.trim();
    accumulate(out, key, value);
    pos = next;
  }
}

function nestedOrText(content: string, ci: boolean): unknown {
  const nested: Record<string, unknown> = {};
  parseChildren(content, ci, nested);
  return Object.keys(nested).length === 0 ? content.trim() : nested;
}

function accumulate(out: Record<string, unknown>, key: string, value: unknown): void {
  if (!Object.prototype.hasOwnProperty.call(out, key)) {
    out[key] = value;
    return;
  }
  const existing = out[key];
  if (Array.isArray(existing)) {
    existing.push(value);
  } else {
    out[key] = [existing, value];
  }
}

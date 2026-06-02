// Stage-4 tolerant XML reader for the bounded corpus malformation set. Never throws.
// Mirrors Java XmlForgivingReader: maps an element's child elements, text, AND attributes
// into the field map, and handles self-closing tags (<x a="1"/>). Must not index-out-of-range
// on a leading close tag.
//
// Representation:
//   - text-only element, no attributes        → its trimmed text (string) — unchanged
//   - self-closing / attributes-only element   → a record of attribute name→value ("" when none)
//   - element with child elements (± attrs)     → a record merging attributes + child entries
//                                                  (a child element wins a name collision)
//   - element with text AND attributes          → a record of the attributes plus the body text
//                                                  under TEXT_KEY (a scalar consumer unwraps it)
//   - repeated sibling tags                     → an array (unchanged)

/** Reserved key holding an element's own text content when the element is represented as a
 *  record (because it also carries attributes). '#' is not a legal XML name char, so it never
 *  collides with a real attribute or child-element name. */
export const TEXT_KEY = "#text";

function quote(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Find first regex match at index >= `from` (emulates Java Matcher.find(int)). */
function matchFrom(source: string, flags: string, text: string, from: number): RegExpExecArray | null {
  const g = new RegExp(source, flags.includes("g") ? flags : flags + "g");
  g.lastIndex = from;
  return g.exec(text);
}

// tag name + everything up to the closing '>' (attributes and/or a trailing '/' for a
// self-closing tag). Non-greedy so the first '>' closes the open tag.
const OPEN_TAG_SRC = "<([A-Za-z_][A-Za-z0-9_]*)([^>]*?)>";
// one attribute: name = "double" | 'single' | bareword.
const ATTR_SRC = "([A-Za-z_:][A-Za-z0-9_:.\\-]*)\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s/>]+))";

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

    let rawAttrs = (m[2] ?? "").trim();
    const selfClosing = rawAttrs.endsWith("/");
    if (selfClosing) rawAttrs = rawAttrs.slice(0, -1).trim();
    const attrs = parseAttrs(rawAttrs, ci);

    if (selfClosing) {
      accumulate(out, key, Object.keys(attrs).length === 0 ? "" : attrs);
      pos = m.index + m[0].length;
      continue;
    }

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
    accumulate(out, key, combine(attrs, content, ci));
    pos = next;
  }
}

/** Combine an element's attributes with its body (nested children or plain text). */
function combine(attrs: Record<string, unknown>, content: string, ci: boolean): unknown {
  if (content.includes("<")) {
    const nested: Record<string, unknown> = {};
    parseChildren(content, ci, nested);
    if (Object.keys(nested).length > 0) {
      // attributes first; a child element wins a name collision
      return { ...attrs, ...nested };
    }
  }
  return textValue(attrs, content);
}

function textValue(attrs: Record<string, unknown>, content: string): unknown {
  const text = content.trim();
  if (Object.keys(attrs).length === 0) return text;
  return { ...attrs, [TEXT_KEY]: text };
}

function parseAttrs(rawAttrs: string, ci: boolean): Record<string, unknown> {
  const attrs: Record<string, unknown> = {};
  if (rawAttrs.length === 0) return attrs;
  const re = new RegExp(ATTR_SRC, "g");
  let a: RegExpExecArray | null;
  while ((a = re.exec(rawAttrs)) != null) {
    const rawName = a[1];
    if (rawName === undefined) continue; // group 1 is mandatory in a match; guards strict TS
    const name = ci ? rawName.toLowerCase() : rawName;
    const val = a[2] ?? a[3] ?? a[4] ?? "";
    if (!Object.prototype.hasOwnProperty.call(attrs, name)) attrs[name] = val;
  }
  return attrs;
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

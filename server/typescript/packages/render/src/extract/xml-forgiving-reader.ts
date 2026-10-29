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

/** Escape regex metacharacters (equivalent of Java Pattern.quote). */
export function quote(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Find first regex match at index >= `from` (emulates Java Matcher.find(int)). */
export function matchFrom(source: string, flags: string, text: string, from: number): RegExpExecArray | null {
  const g = new RegExp(source, flags.includes("g") ? flags : flags + "g");
  g.lastIndex = from;
  return g.exec(text);
}

// tag name + everything up to the closing '>' (attributes and/or a trailing '/' for a
// self-closing tag). Non-greedy so the first '>' closes the open tag.
const OPEN_TAG_SRC = "<([A-Za-z_][A-Za-z0-9_]*)([^>]*?)>";
// a closing tag. Used to spot a STRAY close (of an element whose open never appeared in the
// body) — LLMs commonly end a block with the wrong tag.
const CLOSE_TAG_SRC = "</([A-Za-z_][A-Za-z0-9_]*)\\s*>";
// one attribute: name = "double" | 'single' | bareword.
const ATTR_SRC = "([A-Za-z_:][A-Za-z0-9_:.\\-]*)\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s/>]+))";

const COMMENT_OPEN = "<!--";
const COMMENT_CLOSE = "-->";
const CDATA_OPEN = "<![CDATA[";
const CDATA_CLOSE = "]]>";
/** The five predefined XML entities plus numeric character references. */
const ENTITY_RE = /&(#x[0-9a-fA-F]+|#[0-9]+|lt|gt|amp|quot|apos);/g;
const NAMED_ENTITIES: Readonly<Record<string, string>> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

type XmlRegionKind = "comment" | "cdata";

/**
 * Rewrite every XML comment and CDATA section in `text` through `replace`, scanning left to
 * right so a comment marker inside CDATA (or the reverse) is never mistaken for markup. An
 * unclosed comment is left as text; an unclosed CDATA section runs to the end.
 */
function rewriteRegions(text: string, replace: (kind: XmlRegionKind, region: string) => string): string {
  let out = "";
  let pos = 0;
  let from = 0;
  for (;;) {
    const c = text.indexOf(COMMENT_OPEN, from);
    const d = text.indexOf(CDATA_OPEN, from);
    const isComment = c >= 0 && (d < 0 || c < d);
    const start = isComment ? c : d;
    if (start < 0) break;
    let end: number;
    if (isComment) {
      const e = text.indexOf(COMMENT_CLOSE, start + COMMENT_OPEN.length);
      if (e < 0) {
        from = start + COMMENT_OPEN.length;
        continue;
      }
      end = e + COMMENT_CLOSE.length;
    } else {
      const e = text.indexOf(CDATA_CLOSE, start + CDATA_OPEN.length);
      end = e < 0 ? text.length : e + CDATA_CLOSE.length;
    }
    out += text.substring(pos, start) + replace(isComment ? "comment" : "cdata", text.substring(start, end));
    pos = end;
    from = end;
  }
  return out + text.substring(pos);
}

/** `text` with comments and CDATA sections blanked to spaces (same length, so indices hold):
 *  the view the tag locators search, so markup inside them is never located. */
export function maskXmlNonMarkup(text: string): string {
  return rewriteRegions(text, (_kind, region) => " ".repeat(region.length));
}

/** Drop comments; turn each CDATA section into its text with `& < >` entity-escaped, so the
 *  tag scanner cannot split it and the entity decode restores it exactly. */
function prepareXml(text: string): string {
  return rewriteRegions(text, (kind, region) => {
    if (kind === "comment") return "";
    const body = region.endsWith(CDATA_CLOSE)
      ? region.substring(CDATA_OPEN.length, region.length - CDATA_CLOSE.length)
      : region.substring(CDATA_OPEN.length);
    return body.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  });
}

/** Decode predefined entities and numeric references in one pass (so `&amp;lt;` is `&lt;`).
 *  An unknown or out-of-range reference stays as written. */
function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(ENTITY_RE, (whole, body: string) => {
    if (!body.startsWith("#")) return NAMED_ENTITIES[body] ?? whole;
    const cp = body[1] === "x" ? parseInt(body.substring(2), 16) : parseInt(body.substring(1), 10);
    const surrogate = cp >= 0xd800 && cp <= 0xdfff;
    return cp >= 1 && cp <= 0x10ffff && !surrogate ? String.fromCodePoint(cp) : whole;
  });
}

export function readXml(rawSpan: string | null | undefined, caseInsensitive: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (rawSpan == null || rawSpan.trim().length === 0) return out;
  const span = prepareXml(rawSpan);
  const gt = span.indexOf(">");
  if (gt < 0) return out;
  const rootEnd = span.lastIndexOf("</");
  const inner = span.substring(gt + 1, rootEnd < 0 || rootEnd <= gt ? span.length : rootEnd);
  parseChildren(inner, caseInsensitive, out, null, false);
  return out;
}

/**
 * Rootless read: parse the WHOLE text's top-level elements directly, with no enclosing root
 * element to strip (a flat sequence like `<a>..</a><b>..</b>`). Used for `ExtractOptions.rootless`
 * responses. Leading/trailing non-element text is ignored. Never throws. Mirrors Java readRootless.
 */
export function readXmlRootless(
  text: string | null | undefined,
  caseInsensitive: boolean,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (text == null || text.trim().length === 0) return out;
  parseChildren(prepareXml(text), caseInsensitive, out, null, false);
  return out;
}

/**
 * Parse `inner`'s elements into `out`. When `loose` is non-null, the text BETWEEN those
 * elements (an element's own text in mixed content) is appended to it, one segment per gap.
 * `literalUnclosed` is set for the body of an element that DID close: an open tag in there with
 * no close tag anywhere after it (`List<int> and ...`) is prose, not an element.
 */
function parseChildren(
  inner: string,
  ci: boolean,
  out: Record<string, unknown>,
  loose: string[] | null,
  literalUnclosed: boolean,
): void {
  const flags = ci ? "i" : "";
  let pos = 0;
  let scan = 0;
  for (;;) {
    const m = matchFrom(OPEN_TAG_SRC, flags, inner, scan);
    if (m == null) break;
    const afterOpen = m.index + m[0].length;
    if (
      literalUnclosed &&
      !(m[2] ?? "").trimEnd().endsWith("/") &&
      matchFrom(CLOSE_TAG_SRC, flags, inner, afterOpen) == null
    ) {
      scan = afterOpen;
      continue;
    }
    loose?.push(inner.substring(pos, m.index));
    const tag = m[1] ?? "";
    const key = ci ? tag.toLowerCase() : tag;

    let rawAttrs = (m[2] ?? "").trim();
    const selfClosing = rawAttrs.endsWith("/");
    if (selfClosing) rawAttrs = rawAttrs.slice(0, -1).trim();
    const attrs = parseAttrs(rawAttrs, ci);

    if (selfClosing) {
      accumulate(out, key, Object.keys(attrs).length === 0 ? "" : attrs);
      pos = m.index + m[0].length;
      scan = pos;
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
      // unclosed tag: extract content up to the next sibling open tag.
      const sib = matchFrom(OPEN_TAG_SRC, flags, inner, contentStart);
      if (sib != null) {
        // When the unclosed element's content begins IMMEDIATELY with a child open tag
        // (no leading text), that child was almost certainly meant to be NESTED, not a
        // sibling — a common LLM malformation is dropping the parent's close tag while
        // still emitting a real child element (e.g. <check ...><payoff>text). Absorb the
        // remainder of this span as the unclosed element's content so the child nests
        // under it. When there IS leading text before the first child tag (e.g. <t>hi<c>..),
        // keep the sibling split — the leading text is the unclosed element's body and the
        // following tag is its sibling. Mirrors Java XmlForgivingReader.
        const noLeadingText = inner.substring(contentStart, sib.index).trim().length === 0;
        if (noLeadingText) {
          contentEnd = inner.length;
          next = inner.length;
        } else {
          contentEnd = sib.index;
          next = contentEnd;
        }
      } else {
        contentEnd = inner.length;
        next = inner.length;
      }
      // A STRAY close tag of another element inside the unclosed element's body ends the body
      // there (the model closed the block with the wrong tag), and the stray tag itself is
      // dropped rather than kept as literal text.
      const stray = findStrayClose(inner, contentStart, contentEnd, ci);
      if (stray != null) {
        contentEnd = stray[0];
        next = stray[1];
      }
    }

    const content = inner.substring(contentStart, contentEnd);
    accumulate(out, key, combine(attrs, content, ci, close != null));
    pos = next;
    scan = next;
  }
  loose?.push(inner.substring(pos));
}

/**
 * The first close tag in `inner[from, to)` whose element was never opened after `from` — a
 * stray close — as `[start, end]`, or `null`. A close whose open DID appear is a nested
 * child's own close, not stray.
 */
function findStrayClose(inner: string, from: number, to: number, ci: boolean): [number, number] | null {
  const flags = ci ? "i" : "";
  const bounded = inner.substring(0, to);
  let at = from;
  for (;;) {
    const close = matchFrom(CLOSE_TAG_SRC, flags, bounded, at);
    if (close == null) return null;
    const openName = close[1] ?? "";
    const openRe = `<${quote(openName)}(?=[\\s/>])`;
    const opened = matchFrom(openRe, flags, inner.substring(from, close.index), 0);
    if (opened == null) return [close.index, close.index + close[0].length];
    at = close.index + close[0].length;
  }
}

/**
 * Combine an element's attributes with its body (nested children or plain text). Mixed content
 * keeps BOTH: the children, and the element's own text under TEXT_KEY, so a scalar or
 * `@xmlText` consumer still reads the prose around a child element.
 */
function combine(attrs: Record<string, unknown>, content: string, ci: boolean, closed: boolean): unknown {
  if (content.includes("<")) {
    const nested: Record<string, unknown> = {};
    const loose: string[] = [];
    parseChildren(content, ci, nested, loose, closed);
    if (Object.keys(nested).length > 0) {
      // attributes first; a child element wins a name collision
      const merged: Record<string, unknown> = { ...attrs, ...nested };
      const text = mixedText(loose, ci);
      if (text.length > 0) merged[TEXT_KEY] = text;
      return merged;
    }
  }
  return textValue(attrs, content);
}

/** The text segments between child elements: stray close tags dropped, each trimmed, the
 *  non-empty ones joined with a single space. */
function mixedText(segments: readonly string[], ci: boolean): string {
  const closeRe = new RegExp(CLOSE_TAG_SRC, ci ? "gi" : "g");
  const parts: string[] = [];
  for (const seg of segments) {
    closeRe.lastIndex = 0;
    const t = decodeEntities(seg.replace(closeRe, "").trim());
    if (t.length > 0) parts.push(t);
  }
  return parts.join(" ");
}

function textValue(attrs: Record<string, unknown>, content: string): unknown {
  const text = decodeEntities(content.trim());
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
    const val = decodeEntities(a[2] ?? a[3] ?? a[4] ?? "");
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

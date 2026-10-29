// Stages 2-3: isolate and select the payload root span.
// JSON: Extract picks among jsonCandidates by the schema (fenced first, first object carrying a
// declared field); locateJson (first-closed-else-first-open) is its fallback. Mirrors Java Locate.

import { commentEnd } from "./json-forgiving-reader.js";
import { maskXmlNonMarkup } from "./xml-forgiving-reader.js";

/** The characters a JSON comment may follow: whitespace or a structural separator. */
const COMMENT_MAY_FOLLOW = /[\s,{[]/;

/** Escape regex metacharacters (equivalent of Java Pattern.quote). */
function quote(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** First balanced {...}; if none closes, first '{' to end; null if no '{'. */
export function locateJson(text: string | null | undefined): string | null {
  if (text == null) return null;
  let firstOpen = -1;
  for (let i = 0; i < text.length; i++) {
    if (text.charAt(i) === "{") {
      if (firstOpen < 0) firstOpen = i;
      const end = scanBalanced(text, i);
      if (end >= 0) return text.substring(i, end + 1);
    }
  }
  return firstOpen < 0 ? null : text.substring(firstOpen);
}

/**
 * Every top-level object span in `text`, in order: each balanced {...} (nested objects are
 * part of their parent, not separate spans), and, for a '{' that never closes, the text from
 * it to the end.
 */
export function jsonCandidates(text: string | null | undefined): string[] {
  if (text == null) return [];
  const out: string[] = [];
  let tailAdded = false;
  for (let i = 0; i < text.length; i++) {
    if (text.charAt(i) !== "{") continue;
    const end = scanBalanced(text, i);
    if (end >= 0) {
      out.push(text.substring(i, end + 1));
      i = end;
    } else if (!tailAdded) {
      out.push(text.substring(i));
      tailAdded = true;
    }
  }
  return out;
}

/**
 * Returns index of the matching '}', or -1 if unterminated. String-aware, and comment-aware:
 * a `//` or `/* *\/` comment that opens after whitespace or a separator is skipped, so a brace
 * or quote inside it (`// good } really`) cannot close the object early. `http://x` (after a
 * colon or a letter) is not a comment.
 */
function scanBalanced(s: string, open: number): number {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = open; i < s.length; i++) {
    const c = s.charAt(i);
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (i > open && COMMENT_MAY_FOLLOW.test(s.charAt(i - 1))) {
      const end = commentEnd(s, i);
      if (end >= 0) {
        i = end - 1;
        continue;
      }
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Span of <root>...</root>; if close absent, opener to end; null if no opener. Comments and
 * CDATA are not searched, and when another opener of the same root sits between the first one
 * and its close (the tag mentioned in prose, then the real element) the span starts at the
 * LAST such opener: a root does not nest in itself.
 */
export function locateXml(
  text: string | null | undefined,
  rootName: string | null | undefined,
  caseInsensitive: boolean,
): string | null {
  if (text == null || rootName == null) return null;
  const flags = caseInsensitive ? "i" : "";
  const view = maskXmlNonMarkup(text);
  const openSrc = `<${quote(rootName)}(\\s[^>]*)?>`;
  const open = new RegExp(openSrc, flags).exec(view);
  if (open == null) return null;
  const openEnd = open.index + open[0].length;

  // Search for the close tag at-or-after the opener's end (Java close.find(open.end())).
  const close = matchFrom(new RegExp(`</${quote(rootName)}\\s*>`, flags), view, openEnd);
  if (close == null) return text.substring(open.index);
  let start = open.index;
  for (let at = openEnd; ; ) {
    const next = matchFrom(new RegExp(openSrc, flags), view, at);
    if (next == null || next.index >= close.index) break;
    start = next.index;
    at = next.index + next[0].length;
  }
  return text.substring(start, close.index + close[0].length);
}

/** Find the first regex match at index >= `from` (emulates Java Matcher.find(int)). */
function matchFrom(re: RegExp, text: string, from: number): RegExpExecArray | null {
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  g.lastIndex = from;
  return g.exec(text);
}

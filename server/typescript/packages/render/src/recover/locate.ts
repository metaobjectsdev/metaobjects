// Stages 2-3: isolate and select the payload root span.
// Selection rule: first-closed-else-first-open. Mirrors Java Locate.

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

/** Returns index of the matching '}', or -1 if unterminated. String-aware. */
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
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Span of <root>...</root>; if close absent, opener to end; null if no opener. */
export function locateXml(
  text: string | null | undefined,
  rootName: string | null | undefined,
  caseInsensitive: boolean,
): string | null {
  if (text == null || rootName == null) return null;
  const flags = caseInsensitive ? "i" : "";
  const open = new RegExp(`<${quote(rootName)}(\\s[^>]*)?>`, flags).exec(text);
  if (open == null) return null;
  const start = open.index;
  const openEnd = open.index + open[0].length;

  const closeRe = new RegExp(`</${quote(rootName)}\\s*>`, flags);
  closeRe.lastIndex = openEnd;
  // Search for the close tag at-or-after the opener's end (Java close.find(open.end())).
  const close = matchFrom(closeRe, text, openEnd);
  if (close != null) return text.substring(start, close.index + close[0].length);
  return text.substring(start);
}

/** Find the first regex match at index >= `from` (emulates Java Matcher.find(int)). */
function matchFrom(re: RegExp, text: string, from: number): RegExpExecArray | null {
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  g.lastIndex = from;
  return g.exec(text);
}

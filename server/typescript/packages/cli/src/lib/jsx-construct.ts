/**
 * The text of one opening JSX tag or call expression, and its top-level attribute names.
 *
 * Lifted out of `base-url-advisory.ts` when a second advisory (F99, the removed `value`
 * prop) needed exactly the same tokenizer. This is a shared PRIMITIVE, not a shared walker
 * — the two advisories keep their own directory walks deliberately, because they disagree
 * about what to scan and have diverged on purpose.
 */

/**
 * The text of the construct that begins at `start`.
 *
 * JSX: up to the `>` that closes the opening TAG. Call this a one-file tokenizer rather
 * than a bracket count, because a bracket count is what the first version was and it was
 * wrong in both directions:
 *
 *   <EntityFetcherProvider title="a > b" fetcher={f} baseUrl="/api">
 *       → the `>` inside the STRING ended the tag before `baseUrl`, warning about a
 *         correct provider.
 *   <EntityFetcherProvider fetcher={mk(")")}>
 *       → the unbalanced `)` inside a string meant depth never returned to 0, so the
 *         4000-char cap swallowed an unrelated `baseUrl` later in the file and SUPPRESSED
 *         a real finding.
 *
 * So string literals (all three quote styles, with escapes), line comments and block
 * comments are skipped rather than counted. A regex literal is deliberately NOT handled —
 * telling `/` division from a regex needs real parsing, and a regex inside a JSX opening
 * tag is vanishingly rare next to the cost of getting it wrong.
 *
 * Call: to the `)` balancing the argument list, so a nested object or arrow does not end
 * it early.
 *
 * Both bail after a generous cap rather than scanning a whole minified file when a
 * construct is unterminated.
 */
export function constructText(src: string, start: number, kind: "jsx" | "call"): string {
  const limit = Math.min(src.length, start + 4000);
  let depth = 0;
  for (let i = start; i < limit; i++) {
    const c = src[i]!;

    // --- skip what is not code -------------------------------------------------
    if (c === '"' || c === "'" || c === "`") {
      i++;
      while (i < limit && src[i] !== c) { if (src[i] === "\\") i++; i++; }
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < limit && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < limit && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i++;
      continue;
    }

    // --- code ------------------------------------------------------------------
    if (kind === "jsx" && c === ">" && depth === 0) return src.slice(start, i + 1);
    if (c === "{" || c === "(" || c === "[") depth++;
    else if (c === "}" || c === ")" || c === "]") {
      if (kind === "call" && depth === 1 && c === ")") return src.slice(start, i + 1);
      depth--;
    }
  }
  return src.slice(start, limit);
}

/**
 * The attribute names written directly on an opening tag — depth 0 only.
 *
 * Depth is the whole point. `constructText` returns the tag INCLUDING every nested
 * expression, so a substring test for `value=` convicts all of these, none of which pass
 * `value` to the tag:
 *
 *   <P fetcher={mk({ value: 1 })}>          an object key
 *   <P fetcher={o.value === 1 ? a : b}>     a comparison — note `=` is the first of `===`
 *   <P fetcher={<Inner value={9} />}>       a DIFFERENT component's prop
 *
 * Strings and comments are skipped for the same reason they are in `constructText`, so a
 * `title="pass value={x} here"` is prose, not an attribute.
 *
 * An identifier counts only when the next non-space character is a single `=` (not `=>`,
 * not `==`). A valueless boolean attribute (`<P disabled>`) is therefore not reported —
 * correct here, since every prop these advisories care about takes a value.
 */
export function topLevelAttrs(tag: string): Set<string> {
  const out = new Set<string>();
  let depth = 0;
  // Start past the tag name so the component's own name is never read as an attribute.
  let i = 0;
  while (i < tag.length && !/\s/.test(tag[i]!)) i++;

  for (; i < tag.length; i++) {
    const c = tag[i]!;
    if (c === '"' || c === "'" || c === "`") {
      i++;
      while (i < tag.length && tag[i] !== c) { if (tag[i] === "\\") i++; i++; }
      continue;
    }
    if (c === "/" && tag[i + 1] === "/") { while (i < tag.length && tag[i] !== "\n") i++; continue; }
    if (c === "/" && tag[i + 1] === "*") {
      i += 2;
      while (i < tag.length && !(tag[i] === "*" && tag[i + 1] === "/")) i++;
      i++;
      continue;
    }
    if (c === "{" || c === "(" || c === "[") { depth++; continue; }
    if (c === "}" || c === ")" || c === "]") { depth--; continue; }
    if (depth !== 0) continue;

    if (/[A-Za-z_$]/.test(c)) {
      const start = i;
      while (i < tag.length && /[A-Za-z0-9_$-]/.test(tag[i]!)) i++;
      const name = tag.slice(start, i);
      let j = i;
      while (j < tag.length && /\s/.test(tag[j]!)) j++;
      if (tag[j] === "=" && tag[j + 1] !== "=" && tag[j + 1] !== ">") out.add(name);
      i--; // the for-loop's i++ re-reads the delimiter we stopped on
    }
  }
  return out;
}

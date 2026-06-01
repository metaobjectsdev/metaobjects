/**
 * Split a SQL script into its top-level statements on `;` boundaries, ignoring
 * separators that fall inside string literals, quoted identifiers, comments, or
 * dollar-quoted blocks. The single source of truth for statement splitting —
 * used both when applying migration files ({@link ../apply/apply.ts}) and when
 * post-processing emitted DDL for the D1 target ({@link ../emit/d1-safety-pass.ts}).
 *
 * Returned statements are trimmed and DO NOT include the trailing `;`
 * separator; callers that need a terminator re-add one.
 */
export function splitSqlStatements(text: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let i = 0;
  const n = text.length;

  while (i < n) {
    const ch = text[i];
    const next = text[i + 1];

    // -- line comment: skip to end of line (or input).
    if (ch === "-" && next === "-") {
      i += 2;
      while (i < n && text[i] !== "\n") i++;
      continue;
    }

    // /* block comment */: skip to closing delimiter (or input).
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2; // consume the closing */ (clamped by the while below)
      continue;
    }

    // Single-quoted literal: consume to the closing quote, treating '' as escape.
    if (ch === "'") {
      i++;
      while (i < n) {
        if (text[i] === "'" && text[i + 1] === "'") {
          i += 2; // embedded ''
          continue;
        }
        if (text[i] === "'") {
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    // Double-quoted identifier: consume to the closing quote, treating "" as escape.
    if (ch === '"') {
      i++;
      while (i < n) {
        if (text[i] === '"' && text[i + 1] === '"') {
          i += 2; // embedded ""
          continue;
        }
        if (text[i] === '"') {
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    // Dollar-quoted string: $tag$ … $tag$ with tag = [A-Za-z0-9_]*.
    if (ch === "$") {
      const open = matchDollarTag(text, i);
      if (open !== null) {
        const tag = text.slice(i, open); // includes both $ delimiters
        i = open;
        // Scan for the matching closing tag.
        while (i < n) {
          if (text[i] === "$" && text.startsWith(tag, i)) {
            i += tag.length;
            break;
          }
          i++;
        }
        continue;
      }
    }

    // Statement separator (only reached when in no special state).
    if (ch === ";") {
      const stmt = text.slice(start, i).trim();
      if (stmt.length > 0) statements.push(stmt);
      i++;
      start = i;
      continue;
    }

    i++;
  }

  const tail = text.slice(start).trim();
  if (tail.length > 0) statements.push(tail);
  return statements;
}

/**
 * If a dollar-quote tag opens at `pos` (text[pos] === "$"), return the index
 * just past the opening `$tag$` delimiter; otherwise null. The tag body is
 * `[A-Za-z0-9_]*` and must be terminated by a second `$`.
 */
function matchDollarTag(text: string, pos: number): number | null {
  let j = pos + 1;
  while (j < text.length && /[A-Za-z0-9_]/.test(text[j] as string)) j++;
  if (text[j] === "$") return j + 1;
  return null;
}

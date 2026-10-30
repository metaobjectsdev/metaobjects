/**
 * Split a SQL script into its top-level statements on `;` boundaries, ignoring
 * separators that fall inside string literals, quoted identifiers, comments, or
 * dollar-quoted blocks. The single source of truth for statement splitting —
 * used both when applying migration files ({@link ../apply/apply.ts}) and when
 * post-processing emitted DDL for the D1 target ({@link ../emit/d1-safety-pass.ts}).
 *
 * Two engine rules a plain `;` scan gets wrong are honoured: a SQLite
 * `CREATE [TEMP] TRIGGER … BEGIN … END` is ONE statement (its body holds `;`; as in
 * `sqlite3_complete`, only an `END` that follows a `;` closes it, so a `CASE … END`
 * inside a body does not), and, on Postgres only, an `E'…'` literal treats `\` as an escape, so
 * `E'it\'s; fine'` is one literal.
 *
 * Returned statements are trimmed and DO NOT include the trailing `;`
 * separator; callers that need a terminator re-add one.
 *
 * A fragment made only of comments and whitespace is NOT a statement and is dropped
 * by default. Handing one to a driver is not harmless: libsql reports the empty
 * prepare as the error `SQLITE_OK: not an error`, which is how a generated down.sql
 * ending in a `-- WARNING…` block failed every rollback. A comment that LEADS a real
 * statement stays attached to it. Re-emitters that must preserve the prose (the D1
 * safety pass rewrites a file it does not execute) pass `keepCommentOnly`.
 */
export type SplitSqlDialect = "postgres" | "sqlite" | "mysql" | "d1";

export interface SplitSqlOptions {
  /**
   * The engine the script targets. Only Postgres reads `E'…'` as a backslash-escaped
   * literal; on SQLite, MySQL and D1 `e'\'` is the identifier-ish word `e` followed by
   * an ordinary literal. Omitted means Postgres (the original behaviour).
   */
  dialect?: SplitSqlDialect;
  /** Keep comment-only fragments in the result (re-emitters only — never execute them). */
  keepCommentOnly?: boolean;
}

export function splitSqlStatements(text: string, opts: SplitSqlOptions = {}): string[] {
  const statements: string[] = [];
  let start = 0;
  let i = 0;
  const n = text.length;
  const backslashEscapes = (opts.dialect ?? "postgres") === "postgres";
  // Whether the current fragment holds anything besides comments and whitespace.
  let hasCode = false;
  // Trigger tracking (per statement): the leading words, whether we are inside the
  // BEGIN … END body, whether the previous token was `;`, and whether END was just seen.
  let leadWords: string[] = [];
  let inTriggerBody = false;
  let afterSemi = false;
  let afterEnd = false;
  const resetStatement = (): void => {
    leadWords = [];
    inTriggerBody = false;
    afterSemi = false;
    afterEnd = false;
  };
  const isTriggerStart = (): boolean =>
    leadWords[0] === "CREATE" &&
    (leadWords[1] === "TRIGGER" || ((leadWords[1] === "TEMP" || leadWords[1] === "TEMPORARY") && leadWords[2] === "TRIGGER"));
  const pushFragment = (fragment: string): void => {
    const stmt = fragment.trim();
    if (stmt.length === 0) return;
    if (hasCode || opts.keepCommentOnly === true) statements.push(stmt);
  };

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

    if (ch !== ";" && !/\s/.test(ch as string)) hasCode = true;

    // A bare word: feeds trigger detection, and an `E` prefix opens a backslash-escaped literal.
    if (/[A-Za-z_]/.test(ch as string)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(text[j] as string)) j++;
      const word = text.slice(i, j).toUpperCase();
      if (word === "E" && text[j] === "'" && backslashEscapes) {
        i = skipBackslashLiteral(text, j);
        afterSemi = false;
        afterEnd = false;
        continue;
      }
      if (leadWords.length < 3) leadWords.push(word);
      if (inTriggerBody) {
        afterEnd = afterSemi && word === "END";
      } else if (word === "BEGIN" && isTriggerStart()) {
        inTriggerBody = true;
      }
      afterSemi = false;
      i = j;
      continue;
    }
    if (inTriggerBody && ch !== ";" && !/\s/.test(ch as string)) {
      afterSemi = false;
      afterEnd = false;
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
    if (ch === ";" && inTriggerBody && !afterEnd) {
      afterSemi = true;
      i++;
      continue;
    }
    if (ch === ";") {
      resetStatement();
      pushFragment(text.slice(start, i));
      hasCode = false;
      i++;
      start = i;
      continue;
    }

    i++;
  }

  pushFragment(text.slice(start));
  return statements;
}

/** Skip a Postgres `E'…'` literal starting at the opening quote; `\x` and `''` escape. */
function skipBackslashLiteral(text: string, quote: number): number {
  let i = quote + 1;
  while (i < text.length) {
    if (text[i] === "\\") {
      i += 2;
      continue;
    }
    if (text[i] === "'") {
      if (text[i + 1] === "'") {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i++;
  }
  return i;
}

/**
 * The statement with any leading `--` / block comments and whitespace removed, for
 * callers that classify a statement by its first keyword.
 */
export function stripLeadingComments(stmt: string): string {
  let i = 0;
  const n = stmt.length;
  for (;;) {
    while (i < n && /\s/.test(stmt[i] as string)) i++;
    if (stmt.startsWith("--", i)) {
      while (i < n && stmt[i] !== "\n") i++;
      continue;
    }
    if (stmt.startsWith("/*", i)) {
      const end = stmt.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    return stmt.slice(i);
  }
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

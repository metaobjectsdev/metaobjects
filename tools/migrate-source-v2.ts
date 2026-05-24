// tools/migrate-source-v2.ts
//
// One-off bulk migration for the source-v2 TypeScript work + reserved-word fix.
//
// Applies four rules to JSON files and TS test/source files alike:
//
//   1. `{ "source.dbTable": { ...@name: "X"... } }`
//        → `{ "source.rdb":      { ...@table: "X"... } }`
//      `{ "source.dbView":  { ...@name: "X"... } }`
//        → `{ "source.rdb":      { "@kind": "view", ...@table: "X"... } }`
//      Other body attrs (`@schema`, etc.) are preserved unchanged.
//      If `@kind` is already present on a dbView body it is NOT overwritten.
//
//   2. `"@dbColumn": "X"` → `"@column": "X"` (anywhere on a field.* body)
//
//   3. `"@isArray": <bool>` → `"isArray": <bool>` (bare structural — reserved
//      word must not carry the @-prefix; runtime parser will soon enforce this
//      with ERR_RESERVED_ATTR).
//
//   4. A per-file change summary is printed to stdout.
//
// Run modes:
//   bun tools/migrate-source-v2.ts --dry-run   # show planned changes, no writes
//   bun tools/migrate-source-v2.ts             # apply changes
//
// The script is committed as a future-port reference: the Java + Python +
// C# implementations will need an equivalent transformation when their
// fixtures migrate.
//
// Safety
// ------
// - Excludes `fixtures/conformance/` (already migrated in Task 7), and the
//   usual `node_modules`, `.git`, `.claude/worktrees`, `dist`, `build` dirs.
// - JSON files are parsed → walked → re-emitted with 2-space indent + trailing
//   newline (canonical-form-compatible).
// - TS files use a brace-balanced, string-aware scanner to locate
//   `source.dbTable` / `source.dbView` body spans; inside those spans `@name`
//   is rewritten to `@table`. Global string replacements handle `@dbColumn`
//   and `@isArray`. The script verifies up-front that those two tokens only
//   appear as object keys (never inside other syntax that would break a
//   blind replace).
// - Idempotent: running it twice is a no-op (only matches the old tokens).

import { readFileSync, writeFileSync, statSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(__dirname, "..");

const SCAN_ROOTS: ReadonlyArray<string> = [
  "server/typescript/packages",
];

const EXCLUDED_DIR_NAMES: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".turbo",
  "coverage",
]);

// Path-prefix excludes (relative to REPO_ROOT).
const EXCLUDED_PATH_PREFIXES: ReadonlyArray<string> = [
  ".claude/worktrees",
  "fixtures/conformance",
];

const ALLOWED_EXTENSIONS: ReadonlySet<string> = new Set([".json", ".ts"]);

// ---------------------------------------------------------------------------
// Token constants (the migration vocabulary)
// ---------------------------------------------------------------------------

const KEY_SOURCE_DB_TABLE = "source.dbTable";
const KEY_SOURCE_DB_VIEW = "source.dbView";
const KEY_SOURCE_RDB = "source.rdb";

const ATTR_NAME = "@name";
const ATTR_TABLE = "@table";
const ATTR_KIND = "@kind";
const ATTR_DB_COLUMN = "@dbColumn";
const ATTR_COLUMN = "@column";
const ATTR_IS_ARRAY = "@isArray";
const KEY_IS_ARRAY = "isArray";

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const DRY_RUN = process.argv.includes("--dry-run");

// ---------------------------------------------------------------------------
// File walking
// ---------------------------------------------------------------------------

function isExcluded(absPath: string): boolean {
  const rel = relative(REPO_ROOT, absPath);
  for (const prefix of EXCLUDED_PATH_PREFIXES) {
    if (rel === prefix || rel.startsWith(prefix + "/")) return true;
  }
  return false;
}

function walk(absDir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(absDir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (EXCLUDED_DIR_NAMES.has(name)) continue;
    const full = join(absDir, name);
    if (isExcluded(full)) continue;
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walk(full, out);
      continue;
    }
    if (!st.isFile()) continue;
    const dotIdx = name.lastIndexOf(".");
    if (dotIdx < 0) continue;
    const ext = name.slice(dotIdx);
    if (!ALLOWED_EXTENSIONS.has(ext)) continue;
    out.push(full);
  }
}

// ---------------------------------------------------------------------------
// Per-file change counters
// ---------------------------------------------------------------------------

interface ChangeStats {
  sourceDbTable: number;
  sourceDbView: number;
  dbColumn: number;
  isArray: number;
}

function emptyStats(): ChangeStats {
  return { sourceDbTable: 0, sourceDbView: 0, dbColumn: 0, isArray: 0 };
}

function statsEmpty(s: ChangeStats): boolean {
  return s.sourceDbTable === 0 && s.sourceDbView === 0 && s.dbColumn === 0 && s.isArray === 0;
}

function formatStats(s: ChangeStats): string {
  const parts: string[] = [];
  if (s.sourceDbTable > 0) parts.push(`dbTable→rdb=${s.sourceDbTable}`);
  if (s.sourceDbView > 0) parts.push(`dbView→rdb=${s.sourceDbView}`);
  if (s.dbColumn > 0) parts.push(`@dbColumn→@column=${s.dbColumn}`);
  if (s.isArray > 0) parts.push(`@isArray→isArray=${s.isArray}`);
  return parts.join(", ");
}

// ---------------------------------------------------------------------------
// JSON transformation (AST-aware)
// ---------------------------------------------------------------------------

function transformJsonValue(value: unknown, stats: ChangeStats): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => transformJsonValue(v, stats));
  }
  if (value === null || typeof value !== "object") return value;

  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const key of Object.keys(obj)) {
    let newKey: string = key;
    let newVal: unknown = obj[key];

    if (key === KEY_SOURCE_DB_TABLE || key === KEY_SOURCE_DB_VIEW) {
      // Rewrite wrapper key + transform body
      const body = newVal;
      if (body !== null && typeof body === "object" && !Array.isArray(body)) {
        const bodyObj = body as Record<string, unknown>;
        const bodyOut: Record<string, unknown> = {};

        // For dbView, inject @kind: "view" first IF not already present.
        const isView = key === KEY_SOURCE_DB_VIEW;
        const hasKind = Object.prototype.hasOwnProperty.call(bodyObj, ATTR_KIND);
        if (isView && !hasKind) bodyOut[ATTR_KIND] = "view";

        for (const bKey of Object.keys(bodyObj)) {
          const remapped = bKey === ATTR_NAME ? ATTR_TABLE : bKey;
          bodyOut[remapped] = transformJsonValue(bodyObj[bKey], stats);
        }
        newVal = bodyOut;
      } else {
        // Body isn't an object — leave it (parser will reject it anyway).
        newVal = transformJsonValue(newVal, stats);
      }

      newKey = KEY_SOURCE_RDB;
      if (key === KEY_SOURCE_DB_TABLE) stats.sourceDbTable += 1;
      else stats.sourceDbView += 1;
    } else if (key === ATTR_DB_COLUMN) {
      newKey = ATTR_COLUMN;
      newVal = transformJsonValue(newVal, stats);
      stats.dbColumn += 1;
    } else if (key === ATTR_IS_ARRAY) {
      newKey = KEY_IS_ARRAY;
      newVal = transformJsonValue(newVal, stats);
      stats.isArray += 1;
    } else {
      newVal = transformJsonValue(newVal, stats);
    }

    out[newKey] = newVal;
  }

  return out;
}

function migrateJson(content: string, stats: ChangeStats): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined; // not valid JSON; skip
  }
  const transformed = transformJsonValue(parsed, stats);
  if (statsEmpty(stats)) return undefined;
  return JSON.stringify(transformed, null, 2) + "\n";
}

// ---------------------------------------------------------------------------
// TS transformation (string-aware, brace-balanced scanner)
// ---------------------------------------------------------------------------

interface ScanContext {
  src: string;
  i: number;
}

/** Skip a string literal starting at `start` (src[start] is the opening quote). */
function skipStringLiteral(src: string, start: number): number {
  const quote = src[start];
  let i = start + 1;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    // Template literals: skip ${...} interpolations (with balanced braces).
    if (quote === "`" && ch === "$" && src[i + 1] === "{") {
      i += 2;
      let depth = 1;
      while (i < src.length && depth > 0) {
        const c = src[i]!;
        if (c === '"' || c === "'" || c === "`") {
          i = skipStringLiteral(src, i);
          continue;
        }
        if (c === "{") depth += 1;
        else if (c === "}") depth -= 1;
        i += 1;
      }
      continue;
    }
    if (ch === quote) return i + 1;
    i += 1;
  }
  return src.length;
}

/**
 * Given an index of a `{` opening the body of a `source.dbTable`/`dbView`
 * wrapper, return the index of the matching `}`. Respects strings/comments.
 */
function matchBrace(src: string, openIdx: number): number {
  if (src[openIdx] !== "{") throw new Error(`Expected '{' at ${openIdx}, got '${src[openIdx]}'`);
  let depth = 1;
  let i = openIdx + 1;
  while (i < src.length && depth > 0) {
    const ch = src[i]!;
    if (ch === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i + 2);
      i = nl < 0 ? src.length : nl + 1;
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end < 0 ? src.length : end + 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipStringLiteral(src, i);
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  throw new Error(`No matching '}' for '{' at ${openIdx}`);
}

/**
 * Sanity-check: confirm @dbColumn and @isArray appear only in renamable
 * positions — either:
 *   (a) as an object-literal key: `"@dbColumn":` (followed by `:`), or
 *   (b) as a bracket-property accessor: `["@dbColumn"]` (preceded by `[`,
 *       followed by `]`).
 * Both are semantically references to the metadata attribute and must be
 * renamed together. If anything else is found, abort with a loud message.
 */
function assertKeyOnlyTokens(src: string, relPath: string): void {
  const checks: ReadonlyArray<string> = ['"@dbColumn"', '"@isArray"'];
  for (const token of checks) {
    let from = 0;
    while (true) {
      const idx = src.indexOf(token, from);
      if (idx < 0) break;

      // Look ahead for ':' (object-key) or ']' (bracket access).
      let j = idx + token.length;
      while (j < src.length && /\s/.test(src[j]!)) j += 1;
      const afterCh = src[j];

      // Look back: bracket access only matters when preceded by '['.
      let k = idx - 1;
      while (k >= 0 && /\s/.test(src[k]!)) k -= 1;
      const beforeCh = k >= 0 ? src[k] : "";

      const isObjectKey = afterCh === ":";
      const isBracketAccess = beforeCh === "[" && afterCh === "]";
      if (!isObjectKey && !isBracketAccess) {
        throw new Error(
          `Non-key/non-bracket occurrence of ${token} in ${relPath} at offset ${idx} ` +
            `(before='${beforeCh}', after='${afterCh}'). Aborting to avoid mangling.`,
        );
      }
      from = idx + token.length;
    }
  }
}

function migrateTs(content: string, stats: ChangeStats, relPath: string): string | undefined {
  // Quick path: file has none of the target tokens — no work to do.
  if (
    !content.includes(`"${KEY_SOURCE_DB_TABLE}"`) &&
    !content.includes(`"${KEY_SOURCE_DB_VIEW}"`) &&
    !content.includes(`"${ATTR_DB_COLUMN}"`) &&
    !content.includes(`"${ATTR_IS_ARRAY}"`)
  ) {
    return undefined;
  }

  assertKeyOnlyTokens(content, relPath);

  let out = content;

  // --- Rule 1: source.dbTable / source.dbView wrapper rewrites ---
  // The wrapper key is itself a quoted string literal in JS/TS object syntax
  // (`"source.dbTable":`). String-aware scanning would skip past it, so we
  // simply seek the literal token directly — it's structurally unique enough
  // to not appear in unrelated positions.
  for (const wrapperKey of [KEY_SOURCE_DB_TABLE, KEY_SOURCE_DB_VIEW] as const) {
    const quotedWrapper = `"${wrapperKey}"`;
    let searchFrom = 0;
    while (true) {
      const wrapIdx = out.indexOf(quotedWrapper, searchFrom);
      if (wrapIdx < 0) break;

      // After the wrapper key, find `:`, then `{`.
      let j = wrapIdx + quotedWrapper.length;
      while (j < out.length && /\s/.test(out[j]!)) j += 1;
      if (out[j] !== ":") {
        // Not an object-key occurrence (e.g. inside a string mentioning the
        // token). Skip past and keep searching.
        searchFrom = wrapIdx + quotedWrapper.length;
        continue;
      }
      j += 1;
      while (j < out.length && /\s/.test(out[j]!)) j += 1;
      if (out[j] !== "{") {
        throw new Error(
          `Expected '{' after ${quotedWrapper}: at ${wrapIdx} in ${relPath} (got '${out[j]}')`,
        );
      }
      const openIdx = j;
      const closeIdx = matchBrace(out, openIdx);

      // Body span is (openIdx+1) .. closeIdx-1.
      const bodyStart = openIdx + 1;
      const bodyText = out.slice(bodyStart, closeIdx);

      // 1a. Replace `"@name"` (as a key) → `"@table"` inside the body.
      const bodyTextWithTable = rewriteAttrNameKey(bodyText);

      // 1b. For dbView, insert `"@kind": "view"` IF body does not already
      // mention `"@kind"`.
      let finalBody = bodyTextWithTable;
      if (wrapperKey === KEY_SOURCE_DB_VIEW && !/"@kind"\s*:/.test(bodyText)) {
        finalBody = injectKindView(bodyTextWithTable);
      }

      // 1c. Splice: replace the wrapper key + body in `out`.
      const before = out.slice(0, wrapIdx);
      const newWrapper = `"${KEY_SOURCE_RDB}"`;
      // Keep the same `: { ... }` structure but with the new wrapper + new body.
      const after = out.slice(closeIdx); // includes the closing `}`
      // Reconstruct the bit between wrapper-end and openIdx exactly as it was
      // (preserves whitespace).
      const middle = out.slice(wrapIdx + quotedWrapper.length, openIdx + 1);
      out = before + newWrapper + middle + finalBody + after;

      if (wrapperKey === KEY_SOURCE_DB_TABLE) stats.sourceDbTable += 1;
      else stats.sourceDbView += 1;

      // Advance past the rewrite (length may have shifted; recompute).
      searchFrom = before.length + newWrapper.length + middle.length + finalBody.length;
    }
  }

  // --- Rule 2: @dbColumn → @column (key only) ---
  // Safe global replace: we already verified above that "@dbColumn" only
  // appears as an object key.
  const dbColumnPattern = /"@dbColumn"/g;
  const dbColumnMatches = out.match(dbColumnPattern);
  if (dbColumnMatches !== null) {
    stats.dbColumn += dbColumnMatches.length;
    out = out.replace(dbColumnPattern, `"${ATTR_COLUMN}"`);
  }

  // --- Rule 3: @isArray → isArray (key only) ---
  const isArrayPattern = /"@isArray"/g;
  const isArrayMatches = out.match(isArrayPattern);
  if (isArrayMatches !== null) {
    stats.isArray += isArrayMatches.length;
    out = out.replace(isArrayPattern, `"${KEY_IS_ARRAY}"`);
  }

  if (statsEmpty(stats)) return undefined;
  return out;
}

/** Within a source body, replace the `"@name"` *key* (followed by `:`) with `"@table"`. */
function rewriteAttrNameKey(body: string): string {
  // Match `"@name"` followed by optional whitespace then `:`.
  return body.replace(/"@name"(\s*:)/g, `"${ATTR_TABLE}"$1`);
}

/**
 * Inject `"@kind": "view"` as the FIRST key of a source body. Body text is
 * the content between `{` and `}` (exclusive). We preserve the body's
 * leading whitespace style so the result keeps round-trip formatting.
 */
function injectKindView(body: string): string {
  // Find the first non-whitespace character; if the body is empty or only
  // whitespace, fall back to a simple insert.
  const m = /^\s*/.exec(body);
  const leading = m !== null ? m[0] : "";
  const rest = body.slice(leading.length);

  // If the body is empty, just write `"@kind": "view"`.
  if (rest === "" || rest === undefined) {
    return `${leading}"${ATTR_KIND}": "view"`;
  }

  // Otherwise insert `"@kind": "view", ` before the first key.
  // The body already starts with a key (e.g. `"@table": "x"`), so a `, `
  // separator after the injected pair is safe.
  return `${leading}"${ATTR_KIND}": "view", ${rest}`;
}

// ---------------------------------------------------------------------------
// Per-file dispatch
// ---------------------------------------------------------------------------

interface FileResult {
  path: string;
  stats: ChangeStats;
  newContent: string | undefined;
}

function migrateFile(absPath: string): FileResult {
  const stats = emptyStats();
  const relPath = relative(REPO_ROOT, absPath);
  const content = readFileSync(absPath, "utf8");

  let newContent: string | undefined;
  if (absPath.endsWith(".json")) {
    newContent = migrateJson(content, stats);
  } else if (absPath.endsWith(".ts")) {
    newContent = migrateTs(content, stats, relPath);
  }

  return { path: absPath, stats, newContent };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const allFiles: string[] = [];
  for (const root of SCAN_ROOTS) {
    walk(join(REPO_ROOT, root), allFiles);
  }
  allFiles.sort();

  const results: FileResult[] = [];
  for (const f of allFiles) {
    try {
      const r = migrateFile(f);
      if (r.newContent !== undefined) results.push(r);
    } catch (err) {
      console.error(`[ERROR] ${relative(REPO_ROOT, f)}: ${(err as Error).message}`);
      process.exit(1);
    }
  }

  if (results.length === 0) {
    console.log(`No changes needed (${allFiles.length} files scanned).`);
    return;
  }

  const verb = DRY_RUN ? "would modify" : "modifying";
  console.log(`Migration ${DRY_RUN ? "(DRY RUN)" : ""}: ${verb} ${results.length} file(s):\n`);
  for (const r of results) {
    const rel = relative(REPO_ROOT, r.path);
    console.log(`  ${rel}  [${formatStats(r.stats)}]`);
    if (!DRY_RUN && r.newContent !== undefined) {
      writeFileSync(r.path, r.newContent, "utf8");
    }
  }

  // Roll-ups
  const tot = results.reduce<ChangeStats>(
    (acc, r) => ({
      sourceDbTable: acc.sourceDbTable + r.stats.sourceDbTable,
      sourceDbView: acc.sourceDbView + r.stats.sourceDbView,
      dbColumn: acc.dbColumn + r.stats.dbColumn,
      isArray: acc.isArray + r.stats.isArray,
    }),
    emptyStats(),
  );
  console.log(`\nTotals: ${formatStats(tot)}`);
}

main();

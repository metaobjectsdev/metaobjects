// server/typescript/packages/metadata/src/vocabulary-rewrite.ts
//
// The raw-document rewriter behind `meta upgrade`.
//
// WHY IT CANNOT USE THE LOADER — the constraint that shapes everything here. Once an
// attribute is deregistered, metadata carrying it FAILS THE LOAD; that is the point of a
// retirement. So load → transform → canonical-serialize is impossible: the input does not
// load, and the canonical serializer needs a loaded model. This operates on RAW TEXT.
//
// That is also what makes the upgrade path exist at all. An adopter installs the new CLI and
// runs this against metadata the new CLI REFUSES. A fixer that needed a successful load
// would be a chicken-and-egg with no exit.
//
// SURGICAL, NOT PARSE-AND-REPRINT. Adopters author JSONC with comments and meaningful key
// order — `meta gen`'s output order, review conventions, "do not reorder" notes. A
// round-trip through JSON.parse/stringify destroys all of it while reporting success. So
// every edit here is a span replacement on the original text, and any region we did not
// deliberately change comes back byte-identical.
//
// IT REFUSES WHAT IT CANNOT KNOW. A retirement with no `rewrite` (`@status: abandoned`) is
// reported, never guessed at. Deleting the node, retyping it, and fixing the residue it
// describes are all defensible, and a wrong guess emits metadata that LOADS and means
// something different — strictly worse than leaving it alone, because the adopter would
// believe the migration finished.

import {
  RETIRED_VOCABULARY,
  type RetiredEntry,
  type RetirementNote,
} from "./retired-vocabulary.js";

export interface RewriteChange {
  /** Attribute name, without the sigil. */
  readonly attr: string;
  readonly from: string;
  readonly to: string;
  /** 1-indexed line in the ORIGINAL document. */
  readonly line: number;
}

export interface RewriteRefusal extends RetirementNote {
  readonly attr: string;
  readonly value?: string;
  readonly line: number;
}

export interface RewriteResult {
  readonly text: string;
  readonly changes: readonly RewriteChange[];
  readonly refusals: readonly RewriteRefusal[];
}

export interface RewriteOpts {
  /** `"<type>.<subType>"` the document's nodes belong to. Retirements are TYPE-SCOPED —
   *  `@unique` is retired on `identity.secondary` and live on a field — so without a scope
   *  the rewriter would have to guess, and a wrong guess deletes valid declarations. */
  readonly typeKeyHint: string;
  /** YAML authoring is sigil-free (the desugar re-adds `@`), so keys are matched bare. */
  readonly format?: "json" | "yaml";
  /** Only apply retirements at or before this version. */
  readonly maxVersion?: string;
}

/** `0.24.0` → `[0,24,0]`, for an ordered comparison rather than a string one. */
function parts(v: string): number[] {
  return v.split(".").map((n) => Number.parseInt(n, 10) || 0);
}

function atOrBefore(a: string, b: string): boolean {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d < 0;
  }
  return true;
}

function scopeMatches(entry: RetiredEntry, typeKey: string): boolean {
  const dot = typeKey.indexOf(".");
  if (dot < 0) return false;
  if (entry.type !== typeKey.slice(0, dot)) return false;
  return entry.subType === "*" || entry.subType === typeKey.slice(dot + 1);
}

function noteOf(e: RetiredEntry): RetirementNote {
  return {
    since: e.since,
    why: e.why,
    ...(e.replacedBy !== undefined ? { replacedBy: e.replacedBy } : {}),
    ...(e.migration !== undefined ? { migration: e.migration } : {}),
  };
}

/** 1-indexed line of `index` in `text`. */
function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === "\n") line++;
  return line;
}

/**
 * Matches `"@name"` (JSON) or bare `name` at a YAML key position, plus the value that
 * follows, capturing the pieces separately so a replacement can keep the original spacing.
 *
 * Deliberately NOT a full parser. A parser would have to reproduce the document to emit it,
 * which is the thing this exists to avoid; matching a key occurrence lets every untouched
 * byte survive by construction.
 */
function keyPattern(attr: string, yaml: boolean): RegExp {
  return yaml
    ? new RegExp(`(^[ \\t]*)(${attr})(\\s*:)`, "gm")
    : new RegExp(`("@?${attr}")(\\s*:\\s*)`, "g");
}

/** The JSON value token starting at `from` — a scalar, or a bracketed array/object. */
function valueSpan(text: string, from: number): { end: number; raw: string } | undefined {
  let i = from;
  while (i < text.length && /\s/.test(text[i] ?? "")) i++;
  const open = text[i];
  if (open === "[" || open === "{") {
    const close = open === "[" ? "]" : "}";
    let depth = 0;
    let inStr = false;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (inStr) {
        if (c === "\\") j++;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === open) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) return { end: j + 1, raw: text.slice(i, j + 1) };
      }
    }
    return undefined;
  }
  // Scalar: to the next comma, closing brace, or newline, whichever comes first.
  let j = i;
  let inStr = false;
  for (; j < text.length; j++) {
    const c = text[j];
    if (inStr) {
      if (c === "\\") j++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "," || c === "}" || c === "\n") break;
  }
  return { end: j, raw: text.slice(i, j).trim() };
}

/** Does the raw token equal this literal? Compares JSON-decoded where possible so
 *  `"readOnly"` and `readOnly` both match a string literal. */
function rawEquals(raw: string, want: unknown): boolean {
  try {
    return JSON.parse(raw) === want;
  } catch {
    return raw === String(want);
  }
}

/**
 * Rewrite retired vocabulary in one raw metadata document.
 *
 * Pure: no filesystem, no loader, no registry. Returns the new text plus every change and
 * every refusal, so a caller can print a diff and exit non-zero when work remains.
 */
export function rewriteDocument(source: string, opts: RewriteOpts): RewriteResult {
  const yaml = opts.format === "yaml";
  const changes: RewriteChange[] = [];
  const refusals: RewriteRefusal[] = [];

  // Edits are collected as spans against the ORIGINAL text and applied in one pass at the
  // end, right-to-left. Rewriting incrementally would invalidate every later offset.
  const edits: { start: number; end: number; text: string }[] = [];

  const applicable = RETIRED_VOCABULARY.filter(
    (e) =>
      e.attr !== undefined &&
      scopeMatches(e, opts.typeKeyHint) &&
      (opts.maxVersion === undefined || atOrBefore(e.since, opts.maxVersion)),
  );

  for (const entry of applicable) {
    const attr = entry.attr as string;
    const re = keyPattern(attr, yaml);
    let m: RegExpExecArray | null;

    while ((m = re.exec(source)) !== null) {
      const keyStart = yaml ? m.index + (m[1]?.length ?? 0) : m.index;
      const afterKey = m.index + m[0].length;
      const line = lineAt(source, keyStart);
      const span = valueSpan(source, afterKey);

      // A VALUE-scoped retirement only fires on the retired values. `@dbColumnType: jsonb`
      // is live vocabulary on the same attribute; touching it would silently change the
      // column type.
      if (entry.attrValues !== undefined) {
        const raw = span?.raw ?? "";
        const hit = entry.attrValues.some((v) => rawEquals(raw, v));
        if (!hit) continue;
      }

      if (entry.rewrite === undefined) {
        refusals.push({
          ...noteOf(entry),
          attr,
          ...(span?.raw !== undefined ? { value: span.raw } : {}),
          line,
        });
        continue;
      }

      const rw = entry.rewrite;
      if (rw.kind === "renameAttr") {
        const to = yaml ? rw.to : `"@${rw.to}"`;
        edits.push({ start: keyStart, end: keyStart + (yaml ? attr.length : m[1]?.length ?? 0), text: to });
        changes.push({ attr, from: attr, to: rw.to, line });
      } else if (rw.kind === "dropAttr") {
        if (span === undefined) continue;
        // Take the trailing comma and the line's own whitespace with it, so removing a
        // middle key does not leave a dangling `,` or a blank line behind.
        let end = span.end;
        while (end < source.length && /[ \t]/.test(source[end] ?? "")) end++;
        if (source[end] === ",") end++;
        let start = keyStart;
        while (start > 0 && /[ \t]/.test(source[start - 1] ?? "")) start--;
        if (source[start - 1] === "\n" && source[end] === "\n") end++;
        else if (start > 0 && source[start - 1] !== "\n") start = keyStart;
        edits.push({ start, end, text: "" });
        changes.push({ attr, from: attr, to: "(removed)", line });
      } else {
        // renameAttrValue — only the stated `fromValue` arm is mechanical.
        if (span === undefined || !rawEquals(span.raw, rw.fromValue)) continue;
        const keyText = yaml ? rw.toAttr : `"@${rw.toAttr}"`;
        const valText = JSON.stringify(rw.toValue);
        edits.push({ start: keyStart, end: keyStart + (yaml ? attr.length : (m[1]?.length ?? 0)), text: keyText });
        edits.push({ start: source.indexOf(span.raw, afterKey), end: span.end, text: valText });
        changes.push({ attr, from: `${attr}: ${span.raw}`, to: `${rw.toAttr}: ${valText}`, line });
      }
    }
  }

  edits.sort((a, b) => b.start - a.start);
  let text = source;
  for (const e of edits) text = text.slice(0, e.start) + e.text + text.slice(e.end);

  return { text, changes, refusals };
}

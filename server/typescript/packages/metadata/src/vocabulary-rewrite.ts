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
// IT SCOPES EVERY OCCURRENCE, NOT EVERY FILE. Retirements are type-scoped — `@unique` is
// retired on `identity.secondary` and perfectly live on a field — so the governing type is
// a property of WHERE the attribute sits, not of the document it sits in. A file-level
// scope was the original shape and it was wrong in both directions: a caller that ran one
// pass per type key present in the file let the `identity.secondary` scope reach a
// `field.string`'s `@unique` (branding live vocabulary retired, and with a `dropAttr` entry
// DELETING it), and reported every wildcard-scoped refusal once per subtype key in the file.
// `scopeRanges` below recovers the enclosing `"<type>.<subType>"` for each occurrence, so
// one pass over the document answers both correctly.
//
// CANONICAL JSON ONLY. YAML authoring is real (ADR-0006) but is not rewritable here: a
// correct YAML editor needs the `yaml` package's CST, and this module is reachable from
// `src/index.ts`, which the browser-safety test forbids from importing it. A hand-rolled
// YAML mode was tried and shipped a file-corrupting bug — a multi-item block sequence lost
// every item but the first, because the value scanner stops at a newline — while the
// dominant in-repo authoring style (flow mappings, `{ name: x, readOnly: true }`) was not
// matched at all, so the rename silently did nothing. `meta upgrade` refuses YAML by name
// instead; a refusal an adopter can act on beats a success they cannot trust.
//
// IT REFUSES WHAT IT CANNOT KNOW. A retirement with no `rewrite` (`@status: abandoned`) is
// reported, never guessed at. Deleting the node, retyping it, and fixing the residue it
// describes are all defensible, and a wrong guess emits metadata that LOADS and means
// something different — strictly worse than leaving it alone, because the adopter would
// believe the migration finished.

import {
  RETIRED_VOCABULARY,
  note,
  scopeMatches,
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
  /** What was refused, ready to print: `@status` for an attribute, `origin.collection` for
   *  a retired subtype. Carries its own sigil so a caller never has to guess which. */
  readonly subject: string;
  readonly value?: string;
  readonly line: number;
}

export interface RewriteResult {
  readonly text: string;
  readonly changes: readonly RewriteChange[];
  readonly refusals: readonly RewriteRefusal[];
}

export interface RewriteOpts {
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

/** 1-indexed line of `index` in `text`. */
function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === "\n") line++;
  return line;
}

/**
 * Offset just past the bracket closing the one at `open`, or undefined if unbalanced.
 * String-aware, so a brace inside a JSON string literal cannot unbalance the scan.
 */
function closingBracket(text: string, open: number): number | undefined {
  const close = text[open] === "[" ? "]" : "}";
  const openCh = text[open];
  let depth = 0;
  let inStr = false;
  for (let j = open; j < text.length; j++) {
    const c = text[j];
    if (inStr) {
      if (c === "\\") j++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === openCh) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return j + 1;
    }
  }
  return undefined;
}

/** One `{ "<type>.<subType>": { … } }` node body, and where it sits in the text. */
interface ScopeRange {
  readonly typeKey: string;
  /** Offset of the opening quote of the type key — where a reader would point. */
  readonly keyIndex: number;
  readonly bodyStart: number;
  readonly bodyEnd: number;
}

/**
 * Every node body in the document, in source order.
 *
 * A canonical-JSON node is `{ "<type>.<subType>": { …body… } }`, so an attribute belongs to
 * the INNERMOST body containing it — which is what makes per-occurrence scoping possible
 * without a parser we deliberately do not have.
 */
function scopeRanges(source: string): ScopeRange[] {
  const ranges: ScopeRange[] = [];
  const re = /"([a-z][A-Za-z0-9]*)\.([A-Za-z0-9_*]+)"\s*:\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const bodyStart = m.index + m[0].length - 1;
    const bodyEnd = closingBracket(source, bodyStart);
    if (bodyEnd === undefined) continue;
    ranges.push({ typeKey: `${m[1]}.${m[2]}`, keyIndex: m.index, bodyStart, bodyEnd });
  }
  return ranges;
}

/** The type key governing `offset` — the innermost body containing it. */
function scopeAt(ranges: readonly ScopeRange[], offset: number): string | undefined {
  let best: ScopeRange | undefined;
  for (const r of ranges) {
    if (offset <= r.bodyStart || offset >= r.bodyEnd) continue;
    // Properly nested ranges: the innermost containing one starts last.
    if (best === undefined || r.bodyStart > best.bodyStart) best = r;
  }
  return best?.typeKey;
}

/**
 * Matches `"@name"` at a key position, plus the separator that follows, capturing the key
 * separately so a replacement can keep the original spacing.
 *
 * Deliberately NOT a full parser. A parser would have to reproduce the document to emit it,
 * which is the thing this exists to avoid; matching a key occurrence lets every untouched
 * byte survive by construction.
 */
function keyPattern(attr: string): RegExp {
  return new RegExp(`("@?${attr}")(\\s*:\\s*)`, "g");
}

/** The JSON value token starting at `from` — a scalar, or a bracketed array/object. */
function valueSpan(text: string, from: number): { start: number; end: number; raw: string } | undefined {
  let i = from;
  while (i < text.length && /\s/.test(text[i] ?? "")) i++;
  const open = text[i];
  if (open === "[" || open === "{") {
    const end = closingBracket(text, i);
    return end === undefined ? undefined : { start: i, end, raw: text.slice(i, end) };
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
  return { start: i, end: j, raw: text.slice(i, j).trim() };
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
 * The span to delete so that removing a key leaves loadable JSON.
 *
 * The arithmetic is fiddly and every branch is load-bearing, so it lives here with its
 * steps named rather than inline in the dispatch below.
 */
function dropSpan(source: string, keyStart: number, valueEnd: number): { start: number; end: number } {
  // 1. Absorb the value's trailing spaces, then its trailing comma if it has one.
  let end = valueEnd;
  while (end < source.length && /[ \t]/.test(source[end] ?? "")) end++;
  const hadTrailingComma = source[end] === ",";
  if (hadTrailingComma) end++;

  // 2. Absorb the key's own indentation, so the removal does not leave a ragged line.
  let start = keyStart;
  while (start > 0 && /[ \t]/.test(source[start - 1] ?? "")) start--;

  // 3. THE LAST-KEY CASE, found by dogfooding rather than by a unit test: when the retired
  //    attr is last in its object there IS no trailing comma — the comma belongs to the
  //    PRECEDING key. Dropping without taking it leaves `"...",\n}`, which does not parse.
  //    A tool whose whole job is producing loadable metadata cannot emit invalid JSON.
  if (!hadTrailingComma) {
    let back = start;
    while (back > 0 && /\s/.test(source[back - 1] ?? "")) back--;
    if (source[back - 1] === ",") start = back - 1;
  }

  // 4. If the key owned its whole line, take the line terminator too rather than leaving a
  //    blank line. Otherwise the key shares a line with other content, so undo step 2's
  //    indentation trim — it would eat the separating space after the preceding key's comma.
  if (source[start - 1] === "\n" && source[end] === "\n") end++;
  else if (start > 0 && source[start - 1] !== "\n" && hadTrailingComma) start = keyStart;

  return { start, end };
}

/**
 * Rewrite retired vocabulary in one raw canonical-JSON metadata document.
 *
 * Pure: no filesystem, no loader, no registry. Returns the new text plus every change and
 * every refusal, so a caller can print a diff and exit non-zero when work remains.
 */
export function rewriteDocument(source: string, opts: RewriteOpts = {}): RewriteResult {
  const changes: RewriteChange[] = [];
  const refusals: RewriteRefusal[] = [];

  // Edits are collected as spans against the ORIGINAL text and applied in one pass at the
  // end, right-to-left. Rewriting incrementally would invalidate every later offset.
  const edits: { start: number; end: number; text: string }[] = [];

  const inWindow = (e: RetiredEntry): boolean =>
    opts.maxVersion === undefined || atOrBefore(e.since, opts.maxVersion);
  const ranges = scopeRanges(source);

  // A retired SUBTYPE has no attribute to rewrite — the node itself has to be re-modelled
  // (`origin.collection` becomes `origin.aggregate @agg: collect`), which is a judgment the
  // adopter makes. Reporting it is what keeps `meta upgrade` from exiting 0 on a document
  // that still will not load; it used to be filtered out entirely and was invisible.
  for (const r of ranges) {
    for (const entry of RETIRED_VOCABULARY) {
      if (entry.isSubTypeRetirement !== true || !inWindow(entry)) continue;
      if (`${entry.type}.${entry.subType}` !== r.typeKey) continue;
      refusals.push({ ...note(entry), subject: r.typeKey, line: lineAt(source, r.keyIndex) });
    }
  }

  for (const entry of RETIRED_VOCABULARY.filter((e) => e.attr !== undefined && inWindow(e))) {
    const attr = entry.attr as string;
    const re = keyPattern(attr);
    let m: RegExpExecArray | null;

    while ((m = re.exec(source)) !== null) {
      const keyStart = m.index;
      const keyEnd = keyStart + (m[1]?.length ?? 0);
      const afterKey = m.index + m[0].length;

      // Scope is decided HERE, per occurrence, from the enclosing node.
      const scope = scopeAt(ranges, keyStart);
      if (scope === undefined || !scopeMatches(entry, scope)) continue;

      const line = lineAt(source, keyStart);
      const span = valueSpan(source, afterKey);

      // A VALUE-scoped retirement only fires on the retired values. `@dbColumnType: jsonb`
      // is live vocabulary on the same attribute; touching it would silently change the
      // column type.
      if (entry.attrValues !== undefined) {
        if (!entry.attrValues.some((v) => rawEquals(span?.raw ?? "", v))) continue;
      }

      const refuse = (): void => {
        refusals.push({
          ...note(entry),
          subject: `@${attr}`,
          ...(span?.raw !== undefined ? { value: span.raw } : {}),
          line,
        });
      };

      const drop = (): void => {
        if (span === undefined) return;
        const { start, end } = dropSpan(source, keyStart, span.end);
        edits.push({ start, end, text: "" });
        changes.push({ attr, from: attr, to: "(removed)", line });
      };

      const rw = entry.rewrite;
      if (rw === undefined) refuse();
      else if (rw.kind === "renameAttr") {
        edits.push({ start: keyStart, end: keyEnd, text: `"@${rw.to}"` });
        changes.push({ attr, from: attr, to: rw.to, line });
      } else if (rw.kind === "dropAttr") drop();
      else if (span === undefined) continue;
      else if (rawEquals(span.raw, rw.fromValue)) {
        const valText = JSON.stringify(rw.toValue);
        edits.push({ start: keyStart, end: keyEnd, text: `"@${rw.toAttr}"` });
        edits.push({ start: span.start, end: span.end, text: valText });
        changes.push({ attr, from: `${attr}: ${span.raw}`, to: `${rw.toAttr}: ${valText}`, line });
      }
      // Every other value of a retired attribute still has to go somewhere — the entry says
      // which, and the type makes saying it mandatory.
      else if (rw.otherwise === "drop") drop();
      else refuse();
    }
  }

  edits.sort((a, b) => b.start - a.start);
  let text = source;
  for (const e of edits) text = text.slice(0, e.start) + e.text + text.slice(e.end);

  return { text, changes, refusals };
}

// server/typescript/packages/metadata/src/core/vocabulary-rewrite-yaml.ts
//
// The YAML arm of the raw-document rewriter behind `meta upgrade`.
//
// WHY IT IS A SEPARATE MODULE. `vocabulary-rewrite.ts` is reachable from `src/index.ts`, so
// it may not import `yaml` — that package is Node-only and would land in the browser bundle.
// This file carries the `yaml` dependency and is reachable ONLY through its own package
// subpath, which `meta upgrade` dynamic-imports. Same split, and same reason, as
// `yaml-positions.ts` / `yaml-positions-walker.ts` (see that file's header).
//
// WHY IT IS PARSER-DRIVEN WHERE THE JSON ARM IS REGEX-DRIVEN. A hand-rolled YAML mode was
// tried once and shipped a file-corrupting bug: a multi-item block sequence lost every item
// but the first, because a hand-written value scanner stops at a newline, and the dominant
// in-repo flow style (`{ name: x, readOnly: true }`) was not matched at all — so the rename
// silently did nothing. Both failures are the same failure: YAML's value extent is not
// derivable by scanning. Here the PARSER reports it. `pair.value.range` covers a four-line
// block sequence and a one-line flow mapping alike, so neither case is a special case.
//
// STILL SURGICAL, NOT PARSE-AND-REPRINT. `doc.toString()` would reflow an adopter's file —
// line width, quote style, indentation of flow collections — and hand them a diff whose real
// changes are invisible inside it. So the parse is used only to LOCATE spans; every edit is a
// span replacement on the original text, and any region not deliberately changed comes back
// byte-identical. That is the same guarantee the JSON arm makes, by the same means.
//
// IT ALSO RESOLVES ATTRIBUTE CONTRADICTIONS (`../attr-contradictions.ts`), matched per NODE
// rather than per pair — the illegal thing is the PAIR of keys, so the unit is the mapping
// that holds one node's own keys. `eachNodeBody` below is that walk. Doing it by proximity
// instead was tried in the JSON arm and took a `fields` belonging to a sibling node.
//
// SIGIL-FREE, PER ADR-0006. YAML authoring writes bare attribute keys (`violation:`) and the
// desugar re-adds the `@` when lowering to canonical JSON. So a rename emits a BARE key here
// where the JSON arm emits `"@name"`. A leading `@` is still matched on input — an author who
// wrote one gets it fixed rather than skipped — but is never introduced.

import { LineCounter, isMap, isSeq, parseDocument, type Node, type Pair } from "yaml";
import { ATTR_CONTRADICTIONS, contradictionScopeMatches } from "../attr-contradictions.js";
import {
  RETIRED_VOCABULARY,
  note,
  scopeMatches,
  type RetiredEntry,
} from "../retired-vocabulary.js";
import type { RewriteChange, RewriteRefusal, RewriteOpts, RewriteResult } from "../vocabulary-rewrite.js";

/**
 * A rewrite result that can also report "I could not read this file".
 *
 * A YAML document that does not parse yields no changes and no refusals, which is
 * indistinguishable from a clean one — and a fixer that reports a file it could not open as
 * clean is the exact defect this arm was written to remove (#339). The flag makes the caller
 * say so out loud.
 */
export interface YamlRewriteResult extends RewriteResult {
  readonly unparseable: boolean;
}

/** A canonical node key: `<type>.<subType>`. Identical to the JSON arm's scope shape. */
const TYPE_KEY = /^[a-z][A-Za-z0-9]*\.[A-Za-z0-9_*]+$/;

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

/** The plain string a mapping key carries, or undefined when it is not a plain scalar. */
function keyText(key: unknown): string | undefined {
  const v = (key as { value?: unknown } | null)?.value;
  return typeof v === "string" ? v : undefined;
}

/** Source offsets of a pair's key and of the end of its value. */
function pairSpan(pair: Pair): { keyStart: number; keyEnd: number; valueEnd: number } | undefined {
  const k = pair.key as { range?: [number, number, number] } | null;
  const v = pair.value as { range?: [number, number, number] } | null;
  if (k?.range === undefined) return undefined;
  return {
    keyStart: k.range[0],
    keyEnd: k.range[1],
    // A valueless key (`verifiedBy:` with nothing after it) still has to be removable.
    valueEnd: v?.range?.[1] ?? k.range[1],
  };
}

/**
 * The span to delete so that removing a pair leaves loadable YAML.
 *
 * Two shapes, and they need opposite treatment — which is precisely what the previous
 * hand-rolled attempt got wrong by handling only one.
 */
function dropSpan(
  source: string,
  span: { keyStart: number; valueEnd: number },
  flow: boolean,
): { start: number; end: number } | undefined {
  let { keyStart: start } = span;
  let end = span.valueEnd;

  if (flow) {
    // `{ a: 1, readOnly: true }` — take a trailing comma if there is one, else a preceding
    // one, so the mapping ends up with neither a dangling nor a doubled separator.
    //
    // The probe must not commit: scanning forward over the spaces and THEN finding `}`
    // rather than `,` would leave `end` past the space that separates the survivor from the
    // brace, silently reformatting `{ name: x }` into `{ name: x}`.
    let probe = end;
    while (probe < source.length && /[ \t]/.test(source[probe] ?? "")) probe++;
    if (source[probe] === ",") {
      end = probe + 1;
      while (end < source.length && /[ \t]/.test(source[end] ?? "")) end++;
    } else {
      let back = start;
      while (back > 0 && /\s/.test(source[back - 1] ?? "")) back--;
      if (source[back - 1] === ",") start = back - 1;
    }
    return { start, end };
  }

  // Block mapping — the pair owns whole lines. Absorb its indentation and its line
  // terminator, so removal leaves neither a ragged line nor a blank one.
  while (start > 0 && /[ \t]/.test(source[start - 1] ?? "")) start--;

  // A pair that is the first key of a block SEQUENCE item (`- verifiedBy: x`) shares its
  // line with the `-`. Deleting it would strand the dash and silently change the sequence's
  // shape, so this refuses rather than guesses — the caller reports it as needing a hand.
  if (source[start - 1] === "-") return undefined;

  // A multi-line value (a block sequence) already ends ON the newline that closes its last
  // item, so the terminator is spent. Consuming another one here would delete the FOLLOWING
  // key — which is the multi-item-sequence corruption this arm exists to avoid, arriving by
  // a different route.
  if (end === 0 || source[end - 1] !== "\n") {
    while (end < source.length && /[ \t]/.test(source[end] ?? "")) end++;
    // A trailing comment on the key's own line goes with the key it annotates.
    if (source[end] === "#") while (end < source.length && source[end] !== "\n") end++;
    if (source[end] === "\n") end++;
  }
  return { start, end };
}

/** Visit every mapping pair with the `<type>.<subType>` scope governing it. */
function eachPair(
  node: unknown,
  scope: string | undefined,
  visit: (pair: Pair, scope: string | undefined, flow: boolean) => void,
): void {
  if (isMap(node)) {
    const flow = node.flow === true;
    for (const pair of node.items) {
      const k = keyText(pair.key);
      visit(pair, scope, flow);
      // A type key scopes its own BODY, not itself — so the pair above is reported under the
      // enclosing scope while its value descends under this one.
      const inner = k !== undefined && TYPE_KEY.test(k) ? k : scope;
      if (pair.value != null) eachPair(pair.value, inner, visit);
    }
    return;
  }
  if (isSeq(node)) {
    for (const item of node.items) eachPair(item as Node, scope, visit);
  }
}

/** A node's own key set: the mapping that a `<type>.<subType>:` key introduces. */
interface NodeBody {
  readonly items: readonly Pair[];
  readonly flow: boolean;
}

/**
 * Visit every node BODY in the document.
 *
 * The unit is the body rather than the pair because a contradiction is a property of a
 * SIBLING SET. `body.items` is exactly this node's own keys — a child node lives inside the
 * value of a `children:` pair, so it is reached by recursion and never mistaken for a
 * sibling.
 */
function eachNodeBody(node: unknown, visit: (typeKey: string, body: NodeBody) => void): void {
  if (isMap(node)) {
    for (const pair of node.items) {
      const k = keyText(pair.key);
      if (k !== undefined && TYPE_KEY.test(k) && isMap(pair.value)) {
        visit(k, { items: pair.value.items as Pair[], flow: pair.value.flow === true });
      }
      if (pair.value != null) eachNodeBody(pair.value, visit);
    }
    return;
  }
  if (isSeq(node)) {
    for (const item of node.items) eachNodeBody(item as Node, visit);
  }
}

/** An authored `@` must not hide a key from either table; the sigil is never introduced. */
function bareKey(pair: Pair): string | undefined {
  const k = keyText(pair.key);
  if (k === undefined) return undefined;
  return k.startsWith("@") ? k.slice(1) : k;
}

/** Does this pair carry a string that actually says something? */
function suppliesText(pair: Pair): boolean {
  const v = (pair.value as { value?: unknown } | null)?.value;
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * Rewrite retired vocabulary in one raw YAML metadata document.
 *
 * Pure: no filesystem, no loader, no registry. Mirrors `rewriteDocument`'s contract exactly —
 * same result shape, same scoping rule, same refusal policy — so `meta upgrade` reports a
 * YAML estate and a JSON estate identically.
 */
export function rewriteYamlDocument(source: string, opts: RewriteOpts = {}): YamlRewriteResult {
  const changes: RewriteChange[] = [];
  const refusals: RewriteRefusal[] = [];
  const edits: { start: number; end: number; text: string }[] = [];

  const lineCounter = new LineCounter();
  const doc = parseDocument(source, { lineCounter, keepSourceTokens: true });
  // A document we cannot parse is a document we must not edit. Reporting nothing here is
  // correct: `meta verify` owns malformed YAML, and guessing at spans in a broken file is
  // how a fixer corrupts one.
  if (doc.errors.length > 0 || doc.contents == null) {
    return { text: source, changes, refusals, unparseable: true };
  }

  const lineOf = (offset: number): number => lineCounter.linePos(offset).line;
  const inWindow = (e: RetiredEntry): boolean =>
    opts.maxVersion === undefined || atOrBefore(e.since, opts.maxVersion);

  // ── Attribute contradictions: two LIVE attrs that may not sit on one node ──
  //
  // THE TWO SIDES ARE ASKED DIFFERENT QUESTIONS, mirroring the loader's Rule 1a exactly
  // (`validation-passes.ts`, `hasFieldsAttr` vs `hasExpr`) and the JSON arm's copy of it.
  // The DROP side counts on PRESENCE — an empty `fields: []` beside `expr` is still a
  // declaration of both, and is the case where the discard is total. The KEEP side counts
  // only when it supplies a key, so a blank `expr: ""` beside `fields` is a plain column
  // index the loader accepts and this must leave alone.
  //
  // IT SEES ONLY THIS NODE'S OWN KEYS. A node declaring `expr` while INHERITING `fields`
  // through `extends` contradicts itself in the loaded model and not on the page; no
  // raw-document rewriter can resolve a super-reference, so that stays the loader's refusal.
  eachNodeBody(doc.contents, (typeKey, body) => {
    for (const c of ATTR_CONTRADICTIONS) {
      if (opts.maxVersion !== undefined && !atOrBefore(c.since, opts.maxVersion)) continue;
      if (!contradictionScopeMatches(c, typeKey)) continue;
      if (!body.items.some((p) => bareKey(p) === c.keep && suppliesText(p))) continue;

      for (const pair of body.items) {
        if (bareKey(pair) !== c.drop) continue;
        const span = pairSpan(pair);
        if (span === undefined) continue;
        const d = dropSpan(source, span, body.flow);
        // Undeletable in place (a sequence item's leading key) — leave it, and let the
        // loader keep refusing rather than reshape the author's sequence.
        if (d === undefined) continue;
        edits.push({ ...d, text: "" });
        changes.push({
          attr: c.drop,
          from: c.drop,
          to: `(removed — ${c.keep} keys this node)`,
          line: lineOf(span.keyStart),
        });
      }
    }
  });

  eachPair(doc.contents, undefined, (pair, scope, flow) => {
    const key = keyText(pair.key);
    if (key === undefined) return;
    const span = pairSpan(pair);
    if (span === undefined) return;

    // A retired SUBTYPE has no attribute to rewrite — the node itself has to be re-modelled,
    // which is the adopter's judgment. Reporting it is what keeps `meta upgrade` from exiting
    // 0 on a document that still will not load.
    if (TYPE_KEY.test(key)) {
      for (const entry of RETIRED_VOCABULARY) {
        if (entry.isSubTypeRetirement !== true || !inWindow(entry)) continue;
        if (`${entry.type}.${entry.subType}` !== key) continue;
        refusals.push({ ...note(entry), subject: key, line: lineOf(span.keyStart) });
      }
      return;
    }

    // Sigil-free authoring is the norm, but an authored `@` must not make a retirement
    // invisible.
    const bare = key.startsWith("@") ? key.slice(1) : key;
    const raw = source.slice(span.keyEnd, span.valueEnd).replace(/^\s*:\s*/, "").trim();
    const line = lineOf(span.keyStart);

    for (const entry of RETIRED_VOCABULARY) {
      if (entry.attr !== bare || !inWindow(entry)) continue;
      if (scope === undefined || !scopeMatches(entry, scope)) continue;

      // A VALUE-scoped retirement only fires on the retired values — the same attribute with
      // a live value must come through untouched.
      if (entry.attrValues !== undefined && !entry.attrValues.some((v) => raw === v || raw === `"${v}"` || raw === `'${v}'`)) {
        continue;
      }

      const refuse = (): void => {
        refusals.push({ ...note(entry), subject: `@${bare}`, ...(raw !== "" ? { value: raw } : {}), line });
      };
      const drop = (): void => {
        const d = dropSpan(source, span, flow);
        // Undeletable in place (a sequence item's leading key) — report it instead of
        // producing YAML that parses as something else.
        if (d === undefined) {
          refuse();
          return;
        }
        edits.push({ ...d, text: "" });
        changes.push({ attr: bare, from: bare, to: "(removed)", line });
      };

      const rw = entry.rewrite;
      if (rw === undefined) refuse();
      else if (rw.kind === "renameAttr") {
        // Preserve the author's quoting style; YAML keys are usually bare, but a quoted key
        // must stay quoted or the surrounding style stops being self-consistent.
        const rawKey = source.slice(span.keyStart, span.keyEnd);
        const q = rawKey[0] === '"' || rawKey[0] === "'" ? rawKey[0] : "";
        edits.push({ start: span.keyStart, end: span.keyEnd, text: `${q}${rw.to}${q}` });
        changes.push({ attr: bare, from: bare, to: rw.to, line });
      } else if (rw.kind === "dropAttr") drop();
      else if (raw === String(rw.fromValue) || raw === `"${rw.fromValue}"` || raw === `'${rw.fromValue}'`) {
        const valText = typeof rw.toValue === "string" ? String(rw.toValue) : JSON.stringify(rw.toValue);
        edits.push({ start: span.keyStart, end: span.keyEnd, text: rw.toAttr });
        edits.push({ start: span.keyEnd, end: span.valueEnd, text: `: ${valText}` });
        changes.push({ attr: bare, from: `${bare}: ${raw}`, to: `${rw.toAttr}: ${valText}`, line });
      } else if (rw.otherwise === "drop") drop();
      else refuse();
    }
  });

  // Applied right-to-left against the ORIGINAL text: rewriting incrementally would invalidate
  // every later offset.
  edits.sort((a, b) => b.start - a.start);
  let text = source;
  for (const e of edits) text = text.slice(0, e.start) + e.text + text.slice(e.end);

  return { text, changes, refusals, unparseable: false };
}

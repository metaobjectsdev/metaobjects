#!/usr/bin/env bun
/**
 * Shipped-example vocabulary gate (#337).
 *
 * Every metadata example we ship — in `docs/`, and in the agent-context skills that
 * teach an LLM how to author — must still LOAD under the strict registry. Three times
 * now it has not, and every time an adopter found it rather than a gate:
 *
 *   #337  the agent-context docs described `@verifiedBy` as live a release after it
 *         was retired, so a ledger written from the documentation failed to load.
 *   #342  `metaobjects-authoring` gave `{"@fields": [...], "@expr": ...}` as a worked
 *         example — the exact spelling that release turned into a load error.
 *   #343  `docs/llms/*` taught `@verifiedBy` and the pre-0.24.0 `@status` enum a full
 *         release after both were retired.
 *
 * Each was fixed by hand in a different file, which is why the family recurred instead
 * of converging.
 *
 * ── Why this cannot simply "load every block" ────────────────────────────────────
 *
 * Most doc blocks are deliberately PARTIAL — a field with two attributes, an entity
 * with its children elided. Loading them raises errors that say nothing about drift.
 * The classification that separates a real drift from an illustration is not a marker
 * an author has to remember, it is the KIND of error:
 *
 *   FAIL   errors about vocabulary the block USES        — an attribute that no longer
 *          exists, a value outside its enum, an illegal combination. The block wrote
 *          something wrong, and it is wrong at any size.
 *
 *   ALLOW  errors about what the block OMITS or REFERENCES — a required attribute it
 *          left out, an `extends` target that lives in another example. That IS
 *          fragment-ness; a complete model would not raise them.
 *
 * An error code in NEITHER list stops the gate with an "unclassified" failure rather
 * than defaulting either way. Defaulting to ALLOW lets a new code silently widen the
 * blind spot this gate exists to close; defaulting to FAIL turns every new code into
 * spurious noise across hundreds of fragments. Forcing a one-line decision is the same
 * posture as `VocabularyRewrite.otherwise`, and for the same reason: an entry that
 * classifies only what it thought of has said nothing about the rest.
 *
 * ── Normalising a block before classifying it ────────────────────────────────────
 *
 * Two ordinary authoring conventions used to make a block vanish before it ever reached
 * the loader, and between them they hid over a tenth of the shipped corpus:
 *
 *   an ELISION — `"children": [ ... ]` — is how a fence says "more of the same, not shown
 *   here". The placeholder is not JSON, so the block failed to parse and was skipped
 *   WHOLE, taking with it every attribute the author DID write. That is not hypothetical:
 *   the block that motivated this pass carried a retired `@emit*` attribute two lines
 *   above the `...` that hid it.
 *
 *   a STACKED fence — several one-line examples back to back — is not one document, so it
 *   too failed to parse as a single value and was skipped whole.
 *
 * Both are now NORMALISED rather than counted: an elision is deleted (over a string-masked
 * copy, so a literal "..." inside a quoted value is never touched) and a stacked fence is
 * split into its values, each checked on its own and located BY PIECE in any report. This
 * adds no verdict — every normalised piece lands in the same FAIL/ALLOW classification
 * above. It only stops the gate skipping a claim it is perfectly able to check.
 *
 * What is deliberately NOT done is failing on the skips that remain; the reasoning, with
 * the measurement behind it, is on `printSkipReport`.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
// Imported by SOURCE PATH, not package name: bun installs this workspace with the
// isolated linker, so `@metaobjectsdev/metadata` resolves inside each package's own
// node_modules and is not reachable from `scripts/`. The source import also means the
// gate reads the loader as it is NOW, with no build step between edit and gate.
import { MetaDataLoader } from "../server/typescript/packages/metadata/src/index.js";
import type { MetaDataFormat } from "../server/typescript/packages/metadata/src/loader/meta-data-source.js";

const REPO_ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

/** Trees whose fenced metadata examples ship to a reader or to an agent. */
const SCAN_ROOTS = [
  "docs",
  // The TRACKED skill source, not `server/typescript/packages/sdk/agent-context` — that
  // path is the BUNDLE, produced by `scripts/bundle-agent-context.mjs` and gitignored
  // (`packages/sdk/.gitignore`). Scanning it meant this gate checked a build artifact
  // instead of the files a reviewer reads: an edit to the source was invisible until
  // somebody re-bundled, and on a fresh clone or CI runner the directory does not exist
  // at all. Combined with the silent-skip below, that made the gate report success over
  // the entire corpus it was BUILT for — #337 was about the agent-context docs teaching
  // retired vocabulary, which is exactly what stops being checked.
  "agent-context",
];

/**
 * Design history, deliberately not gated. A plan or spec records what was decided AT A
 * TIME, and some of those examples are the very spellings a later release made illegal
 * — that is the record working, not drift. Editing them to satisfy a gate would falsify
 * it, the same argument that makes deleting an `@status: abandoned` node data loss
 * rather than a migration. Nobody copies a plan into their model; the guidance a reader
 * or an agent actually follows lives in the trees above.
 */
const SKIP_PREFIXES = [
  "docs/superpowers/",
  // A migration guide's PURPOSE is to show the retired spelling beside the new one, so
  // its "before" blocks must not load — that is the guide working. Gating the file would
  // mean marking every before-block, and the after-blocks teach the same spelling the
  // feature docs already carry and this gate already checks.
  "docs/features/migrations/",
];

/**
 * Opt-out for a block that legitimately cannot load against the CORE registry — today
 * only the provider-extension recipes, whose whole subject is an attribute a consumer
 * registers themselves. Placed on the line before the fence:
 *
 *     <!-- meta-example: external-provider -->
 *
 * Deliberately narrow and counted in the summary: a skip is a blind spot, and one that
 * cannot be seen growing is how this family recurred in the first place.
 *
 * The same rule now applies past this one marker: EVERY block that never becomes a
 * loadable model — an elision, several one-liners stacked in a fence, a config example
 * that was never metadata, a genuine typo — is counted and located in the report (see
 * `SkipReason` / `printSkipReport`), not just the ones an author flagged. Silence about
 * how much a gate skipped is exactly the shape that let #337/#342/#343 each survive
 * three real releases before an adopter, not this gate, found them.
 */
const OPT_OUT = /<!--\s*meta-example:\s*external-provider\s*-->/;

/**
 * Errors about vocabulary the block USES. A fragment cannot excuse any of these: it
 * wrote a type, subtype, attribute, value or combination the registry rejects.
 */
const FAIL_CODES = new Set([
  "ERR_UNKNOWN_ATTR",            // #337 — @verifiedBy after retirement
  "ERR_BAD_ATTR_VALUE",          // #337/#343 — @status: abandoned
  "ERR_INVALID_INDEX",           // #342 — @fields together with @expr
  "ERR_ENUM_INT_VALUE_MAP_ARRAY", // @intValueMap on an @isArray enum
  "ERR_ENUM_EXTENDS_VALUES_CONFLICT",
  "ERR_UNKNOWN_TYPE",
  "ERR_UNKNOWN_SUBTYPE",
  "ERR_RESERVED_ATTR",
  "ERR_CHILD_NOT_ALLOWED",
  "ERR_INVALID_SUBTYPE_CHILD",
  "ERR_SUBTYPE_RULE_VIOLATION",
  "ERR_INVALID_TEMPLATE",
  "ERR_MUTABILITY_AUTOSET_CONFLICT",
  "ERR_MUTABILITY_DOWNGRADE",
  "ERR_READONLY_ASSIGNED_PRIMARY",
  "ERR_STORAGE_FLATTENED_ARRAY",
  "ERR_PHYSICAL_NAME_KIND_MISMATCH",
  "ERR_PHYSICAL_NAME_MULTIPLE",
  "ERR_SQL_BODY_ON_WRITABLE_KIND",
  "ERR_SQL_BODY_WITH_UNMANAGED",
  "ERR_SOURCE_MULTIPLE_PRIMARY",
  "ERR_PROJECTION_SOURCE_WRITABLE",
  "ERR_PROJECTION_INHERITED_SOURCE",
  "ERR_FILTERABLE_UNSUPPORTED_SUBTYPE",
  "ERR_RELATIVE_REF_IN_CANONICAL",
  "ERR_TOO_MANY_OCCURRENCES",
  "ERR_UNKNOWN_EXPR_NODE",
  "ERR_YAML_COERCION",
  "ERR_MISSING_SUBTYPE",
]);

// ERR_BAD_ATTR_FILTER is deliberately NOT here — see the note in FRAGMENT_CODES.

/**
 * Errors about what the block OMITS or REFERENCES — i.e. errors a fragment raises
 * BECAUSE it is a fragment. Each would disappear if the surrounding model were present,
 * so none of them is evidence of drift.
 */
const FRAGMENT_CODES = new Set([
  "ERR_MISSING_REQUIRED_ATTR",       // the fragment elided it
  "ERR_INVALID_REFERENCE",
  "ERR_UNRESOLVED_OBJECT_REF",
  "ERR_UNRESOLVED_SUPER",
  "ERR_AMBIGUOUS_PATH",
  "ERR_PARTIAL_UNRESOLVED",
  "ERR_OVERLAY_NO_TARGET",
  "ERR_SOURCE_NO_PRIMARY",
  "ERR_DERIVED_FIELD_NO_READ_SOURCE",
  "ERR_PROJECTION_IDENTITY_NOT_EXTENDED",
  "ERR_IDENTITY_KEY_MISMATCH",
  "ERR_IDENTITY_NAME_REQUIRED",
  "ERR_DISCRIMINATOR_FIELD_NOT_FOUND",
  "ERR_DISCRIMINATOR_VALUE_DUPLICATE",
  "ERR_DISCRIMINATOR_VALUE_MISSING",
  "ERR_DISCRIMINATOR_VALUE_TYPE_MISMATCH",
  "ERR_EXTENDS_ORIGIN_MISMATCH",
  "ERR_EXTENDS_TARGET_MISMATCH",
  "ERR_EXTEND_REQUIRED_ATTR",
  "ERR_COMPUTED_TYPE_MISMATCH",
  "ERR_PASSTHROUGH_TYPE_MISMATCH",
  "ERR_ORIGIN_CARDINALITY",
  "ERR_OBJECT_FIELD_WITHOUT_OBJECT_REF",
  "ERR_STORAGE_WITHOUT_OBJECT_REF",
  "ERR_PARAMETER_REF_NOT_VALUE_OBJECT",
  "ERR_PARAMETER_REF_ON_NON_CALLABLE_KIND",
  "ERR_PARAMETER_REF_UNRESOLVED",
  "ERR_PAYLOAD_NAME_COLLISION",
  "ERR_VAR_NOT_ON_PAYLOAD",
  "ERR_OUTPUT_TAG_MISSING",
  "ERR_REQUIRED_SLOT_UNUSED",
  "ERR_BAD_DEFAULT_SORT_FIELD",
  "ERR_DUPLICATE_NAME",              // two elided siblings can collide by name
  // Overloaded codes: each covers BOTH a malformed declaration and an unresolvable
  // target, and in a fragment the second cause dominates — the entity being pointed at
  // usually lives in the next code block. Treating them as drift would report the
  // fragment boundary, so they are allowed and the vocabulary-shaped codes above carry
  // the gate. (A genuinely malformed origin/relationship is caught by the loader in the
  // adopter's own model, where the target does resolve.)
  "ERR_INVALID_ORIGIN",
  "ERR_INVALID_RELATIONSHIP",
  "ERR_BAD_ATTR_FILTER",             // legality depends on the extends-resolved field set
  // A bare `source.rdb @kind: view` is a legal fragment; only the synthetic entity the
  // gate wraps it in makes the primary source read-only. The real host would be an
  // object.projection, which the fragment cannot tell us about.
  "ERR_ENTITY_PRIMARY_SOURCE_READONLY",
  "ERR_MERGE_CONFLICT",
  "ERR_TOP_LEVEL_NOT_OBJECT",
  "ERR_MALFORMED_JSON",              // an elision (`...`) — not a metadata claim
  "ERR_MALFORMED_YAML",
  // Environment-shaped: about the registry/provider wiring, never about the example.
  "ERR_REGISTRY_SEALED",
  "ERR_PROVIDER_ATTR_CONFLICT",
  "ERR_PROVIDER_DEPENDENCY_CYCLE",
  "ERR_PROVIDER_DUPLICATE_ID",
  "ERR_PROVIDER_MISSING_DEPENDENCY",
  "ERR_INVALID_METAMODEL_CONSTRAINT",
]);

interface Block {
  readonly file: string;
  readonly line: number;
  readonly lang: string;
  readonly body: string;
}

/** A block rendered back into something the loader will accept, in its own format. */
interface LoadableModel {
  readonly content: string;
  readonly format: MetaDataFormat;
}

/**
 * Why a block — or one PIECE of a stacked block — never became a loadable model. This is
 * the gate's OTHER blind spot: `optedOut` above is a COUNTED, ANNOTATED skip; every reason
 * below was once silent, the block vanishing between "found" and "checked" with nothing in
 * the output to say so.
 *
 *   elided          the body carries a literal `...`/`…` placeholder AND still would not
 *                    parse once the placeholder was removed (see `stripJsonElisions`). A
 *                    de-elidable block is CHECKED; this reason is only the residue.
 *   unparseable     the body failed to parse and no normalisation rescued it. This is the
 *                    bucket worth a human's second glance: everything else here is a
 *                    recognized authoring pattern, while a body that fails to parse for no
 *                    visible reason is exactly the shape a genuine typo takes.
 *   not-object      the body parsed, but to a scalar, array, or `null` — not a JSON
 *                    object at all, so it cannot be a metadata node under any reading.
 *   not-node-shape  the body parsed to an object, but its keys don't match a single
 *                    `type.subtype` node or a `metadata.root` document — almost always a
 *                    non-metaobjects config or API-response example that happens to
 *                    share a fence language with real metadata.
 *   host-dependent  a bare `origin.*` fragment — see HOST_DEPENDENT_TYPES; a deliberate,
 *                    already-documented carve-out, not a new finding each time it fires.
 *
 * `stacked` is gone from this list on purpose. A stacked fence is now split and every piece
 * checked, so it is no longer a reason anything is skipped — only an individual piece can
 * be skipped, for one of the reasons above, and the report names which piece.
 */
type SkipReason =
  | "elided"
  | "unparseable"
  | "not-object"
  | "not-node-shape"
  | "host-dependent";

/**
 * Where one example sits. A stacked fence yields several examples from one block, so the
 * line is the PIECE's own line rather than the fence's, and `piece` names which one: a
 * finding a reader cannot locate inside the fence is a finding they will not act on.
 *
 * `piece` is a required property that may be `undefined` rather than an optional one —
 * `exactOptionalPropertyTypes` is on, and every construction site spreads a `Located`.
 */
interface Located {
  readonly block: Block;
  /** 1-based file line this example starts on. */
  readonly line: number;
  /** `piece 2 of 4` for a de-stacked fence; `undefined` when the fence is one document. */
  readonly piece: string | undefined;
}

/** A block, or one piece of one, rendered into something the loader will check. */
interface Example extends Located {
  readonly model: LoadableModel;
}

/** A block, or one piece of one, that never reached the loader, and why. */
interface Skip extends Located {
  readonly reason: SkipReason;
}

/** Everything one fence produced: zero or more checkable examples, zero or more skips. */
interface BlockAnalysis {
  readonly examples: readonly Example[];
  readonly skips: readonly Skip[];
}

/** The result of trying to turn one parsed value into something the loader can check. */
type ModelResult =
  | { readonly ok: true; readonly model: LoadableModel }
  | { readonly ok: false; readonly reason: SkipReason };

/**
 * Documents that carry shipped examples. `.txt` is included deliberately: `docs/llms/`
 * ships `llms.txt` / `llms-full.txt`, and #343 — one of the three incidents this gate
 * exists for — landed in exactly those files. Scanning only `.md` would have left the
 * gate blind to the surface that motivated it.
 */
function documentFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) documentFiles(full, out);
    else if (entry.endsWith(".md") || entry.endsWith(".txt")) out.push(full);
  }
  return out;
}

/** Count of blocks carrying the opt-out marker; surfaced so a skip cannot hide. */
let optedOut = 0;

/** Fenced blocks in a metadata-ish language, with the line the fence opens on. */
function fencedBlocks(file: string): Block[] {
  const lines = readFileSync(file, "utf8").split("\n");
  const blocks: Block[] = [];
  let lang: string | undefined;
  let start = 0;
  let buf: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const fence = /^\s*```(\w*)/.exec(lines[i]!);
    if (lang === undefined) {
      if (fence && /^(json|jsonc|yaml|yml)$/.test(fence[1]!)) {
        // Look back past blank lines for the opt-out marker.
        let j = i - 1;
        while (j >= 0 && lines[j]!.trim() === "") j--;
        if (j >= 0 && OPT_OUT.test(lines[j]!)) { optedOut++; continue; }
        lang = fence[1]!;
        start = i + 1;
        buf = [];
      }
      continue;
    }
    if (/^\s*```\s*$/.test(lines[i]!)) {
      blocks.push({ file, line: start, lang, body: buf.join("\n") });
      lang = undefined;
      continue;
    }
    buf.push(lines[i]!);
  }
  return blocks;
}

/** Strip `//` and block comments outside string literals (jsonc examples use both). */
function stripJsonComments(src: string): string {
  let out = "";
  let inString = false;
  let escape = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (inString) {
      out += c;
      if (escape) escape = false;
      else if (c === "\\") escape = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i++; out += "\n"; continue; }
    if (c === "/" && src[i + 1] === "*") {
      const from = i;
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i++;
      // Re-emit the newlines the comment spanned. Every line number this gate reports is
      // computed over the STRIPPED text, so swallowing them would point a reader at the
      // wrong line of the file they open.
      out += src.slice(from, i + 1).replace(/[^\n]/g, "");
      continue;
    }
    out += c;
  }
  return out;
}

/** The shipped "there is more here" convention — ASCII `...` or the unicode ellipsis. */
const ELISION_MARKER = /\.\.\.|…/;

/** Filler for a masked string literal's contents: one character in, one character out. */
const STRING_MASK_CHAR = "S";

/**
 * `source` with the CONTENTS of every string literal replaced by a filler, length and
 * every position preserved (newlines included, so line arithmetic still works). Elision
 * hunting then runs positionally over the mask, which is what makes it safe: a literal
 * "..." inside a quoted value — prose in a `description`, a `like` pattern — can never be
 * mistaken for the elision convention and deleted out of a shipped example.
 *
 * Indexed by UTF-16 code unit, NOT `for…of`: iterating by code point would collapse a
 * surrogate pair into one output character and slide every position after it.
 */
function maskStringLiterals(source: string): string {
  let out = "";
  let inString = false;
  let escape = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    if (!inString) {
      out += c;
      if (c === '"') inString = true;
      continue;
    }
    if (escape) { escape = false; out += STRING_MASK_CHAR; continue; }
    if (c === "\\") { escape = true; out += STRING_MASK_CHAR; continue; }
    if (c === '"') { inString = false; out += '"'; continue; }
    out += c === "\n" ? "\n" : STRING_MASK_CHAR;
  }
  return out;
}

/**
 * An elided array element or object member, together with the comma that joined it to its
 * siblings: `, ...`, `... ,`, `"children": ...`. Matched over a MASKED copy of the source
 * (see `maskStringLiterals`), never the raw text.
 */
const JSON_ELISION = new RegExp(
  String.raw`,?\s*(?:"${STRING_MASK_CHAR}*"\s*:\s*)?(?:\.\.\.|…)`, "g");

/** Everything in `span` except its newlines — what a deleted region leaves behind. */
function newlinesOf(span: string): string {
  return span.replace(/[^\n]/g, "");
}

/**
 * `source` (already comment-stripped) with every elided element or member removed, leaving
 * JSON that parses. Two details carry their weight:
 *
 *   the deleted span's NEWLINES are re-emitted, so every line number this gate reports
 *   still points at the line a reader will open; and
 *
 *   when the elision had no comma BEFORE it, the comma after it goes too — the comma that
 *   joined the elision to its sibling is now dangling, and `[ ..., b ]` must not be handed
 *   to the parser as `[ , b ]`.
 */
function stripJsonElisions(source: string): string {
  const masked = maskStringLiterals(source);
  let out = "";
  let last = 0;
  for (const match of masked.matchAll(JSON_ELISION)) {
    const start = match.index;
    if (start === undefined) continue;
    let end = start + match[0].length;
    if (!match[0].startsWith(",")) {
      let j = end;
      while (j < masked.length && /\s/.test(masked[j]!)) j++;
      if (masked[j] === ",") end = j + 1;
    }
    out += source.slice(last, start) + newlinesOf(source.slice(start, end));
    last = end;
  }
  return out + source.slice(last);
}

/**
 * A YAML line that IS an elision: a bare `...`, an elided sequence item, or a key whose
 * entire value is the placeholder.
 */
const YAML_ELISION_LINE = /^\s*(?:-\s*|[\w.@$-]+\s*:\s*)?(?:\.\.\.|…)\s*$/;

/**
 * YAML de-elision is line-based and deliberately blunter than the JSON one: there is no
 * safe string mask for YAML here (`stripJsonComments` would mangle a `//` inside a URL, and
 * YAML's own quoting rules differ), so only a whole line that is nothing but an elision is
 * removed and anything subtler is left unparsed rather than guessed at. The line is BLANKED
 * rather than deleted, again so reported line numbers stay true.
 *
 * It is here at all because ADR-0006 makes YAML the universal authoring front-end: leaving
 * its elisions unchecked would reopen the #337 hole on the surface agents author in.
 */
function stripYamlElisionLines(source: string): string {
  return source.split("\n").map((line) => (YAML_ELISION_LINE.test(line) ? "" : line)).join("\n");
}

/** A value that is nothing but the placeholder — `...` / `…`, whitespace aside. */
function isElisionPlaceholder(value: unknown): boolean {
  return typeof value === "string" && /^\s*(?:\.\.\.|…)\s*$/.test(value);
}

/**
 * An array element standing for "more of these, not shown". Two shapes reach here:
 *
 *   `[ {} ]` — what JSON de-elision leaves behind for `"children": [ { ... } ]`; and
 *   `[ "..." ]` — what a YAML PARSER hands back for `children:\n  - ...`, because in YAML
 *    an indented `...` is a perfectly good plain scalar. That one is the nastier case: the
 *    block parses, so nothing ever looked elided, and the string child then aborted the
 *    node before the loader reached its attributes — a YAML fence could carry a RETIRED
 *    attribute past this gate purely because it also carried an elision.
 */
function isElisionHole(element: unknown): boolean {
  if (isElisionPlaceholder(element)) return true;
  return element !== null && typeof element === "object" && !Array.isArray(element)
    && Object.keys(element).length === 0;
}

/**
 * `value` with the holes an elision leaves dropped: placeholder elements and members go,
 * and so does an empty object left in a child array. No real example ships either, so this
 * is the faithful reading of the elision — and it is what stops de-elision MANUFACTURING a
 * load error the document never committed.
 *
 * Applied only to a block whose source carries an elision marker, so a block with no
 * elision is passed to the loader exactly as written.
 */
function pruneElisionHoles(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(pruneElisionHoles).filter((element) => !isElisionHole(element));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, member] of Object.entries(value)) {
      if (isElisionPlaceholder(member)) continue; // `children: ...` — an elided member
      out[key] = pruneElisionHoles(member);
    }
    return out;
  }
  return value;
}

/** One top-level JSON value found in a fence, and where in the fence it starts. */
interface TopLevelValue {
  readonly value: unknown;
  readonly offset: number;
}

/**
 * `source` (already comment-stripped) split into two or more independently-valid top-level
 * JSON values with nothing but whitespace between them — several one-line examples stacked
 * in a single fence rather than one document — or `undefined` when it is not that shape.
 * Mechanical, not a guess: it walks balanced `{}`/`[]`/string/scalar tokens and requires
 * EVERY piece to `JSON.parse` on its own; one bad piece and it gives up rather than claim a
 * pattern that isn't really there.
 */
function splitTopLevelValues(source: string): readonly TopLevelValue[] | undefined {
  const values: TopLevelValue[] = [];
  let i = 0;
  const n = source.length;
  while (i < n) {
    while (i < n && /\s/.test(source[i]!)) i++;
    if (i >= n) break;
    const openCh = source[i]!;
    let end: number;
    if (openCh === "{" || openCh === "[") {
      const close = openCh === "{" ? "}" : "]";
      let depth = 0, inStr = false, esc = false, j = i;
      for (; j < n; j++) {
        const c = source[j]!;
        if (inStr) {
          if (esc) esc = false;
          else if (c === "\\") esc = true;
          else if (c === '"') inStr = false;
          continue;
        }
        if (c === '"') { inStr = true; continue; }
        if (c === openCh) depth++;
        else if (c === close) { depth--; if (depth === 0) { j++; break; } }
      }
      if (depth !== 0) return undefined; // unbalanced — not a clean sequence
      end = j;
    } else if (openCh === '"') {
      let j = i + 1, esc = false;
      for (; j < n; j++) {
        const c = source[j]!;
        if (esc) { esc = false; continue; }
        if (c === "\\") { esc = true; continue; }
        if (c === '"') { j++; break; }
      }
      end = j;
    } else {
      let j = i;
      while (j < n && !/[\s,]/.test(source[j]!)) j++;
      end = j;
    }
    let value: unknown;
    try { value = JSON.parse(source.slice(i, end)); } catch { return undefined; }
    values.push({ value, offset: i });
    i = end;
  }
  return values.length >= 2 ? values : undefined;
}

/** Newlines in `s` — how far into a fence a piece starts. */
function countNewlines(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s[i] === "\n") n++;
  return n;
}

/** A metadata node key: `object.entity`, `field.string`, `identity.reference`, ... */
const NODE_KEY = /^[a-z][A-Za-z]*\.[A-Za-z*]+$/;

/**
 * Types that only ever appear INSIDE an object. A fragment showing one of these is
 * wrapped in a synthetic `object.entity` rather than hung off the root — otherwise the
 * gate's own wrapper manufactures ERR_CHILD_NOT_ALLOWED and reports it as drift in the
 * document, which is the gate lying about its own scaffolding.
 */
const CHILD_ONLY_TYPES = new Set([
  "source", "identity", "index", "relationship", "layout",
  "view", "validator", "operation", "binding",
]);

/**
 * Types whose legality depends on WHICH host they hang under, so no synthetic wrapper
 * can be neutral: the same `origin.aggregate` is correct on a projection and an
 * ERR_SUBTYPE_RULE_VIOLATION on a value (#210). Wrapping one would make the gate report
 * a violation the document never committed, so a bare fragment of these is not checked.
 */
const HOST_DEPENDENT_TYPES = new Set(["origin"]);

/**
 * One PARSED value as a loadable canonical model, or the reason it cannot become one —
 * see `SkipReason`. A skip is not a verdict on the document; most of them are a
 * legitimate authoring pattern (a config example that was never metadata, a bare origin
 * fragment) this gate simply has no way to load.
 *
 * A fragment — a single `field.string` / `object.entity` node — is wrapped in a
 * synthetic root so the loader sees a well-formed document. That wrapping is what makes
 * fragment-ness mechanical: nothing about the block has to be annotated.
 */
function modelFromValue(parsed: unknown, isYaml: boolean): ModelResult {
  // YAML authoring is sigil-free (ADR-0006) and the loader desugars it, so a YAML block
  // is parsed, wrapped like any other fragment, and handed BACK to the loader as YAML —
  // re-emitting keeps the bare attribute keys the desugar expects, where canonical JSON
  // would demand `@` sigils this gate must not invent. ADR-0006 makes YAML the universal
  // authoring front-end, so a YAML example teaching a retired attribute is exactly the
  // #337 shape and must not sail through unchecked.
  const format: MetaDataFormat = isYaml ? "yaml" : "json";
  const emit = (value: unknown): LoadableModel => ({
    content: isYaml ? Bun.YAML.stringify(value) : JSON.stringify(value),
    format,
  });

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "not-object" };
  }

  const keys = Object.keys(parsed as Record<string, unknown>);
  if (keys.includes("metadata.root")) return { ok: true, model: emit(parsed) };
  if (keys.length !== 1 || !NODE_KEY.test(keys[0]!)) {
    return { ok: false, reason: "not-node-shape" };
  }

  const key = keys[0]!;
  const type = key.split(".")[0]!;
  if (HOST_DEPENDENT_TYPES.has(type)) return { ok: false, reason: "host-dependent" };

  let node: unknown = parsed;
  if (CHILD_ONLY_TYPES.has(type)) {
    // Declare the fields the fragment NAMES, so its @fields resolve. Without this the
    // wrapper's empty entity turns every index/identity example into a "references
    // field X which does not exist" error — a statement about the scaffolding, not the
    // document — and would drown the genuine structural violations (#342) in noise.
    const body = (parsed as Record<string, Record<string, unknown>>)[key] ?? {};
    const raw = body["@fields"];
    const named = typeof raw === "string" ? raw.split(",").map((s) => s.trim())
      : Array.isArray(raw) ? raw.map(String)
      : [];
    const fields = named.filter((n) => n.length > 0)
      .map((n) => ({ "field.string": { name: n } }));
    node = { "object.entity": { name: "DocExample", children: [...fields, parsed] } };
  }
  return { ok: true, model: emit({ "metadata.root": { package: "docexample", children: [node] } }) };
}

/**
 * Everything one fence yields. A fence that parses as one value is one example; an elided
 * fence is normalised and then IS one example; a stacked fence becomes several, each
 * checked and located separately. Only what survives none of that is skipped.
 *
 * Order matters: de-elision runs FIRST and the split runs over its output, because a fence
 * can legitimately be both (stacked one-liners, one of them cut short with `...`).
 */
function analyzeBlock(block: Block): BlockAnalysis {
  const isYaml = block.lang === "yaml" || block.lang === "yml";
  const source = isYaml ? block.body : stripJsonComments(block.body);

  const examples: Example[] = [];
  const skips: Skip[] = [];

  /**
   * Where an offset lands in the file the reader will open. `text` is whichever variant of
   * the fence the offset came from — every normalisation here preserves newlines exactly
   * (blanked YAML lines, re-emitted newlines in a deleted JSON span) precisely so this
   * arithmetic stays true no matter which one it counts in.
   */
  const locate = (text: string, offset: number, piece: string | undefined): Located => ({
    block,
    // `block.line` is the fence's own 1-based line; the body starts on the next one.
    line: block.line + 1 + countNewlines(text.slice(0, offset)),
    piece,
  });

  /** Classify one already-parsed value into an example or a skip. */
  const take = (
    value: unknown, text: string, offset: number, piece: string | undefined,
  ): void => {
    const where = locate(text, offset, piece);
    const result = modelFromValue(value, isYaml);
    if (result.ok) examples.push({ ...where, model: result.model });
    else skips.push({ ...where, reason: result.reason });
  };

  const parse = (text: string): { ok: true; value: unknown } | { ok: false } => {
    try { return { ok: true, value: isYaml ? Bun.YAML.parse(text) : JSON.parse(text) }; }
    catch { return { ok: false }; }
  };

  const elided = ELISION_MARKER.test(source);
  /** Only a block that actually carries a placeholder gets its holes pruned. */
  const prune = (value: unknown): unknown => (elided ? pruneElisionHoles(value) : value);

  // The pruning pass runs even when the block parsed as shipped, because an elision does
  // not always BREAK the parse: YAML reads an indented `...` as a plain scalar, so the
  // block loads with a string sitting where a child belongs and the rest of it never gets
  // checked. That is the same blind spot as an unparseable elision, wearing a green tick.
  const asShipped = parse(source);
  if (asShipped.ok) { take(prune(asShipped.value), source, 0, undefined); return { examples, skips }; }

  const normalised = !elided ? source
    : isYaml ? stripYamlElisionLines(source)
    : stripJsonElisions(source);
  if (elided) {
    const deElided = parse(normalised);
    if (deElided.ok) { take(prune(deElided.value), normalised, 0, undefined); return { examples, skips }; }
  }

  // Splitting is JSON-only: nothing in the shipped corpus has ever stacked YAML documents,
  // and YAML's own `---` separator would be the thing to detect rather than this walker.
  if (!isYaml) {
    const pieces = splitTopLevelValues(normalised);
    if (pieces !== undefined) {
      for (const [index, piece] of pieces.entries()) {
        take(prune(piece.value), normalised, piece.offset,
          `piece ${index + 1} of ${pieces.length}`);
      }
      return { examples, skips };
    }
  }

  skips.push({ ...locate(source, 0, undefined), reason: elided ? "elided" : "unparseable" });
  return { examples, skips };
}

interface Finding {
  readonly example: Example;
  readonly code: string;
  readonly message: string;
}

/** Print order: the bucket most worth a human's attention first. */
const SKIP_REASON_ORDER: readonly SkipReason[] = [
  "unparseable", "elided", "not-object", "not-node-shape", "host-dependent",
];

const SKIP_REASON_LABEL: Readonly<Record<SkipReason, string>> = {
  unparseable: "unparseable — failed to parse, and no normalisation rescued it. Look by hand",
  elided: 'elided — carries a literal "..."/"…" placeholder AND would not parse without it',
  "not-object": "not an object — parsed to a scalar, array, or null",
  "not-node-shape": "not shaped like one metaobjects node — parsed fine but keys don't match a " +
    "single `type.subtype` node or `metadata.root` (usually a non-metaobjects config/API example)",
  "host-dependent": "host-dependent — a bare origin.* fragment (HOST_DEPENDENT_TYPES); a " +
    "deliberate, already-documented carve-out",
};

/**
 * Prints every skip with its reason and location, UNCONDITIONALLY — called before the
 * pass/fail branches below, so it is visible whether the run is red or green. Exit code is
 * deliberately untouched here, and that is now a decision with a measurement behind it
 * rather than an omission.
 *
 * The obvious next step, once the blind spot was first measured, looked like "fail when the
 * skip count exceeds a threshold". It is the wrong fix, for three reasons that survived
 * contact with the corpus:
 *
 *   A threshold reports how many blocks we cannot see and never checks ONE of them. The
 *   hole it closes is the hole of not knowing, which the report already closed.
 *
 *   The two kinds that could actually hide drift — an elision, a stacked fence — are now
 *   NORMALISED and checked. Failing on those would have failed correct documents to buy
 *   coverage the normalisation gets for free, and would have taught authors to elide less
 *   clearly to appease a gate, making the docs worse.
 *
 *   What remains is dominated by `not-node-shape`: a config snippet or an API response
 *   sharing a fence language with metadata, correctly classified, with nothing to fix. A
 *   gate that fails those cries wolf, and a warning that cries wolf gets deleted rather
 *   than fixed — which is the failure mode this whole family started with.
 *
 * So a skip printed here is a FACT about the corpus. A FAIL is a claim about a document,
 * and the gate only makes one when it has read the document.
 */
function printSkipReport(skips: readonly Skip[], where: (l: Located) => string): void {
  if (skips.length === 0) return;
  console.log(
    `\n⚠ ${skips.length} fenced block(s)/piece(s) never became a checkable example — ` +
    "skipped, not counted as pass or fail:\n");
  const byReason = new Map<SkipReason, Skip[]>();
  for (const s of skips) {
    const group = byReason.get(s.reason);
    if (group) group.push(s); else byReason.set(s.reason, [s]);
  }
  for (const reason of SKIP_REASON_ORDER) {
    const group = byReason.get(reason);
    if (!group || group.length === 0) continue;
    console.log(`  ${group.length} ${SKIP_REASON_LABEL[reason]}:`);
    for (const s of group) console.log(`    ${where(s)}`);
    console.log("");
  }
}

async function main(): Promise<void> {
  // Roots may be overridden on the command line so the gate's own test can point it at
  // fixtures — the only way to show it FAILS on the three shapes it exists to catch.
  const argRoots = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const roots = argRoots.length > 0 ? argRoots : SCAN_ROOTS;

  const blocks: Block[] = [];
  for (const root of roots) {
    const dir = isAbsolute(root) ? root : join(REPO_ROOT, root);
    // A missing root is a BROKEN GATE, never an empty one. This used to `continue`, so a
    // renamed directory or a path that only exists after a build step shrank the corpus in
    // silence and still printed a tick: with the skills root absent the run reported
    // "✓ 40 shipped metadata example(s)" and exit 0, having checked 51 fewer than it does
    // with the root present. A gate that cannot find what it grades has not passed.
    try {
      statSync(dir);
    } catch {
      console.error(
        `\n✗ scan root not found: ${root}\n` +
        `  This gate grades every shipped metadata example; a root it cannot read is a\n` +
        `  broken gate, not an empty one. Fix the path in SCAN_ROOTS, or pass the roots\n` +
        `  you meant as arguments.`,
      );
      process.exit(1);
    }
    for (const file of documentFiles(dir)) {
      const path = relative(REPO_ROOT, file);
      if (SKIP_PREFIXES.some((p) => path.startsWith(p))) continue;
      blocks.push(...fencedBlocks(file));
    }
  }

  const findings: Finding[] = [];
  const unclassified = new Map<string, Finding>();
  const examples: Example[] = [];
  const skips: Skip[] = [];
  /** Fences that yielded at least one checkable example — one fence can yield several. */
  let checkedBlocks = 0;

  for (const block of blocks) {
    const analysis = analyzeBlock(block);
    if (analysis.examples.length > 0) checkedBlocks++;
    examples.push(...analysis.examples);
    skips.push(...analysis.skips);
  }

  for (const example of examples) {
    let errors: readonly Error[];
    try {
      ({ errors } = await MetaDataLoader.fromString(
        example.model.content, example.model.format, { strict: true }));
    } catch (e) {
      errors = [e as Error];
    }

    for (const error of errors) {
      const code = (error as { code?: string }).code ?? "ERR_UNCODED";
      if (FRAGMENT_CODES.has(code)) continue;
      const finding: Finding = { example, code, message: error.message };
      if (FAIL_CODES.has(code)) { findings.push(finding); continue; }
      if (!unclassified.has(code)) unclassified.set(code, finding);
    }
  }

  const where = (l: Located) =>
    `${relative(REPO_ROOT, l.block.file)}:${l.line}` +
    (l.piece === undefined ? "" : ` (${l.piece})`);

  printSkipReport(skips, where);

  if (unclassified.size > 0) {
    console.error("✗ unclassified loader error code(s) — the gate cannot decide these:\n");
    for (const [code, f] of unclassified)
      console.error(`  ${code}\n    first seen at ${where(f.example)}\n    ${f.message}\n`);
    console.error(
      "Add each code to FAIL_CODES (vocabulary the example USES is wrong) or to\n" +
      "FRAGMENT_CODES (the example merely OMITS or REFERENCES something) in\n" +
      "scripts/check-doc-examples.ts. Leaving it unclassified is not an option: one\n" +
      "default silently widens the blind spot, the other floods every fragment.");
    process.exit(1);
  }

  if (findings.length > 0) {
    console.error(`✗ ${findings.length} shipped example(s) no longer load:\n`);
    for (const f of findings)
      console.error(`  ${where(f.example)}\n    ${f.code}: ${f.message}\n`);
    console.error(
      "These are examples we SHIP — a reader or an agent copying one produces metadata\n" +
      "that fails to load. Fix the example; `meta upgrade` knows most of the rewrites.");
    process.exit(1);
  }

  const optedOutNote = optedOut > 0 ? `, ${optedOut} opted out (external-provider)` : "";
  const skippedNote = skips.length > 0 ? `, ${skips.length} skipped (see above)` : "";
  console.log(
    `✓ ${examples.length} shipped metadata example(s) from ${checkedBlocks} fenced block(s) ` +
    `load under the strict registry${optedOutNote}${skippedNote}`);
}

await main();

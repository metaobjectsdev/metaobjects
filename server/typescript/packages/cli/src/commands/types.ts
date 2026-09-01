// `meta types [QUERY]` — search the metadata vocabulary (types, subtypes, @attrs)
// without loading it all into context. apropos + `kubectl explain` over the live
// registry, tuned for an agent's token budget: terse names-first default, opt-in
// description search, drill-in `--detail`.
//
// It honors the global `--format`, and its default is TEXT in every case — deliberately
// NOT the TTY-aware default (`resolveFormat`: TOON off a TTY) that gen/verify/migrate take.
// Two reasons, and the second is the binding one: this command's text output is already the
// agent-tuned rendering the whole design is for, and every existing non-interactive caller
// pipes exactly that — a TTY-aware default would silently change what all of them read, with
// no flag passed. So index.ts hands this command the RAW --format flag rather than the
// resolved `fmt`, and absent means text. (`gen` already declares its own `fmt = "text"`
// default, so a command-local default is not a new idea.)
//
// In a structured format the rule is stdout PURITY: exactly one document, nothing else. The
// legend, the "N of M shown" footer and the no-match hint are all TEXT rendering — a `| jq`
// dies on any of them — so the structured branch emits none of them and carries what they
// said as FIELDS instead.
//
// The `--json` flag this once advertised in its own --help, twice, is not coming back: the
// CLI rejects a bare `--json` before a command ever sees its args (index.ts, `formatAlias`),
// on purpose — one global spelling for all three formats.
import { composeRegistry, coreProviders, buildVocabularyCatalog } from "@metaobjectsdev/metadata";
import { forgeTypesProvider } from "@metaobjectsdev/sdk";
import { log } from "../lib/log.js";
import { emitStructured, type OutputFormat } from "../lib/format.js";

interface TypesFlags {
  query: string | null;
  desc: boolean; // also match QUERY against descriptions/whenToUse
  kind: Set<"type" | "subtype" | "attr">;
  type: string | null; // scope to one top-level type
  detail: boolean;
  noHeaders: boolean;
  limit: number; // 0 = unlimited
  help: boolean;
}

const HELP = `meta types [QUERY] — search the metadata vocabulary without loading it all into context.

  meta types relationship                 # subtypes/attrs whose name matches "relationship"
  meta types --all money                   # search names AND descriptions ("find by what it does")
  meta types --type field --kind subtype   # all field subtypes (terse)
  meta types field.enum --detail           # one construct: description + when-to-use + valid @attrs
  meta types --type view --kind subtype    # every registered view control

QUERY is a case-insensitive substring, matched on the name (type.subType / @attr).
Add --desc (or --all) to also match descriptions + when-to-use guidance.

  --desc            also search descriptions + whenToUse (not just names)
  --all             alias for: match name OR description
  --kind <k>        filter by category: type | subtype | attr (comma-list ok)
  --type <name>     scope to one top-level type (e.g. --type field)
  --detail          drill in: full description, when-to-use, and valid @attrs
  --limit <N>       cap results (default 20; 0 = unlimited)
  --no-headers      omit headers (parse-friendly)
  --format <toon|json|text>   Output format (global flag). Defaults to TEXT here, even
                    off a TTY — unlike gen/verify/migrate, whose default is TOON off a TTY.

Default output is one terse line per match. Reach for metaobjects metadata
(declare it, regenerate) instead of hand-writing data logic — this finds the
construct.

--format toon / --format json emit ONE machine-readable document and nothing else. It
carries every match with its full record, so --limit, --detail and --no-headers — all
three TEXT display controls — do not change it. The terse line's [base] / [ts-only]
markers are the sharedRoot / tsOnly fields there, a closed-enum attr carries its
allowedValues, and no match is an empty matches list rather than a prose hint.`;

function parse(args: string[]): TypesFlags {
  const f: TypesFlags = {
    query: null, desc: false, kind: new Set(), type: null,
    detail: false, noHeaders: false, limit: 20, help: false,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "--help" || a === "-h") f.help = true;
    else if (a === "--desc" || a === "--all") f.desc = true;
    else if (a === "--detail") f.detail = true;
    else if (a === "--no-headers") f.noHeaders = true;
    // `--format` is a GLOBAL flag: index.ts strips it (and its value) from argv before
    // dispatch and passes the result in as `fmt`, so it never reaches here through the
    // CLI. Accepted and ignored anyway, so that the flag this command's --help lists is
    // one the parser accepts — the invariant types-command.test.ts holds it to, and the
    // one the removed `--json` broke.
    else if (a === "--format") i++;
    else if (a.startsWith("--format=")) { /* value is inline; nothing to consume */ }
    else if (a === "--limit") f.limit = Math.max(0, Number(args[++i] ?? "20") || 0);
    else if (a === "--type") f.type = (args[++i] ?? "").toLowerCase() || null;
    else if (a === "--kind") {
      for (const k of (args[++i] ?? "").split(","))
        if (k === "type" || k === "subtype" || k === "attr") f.kind.add(k);
    } else if (a.startsWith("-")) throw new Error(`unknown flag: ${a}`);
    else if (f.query === null) f.query = a;
    else throw new Error(`unexpected argument: ${a}`);
  }
  return f;
}

interface Entry {
  kind: "subtype" | "attr";
  name: string; // "field.string" or "field.string @maxLength"
  owner: string; // the type.subType this belongs to (= name for subtypes)
  type: string; // top-level type
  description: string;
  whenToUse: string | undefined;
  attrNames: string[]; // attr-name hints (for subtype terse lines)
  /** Accepted on EVERY node, so no `--type` scope excludes it (#357). */
  common: boolean;
  /** Registered here but carved out of the cross-port manifest — TS-only vocabulary. */
  tsOnly: boolean;
  /** A type's shared root (`<type>.base`): its attrs apply to every subtype. */
  sharedRoot: boolean;
  raw: unknown; // the catalog node
}

/** Compact markers appended to a terse line, and the legend that explains them. */
const MARK_TS_ONLY = "[ts-only]";
const MARK_BASE = "[base]";
const LEGEND = `  ${MARK_BASE}     the type's shared root — its @attrs apply to every subtype of that type\n` +
  `  ${MARK_TS_ONLY}  registered in TypeScript only; the cross-port metamodel contract does not carry it`;

function marks(e: Entry): string {
  const m = [e.sharedRoot ? MARK_BASE : "", e.tsOnly ? MARK_TS_ONLY : ""].filter(Boolean);
  return m.length > 0 ? `  ${m.join(" ")}` : "";
}

/** A catalog attr, as far as the payload needs to know. */
interface RawAttr {
  name: string;
  valueType: string | null;
  isArray: boolean;
  required: boolean;
  allowedValues?: readonly string[];
  description: string;
  whenToUse?: string;
}

function attrRecord(at: RawAttr): Record<string, unknown> {
  return {
    name: at.name,
    valueType: at.valueType,
    isArray: at.isArray,
    required: at.required,
    ...(at.allowedValues !== undefined ? { allowedValues: at.allowedValues } : {}),
    description: at.description,
    ...(at.whenToUse !== undefined ? { whenToUse: at.whenToUse } : {}),
  };
}

function payloadMatch(e: Entry): Record<string, unknown> {
  const out: Record<string, unknown> = {
    kind: e.kind,
    name: e.name,
    // A common attr belongs to no type and no subtype; `common: true` is what says so,
    // and null is the honest answer for both. The text rendering's "(any node)" owner is
    // a label for a human reading a column, not a value to hand a program.
    type: e.common || e.type === "" ? null : e.type,
    owner: e.common ? null : e.owner,
    common: e.common,
    tsOnly: e.tsOnly,
    sharedRoot: e.sharedRoot,
    description: e.description,
    ...(e.whenToUse !== undefined ? { whenToUse: e.whenToUse } : {}),
  };
  if (e.kind === "subtype") {
    out.attrs = (e.raw as { attrs: RawAttr[] }).attrs.map(attrRecord);
  } else {
    const at = e.raw as RawAttr;
    out.valueType = at.valueType;
    out.isArray = at.isArray;
    out.required = at.required;
    if (at.allowedValues !== undefined) out.allowedValues = at.allowedValues;
  }
  return out;
}

/**
 * The machine-readable answer: ONE document, every match, the whole record.
 *
 * Not a serialization of the text rendering. `--limit`, `--detail` and `--no-headers` are
 * TEXT display controls — the global --help already promises a structured payload is never
 * truncated — so none of them reaches here and the payload always carries everything.
 *
 * `metamodelVersion` is included because it is the number that says whether this answer
 * applies to a given model at all: the vocabulary is a contract with a version, and a
 * consumer caching this document needs to know which one it captured.
 */
function buildPayload(f: TypesFlags, matches: Entry[], metamodelVersion: string): unknown {
  return {
    metamodelVersion,
    query: f.query,
    filters: {
      type: f.type,
      kind: [...f.kind].sort(),
      searchDescriptions: f.desc,
    },
    total: matches.length,
    matches: matches.map(payloadMatch),
  };
}

export async function typesCommand(args: string[], fmt: OutputFormat = "text"): Promise<number> {
  let f: TypesFlags;
  try {
    f = parse(args);
  } catch (err) {
    const msg = (err as Error).message;
    log.error(msg);
    // A structured caller gets a structured refusal — exiting 2 with an EMPTY stdout is
    // the same silence a `| jq` cannot tell from "no results". Mirrors verify.ts.
    emitStructured({ error: msg, hint: "run `meta types --help` for the accepted flags" }, fmt);
    return 2;
  }
  if (f.help) {
    // Help is prose by definition — rendering it as a JSON string helps nobody, and a
    // consumer asking for help is a human either way.
    log.info(HELP);
    return 0;
  }

  // #357 — COMPOSE the registry, never `registerCoreTypes` alone. The db, ui-web and
  // documentation providers register attrs onto types the core provider declares, so a
  // partially-composed registry reports a type that exists with most of its attributes
  // missing: `field.string` came back with 6 attrs instead of 16 (no @column, @filterable,
  // @sortable, @dbColumnType), `view.textarea` with none (no @rows), and the eight
  // documentation commonAttrs — @title among them — were absent entirely. This is the same
  // provider set the loader composes, so what this prints is what the loader accepts.
  const registry = composeRegistry([...coreProviders, forgeTypesProvider], { validate: true });
  const catalog = buildVocabularyCatalog(registry);

  // Flatten the catalog into searchable entries.
  const entries: Entry[] = [];
  for (const mt of catalog.types) {
    const tsName = `${mt.type}.${mt.subType}`;
    entries.push({
      kind: "subtype", name: tsName, owner: tsName, type: mt.type,
      description: mt.description, whenToUse: mt.whenToUse,
      attrNames: mt.attrs.map((a) => `@${a.name}`),
      common: false, tsOnly: !mt.crossPort, sharedRoot: mt.sharedRoot, raw: mt,
    });
    for (const at of mt.attrs) {
      entries.push({
        kind: "attr", name: `${tsName} @${at.name}`, owner: tsName, type: mt.type,
        description: at.description, whenToUse: at.whenToUse, attrNames: [],
        common: false, tsOnly: !mt.crossPort, sharedRoot: false, raw: at,
      });
    }
  }
  // #357 — the attrs every node accepts. These were absent from the search entirely, so
  // `meta types title` reported nothing for `@title` — the registered attr an author is
  // supposed to find INSTEAD of asking for a new one (that omission is exactly how #353
  // became a request to register `@label`). They belong to no single type, so no `--type`
  // scope excludes them.
  for (const at of catalog.commonAttrs) {
    entries.push({
      kind: "attr", name: `@${at.name}`, owner: "(any node)", type: "",
      description: at.description, whenToUse: at.whenToUse, attrNames: [],
      common: true, tsOnly: false, sharedRoot: false, raw: at,
    });
  }

  const q = (f.query ?? "").toLowerCase();
  const wantKind = (e: Entry) => f.kind.size === 0
    ? true
    : (f.kind.has("attr") && e.kind === "attr") ||
      ((f.kind.has("subtype") || f.kind.has("type")) && e.kind === "subtype");
  const matches = entries.filter((e) => {
    // A common attr is accepted on every type, so `--type field` must not hide it.
    if (f.type && e.type !== f.type && !e.common) return false;
    if (!wantKind(e)) return false;
    if (!q) return true;
    if (e.name.toLowerCase().includes(q)) return true;
    if (f.desc && (e.description.toLowerCase().includes(q) ||
        (e.whenToUse ?? "").toLowerCase().includes(q))) return true;
    return false;
  });
  // Stable sort by (type, name).
  matches.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));

  // Structured output branches BEFORE the no-match hint below, deliberately: an empty
  // result must still be a valid document (`"matches": []`), not a sentence on stdout.
  if (fmt !== "text") {
    emitStructured(buildPayload(f, matches, catalog.metamodelVersion), fmt);
    return 0;
  }

  if (matches.length === 0) {
    log.info(q ? `No vocabulary matches "${f.query}". Try --all to search descriptions, or drop --kind/--type filters.`
                : "No matching vocabulary.");
    return 0;
  }

  const total = matches.length;
  const shown = f.limit > 0 ? matches.slice(0, f.limit) : matches;

  if (f.detail) {
    for (const e of shown) {
      log.info(`\n${e.name}  (${e.kind})`);
      if (e.description) log.info(`  ${e.description}`);
      if (e.sharedRoot)
        log.info(`  shared root: @attrs registered here apply to every ${e.type}.* subtype.`);
      if (e.tsOnly)
        log.info("  TypeScript-only: registered here, but not part of the cross-port metamodel contract.");
      if (e.whenToUse) log.info(`  → reach for it when: ${e.whenToUse}`);
      if (e.kind === "subtype") {
        const mt = e.raw as { attrs: { name: string; valueType: string | null; required: boolean; description: string }[] };
        if (mt.attrs.length) {
          log.info("  @attrs:");
          for (const at of mt.attrs)
            log.info(`    @${at.name}  ${at.valueType ?? "any"}${at.required ? "  REQUIRED" : ""}  ${at.description}`);
        }
      }
    }
  } else {
    // Terse: one line per match. Subtypes get attr-name hints; attrs get a short desc.
    for (const e of shown) {
      if (e.kind === "subtype") {
        const hint = e.attrNames.length ? `  (${e.attrNames.slice(0, 6).join(", ")}${e.attrNames.length > 6 ? ", …" : ""})` : "";
        log.info(`${e.name.padEnd(28)} ${oneLine(e.description)}${hint}${marks(e)}`);
      } else {
        log.info(`${e.name.padEnd(28)} ${oneLine(e.description)}${marks(e)}`);
      }
    }
  }
  if (!f.noHeaders && !f.detail && shown.some((e) => marks(e) !== "")) log.info(`\n${LEGEND}`);
  if (!f.noHeaders && shown.length < total)
    log.info(`\n${shown.length} of ${total} shown — narrow with QUERY/--type/--kind or raise --limit.`);
  else if (!f.noHeaders)
    log.info(`\n${total} match${total === 1 ? "" : "es"}.`);
  return 0;
}

function oneLine(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > 90 ? t.slice(0, 88) + "…" : t;
}

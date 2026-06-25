// `meta types [QUERY]` — search the metadata vocabulary (types, subtypes, @attrs)
// without loading it all into context. apropos + `kubectl explain` over the live
// registry, tuned for an agent's token budget: terse names-first default, opt-in
// description search, drill-in `--detail`, machine-readable `--json`.
import {
  TypeRegistry,
  registerCoreTypes,
  buildRegistryManifest,
} from "@metaobjectsdev/metadata";
import { registerForgeTypes } from "@metaobjectsdev/sdk";
import { log } from "../lib/log.js";

interface TypesFlags {
  query: string | null;
  desc: boolean; // also match QUERY against descriptions/whenToUse
  kind: Set<"type" | "subtype" | "attr">;
  type: string | null; // scope to one top-level type
  detail: boolean;
  json: boolean;
  noHeaders: boolean;
  limit: number; // 0 = unlimited
  help: boolean;
}

const HELP = `meta types [QUERY] — search the metadata vocabulary without loading it all into context.

  meta types relationship                 # subtypes/attrs whose name matches "relationship"
  meta types --all money                   # search names AND descriptions ("find by what it does")
  meta types --type field --kind subtype   # all field subtypes (terse)
  meta types field.enum --detail           # one construct: description + when-to-use + valid @attrs
  meta types --type origin --json          # machine-readable subtree

QUERY is a case-insensitive substring, matched on the name (type.subType / @attr).
Add --desc (or --all) to also match descriptions + when-to-use guidance.

  --desc            also search descriptions + whenToUse (not just names)
  --all             alias for: match name OR description
  --kind <k>        filter by category: type | subtype | attr (comma-list ok)
  --type <name>     scope to one top-level type (e.g. --type field)
  --detail          drill in: full description, when-to-use, and valid @attrs
  --json            emit the matching registry subtree verbatim (stable-sorted)
  --limit <N>       cap results (default 20; 0 = unlimited)
  --no-headers      omit headers (parse-friendly)

Default output is one terse line per match. Reach for metaobjects metadata
(declare it, regenerate) instead of hand-writing data logic — this finds the
construct.`;

function parse(args: string[]): TypesFlags {
  const f: TypesFlags = {
    query: null, desc: false, kind: new Set(), type: null,
    detail: false, json: false, noHeaders: false, limit: 20, help: false,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "--help" || a === "-h") f.help = true;
    else if (a === "--desc" || a === "--all") f.desc = true;
    else if (a === "--detail") f.detail = true;
    else if (a === "--json") f.json = true;
    else if (a === "--no-headers") f.noHeaders = true;
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
  raw: unknown; // the manifest node, for --json
}

export async function typesCommand(args: string[]): Promise<number> {
  let f: TypesFlags;
  try {
    f = parse(args);
  } catch (err) {
    log.error((err as Error).message);
    return 2;
  }
  if (f.help) {
    log.info(HELP);
    return 0;
  }

  const registry = new TypeRegistry();
  registerCoreTypes(registry);
  registerForgeTypes(registry);
  const manifest = buildRegistryManifest(registry);

  // Flatten the manifest into searchable entries.
  const entries: Entry[] = [];
  for (const mt of manifest.types) {
    const tsName = `${mt.type}.${mt.subType}`;
    entries.push({
      kind: "subtype", name: tsName, owner: tsName, type: mt.type,
      description: mt.description, whenToUse: mt.whenToUse,
      attrNames: mt.attrs.map((a) => `@${a.name}`), raw: mt,
    });
    for (const at of mt.attrs) {
      entries.push({
        kind: "attr", name: `${tsName} @${at.name}`, owner: tsName, type: mt.type,
        description: at.description, whenToUse: at.whenToUse, attrNames: [], raw: at,
      });
    }
  }

  const q = (f.query ?? "").toLowerCase();
  const wantKind = (e: Entry) => f.kind.size === 0
    ? true
    : (f.kind.has("attr") && e.kind === "attr") ||
      ((f.kind.has("subtype") || f.kind.has("type")) && e.kind === "subtype");
  const matches = entries.filter((e) => {
    if (f.type && e.type !== f.type) return false;
    if (!wantKind(e)) return false;
    if (!q) return true;
    if (e.name.toLowerCase().includes(q)) return true;
    if (f.desc && (e.description.toLowerCase().includes(q) ||
        (e.whenToUse ?? "").toLowerCase().includes(q))) return true;
    return false;
  });
  // Stable sort by (type, name).
  matches.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));

  if (matches.length === 0) {
    log.info(q ? `No vocabulary matches "${f.query}". Try --all to search descriptions, or drop --kind/--type filters.`
                : "No matching vocabulary.");
    return 0;
  }

  const total = matches.length;
  const shown = f.limit > 0 ? matches.slice(0, f.limit) : matches;

  if (f.json) {
    log.info(JSON.stringify(shown.map((e) => e.raw), null, 2));
    return 0;
  }

  if (f.detail) {
    for (const e of shown) {
      const head = e.kind === "subtype" ? e.name : e.name;
      log.info(`\n${head}  (${e.kind})`);
      if (e.description) log.info(`  ${e.description}`);
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
        log.info(`${e.name.padEnd(28)} ${oneLine(e.description)}${hint}`);
      } else {
        log.info(`${e.name.padEnd(28)} ${oneLine(e.description)}`);
      }
    }
  }
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

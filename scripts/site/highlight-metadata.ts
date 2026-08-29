import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
// Imported by SOURCE PATH, not package name: bun installs this workspace with the
// isolated linker, so `@metaobjectsdev/metadata` resolves inside each package's own
// node_modules and is not reachable from `scripts/`. Same pattern and same reason as
// scripts/check-doc-examples.ts. NEVER retype metamodel strings (CLAUDE.md,
// "Constants discipline") — RESERVED_KEYS is their single definition.
import { RESERVED_KEYS } from "../../server/typescript/packages/metadata/src/shared/structural.js";

export interface Vocabulary {
  subTypes: Set<string>;
  attrs: Set<string>;
  /** Bare type key → its default subtype, e.g. `metadata` → `root`. */
  defaultSubTypes: Record<string, string>;
}

/** A provider spec file: declares types and/or projects attrs onto existing ones. */
interface ProviderSpec {
  types?: { type: string; subType: string; children?: SpecChild[] }[];
  extends?: { type: string; subType: string; children?: SpecChild[] }[];
}
interface SpecChild { type: string; name?: string }

/** Narrowed from the parse rather than left `any` (CLAUDE.md forbids the escape hatch). */
interface RegistryManifest {
  types: { type: string; subType: string; attrs?: { name: string }[] }[];
  commonAttrs?: { name: string }[];
  defaultSubTypes: Record<string, string>;
}

/**
 * Vocabulary comes from TWO sources, because neither alone is the set of keys a
 * valid model may use:
 *
 *   expected-registry.json  the byte-gated CROSS-PORT core. Carries defaultSubTypes,
 *                           but omits TS-side provider vocabulary — `view.image` and
 *                           `view.textarea` are declared in spec/metamodel/view.json
 *                           and are NOT in the manifest, while advanced-modeling uses
 *                           both and loads clean.
 *   spec/metamodel/*.json   every provider, including the ones a port applies but the
 *                           cross-port manifest does not measure (metaobjects-ui-web).
 */
export function loadVocabulary(registryPath: string, specDir?: string): Vocabulary {
  const m = JSON.parse(readFileSync(registryPath, "utf8")) as RegistryManifest;
  const subTypes = new Set<string>();
  const attrs = new Set<string>();
  for (const t of m.types) {
    subTypes.add(`${t.type}.${t.subType}`);
    for (const a of t.attrs ?? []) attrs.add(a.name);
  }
  for (const a of m.commonAttrs ?? []) attrs.add(a.name);

  const dir = specDir ?? resolve(dirname(registryPath), "../../spec/metamodel");
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    const spec = JSON.parse(readFileSync(join(dir, file), "utf8")) as ProviderSpec;
    // A `types` entry DECLARES a subtype; an `extends` entry projects attrs onto a
    // subtype another provider owns (ADR-0050), so it contributes attrs but no name.
    for (const t of spec.types ?? []) subTypes.add(`${t.type}.${t.subType}`);
    for (const t of [...(spec.types ?? []), ...(spec.extends ?? [])]) {
      for (const c of t.children ?? []) {
        if (c.name && c.type?.startsWith("attr")) attrs.add(c.name);
      }
    }
  }
  return { subTypes, attrs, defaultSubTypes: m.defaultSubTypes };
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A leading key: `name:`, `- object.entity:`. */
const LEAD_KEY = /^(\s*(?:-\s*)?)([A-Za-z_][\w.]*)(?=:)/;
/** Keys INSIDE an inline flow map: `{ table: subscribers, required: true }`. */
const FLOW_KEY = /([{,]\s*)([A-Za-z_][\w.]*)(?=\s*:)/g;
/** A quoted scalar. Only QUOTED values are coloured — the site's own convention. */
const QUOTED = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g;

interface Span { start: number; end: number; cls: string }

/**
 * TOLERANT by design, and the reason matters.
 *
 * An earlier draft threw on any key it could not place, as a second retired-vocabulary
 * signal. Run against the real corpora it produced 8 false failures, and the class is
 * not closable: `attr.properties` is chartered as an arbitrary author-supplied bag
 * (ADR-0023), and `attr.expression`/`attr.filter` carry their own node grammars whose
 * inner keys (`op`, `arg`, `field`) are not registry attrs at all. No key allow-list
 * can be complete, so a throw here is a false-positive generator.
 *
 * The vocabulary gate is the LOADER, which is strictly stronger and has no false
 * positives: both corpora are strict-loaded by their drift gates, so retired
 * vocabulary cannot reach this function. What is left here is presentation — plus a
 * report, so an unplaceable key is visible rather than silently blue.
 */
function classify(key: string, vocab: Vocabulary, onUnknown: (k: string) => void): string {
  // A bare TYPE key (`metadata:`) is a type, not a reserved structural key. Colouring
  // it `key` renders the root line blue while every other subtype renders gold — the
  // inconsistent-colouring defect this work exists to remove.
  if (vocab.subTypes.has(key) || vocab.defaultSubTypes[key]) return "keyword";
  if (RESERVED_KEYS.has(key) || vocab.attrs.has(key)) return "key";
  onUnknown(key);
  return "key";
}

function highlightLine(line: string, vocab: Vocabulary, onUnknown: (k: string) => void): string {
  if (/^\s*#/.test(line)) return `<span class="comment">${esc(line)}</span>`;

  const spans: Span[] = [];

  // Quoted scalars first: their contents must be exempt from key and comment
  // scanning, so a `#` or `:` inside a regex pattern cannot be misread.
  const quoted: [number, number][] = [];
  for (const m of line.matchAll(QUOTED)) {
    const start = m.index!;
    quoted.push([start, start + m[0].length]);
    spans.push({ start, end: start + m[0].length, cls: "string" });
  }
  const inQuote = (i: number) => quoted.some(([a, b]) => i >= a && i < b);

  const lead = LEAD_KEY.exec(line);
  if (lead) {
    const start = lead[1].length;
    spans.push({ start, end: start + lead[2].length, cls: classify(lead[2], vocab, onUnknown) });
  }

  for (const m of line.matchAll(FLOW_KEY)) {
    const start = m.index! + m[1].length;
    if (inQuote(start)) continue;
    spans.push({ start, end: start + m[2].length, cls: classify(m[2], vocab, onUnknown) });
  }

  const hash = [...line].findIndex((c, i) => c === "#" && !inQuote(i));
  if (hash > 0) spans.push({ start: hash, end: line.length, cls: "comment" });

  spans.sort((a, b) => a.start - b.start);

  let out = "";
  let cursor = 0;
  for (const s of spans) {
    if (s.start < cursor) continue;          // a comment swallowing a later span
    out += esc(line.slice(cursor, s.start));
    out += `<span class="${s.cls}">${esc(line.slice(s.start, s.end))}</span>`;
    cursor = s.end;
  }
  return out + esc(line.slice(cursor));
}

export function highlightMetadata(
  yaml: string, vocab: Vocabulary, onUnknown: (key: string) => void = () => {},
): string {
  return yaml.split("\n").map((l) => highlightLine(l, vocab, onUnknown)).join("\n");
}

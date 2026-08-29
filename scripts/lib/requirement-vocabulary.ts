// The derived link between the requirements ledger and the registered vocabulary.
//
// ONE definition, imported by every script that needs it. It lived in two copies —
// `check-requirements-vocabulary.ts` and `scaffold-metamodel-entry.ts` — and the
// copies had already diverged on what counts as registered: one excluded the
// abstract `base` subtypes and the `*.*` common-attribute wildcard and the other did
// not, so an L4 named `fieldBase` was registered to the scaffolder and unregistered
// to the gate. Two answers to the load-bearing question of Phase 2 is one too many.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import {
  REQUIREMENT_SUBTYPE_ARCHITECTURAL,
} from "../../server/typescript/packages/metadata/src/core/requirement/requirement-constants.js";

// Resolved with fileURLToPath, never `new URL(...).pathname` — the latter is
// percent-encoded, so a checkout under a path containing a space or any non-ASCII
// character comes back with `%20` (and the like) baked in, and every read throws
// ENOENT naming a path nobody can match to their working tree. On Windows it also
// yields a leading-slash drive path.
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const DEFAULT_MANIFEST = join(REPO_ROOT, "fixtures/registry-conformance/expected-registry.json");
export const DEFAULT_SPEC_DIR = join(REPO_ROOT, "spec/metamodel");
export const DEFAULT_LEDGER_DIR = join(REPO_ROOT, "metaobjects");

/** The level at which a requirement addresses a subtype, and the one below it. */
export const LEVEL_SUBTYPE = 4;
export const LEVEL_ATTR = 5;

export interface Entry { key: string; attrs: Set<string> }

/**
 * Every concrete `type.subType` the loader accepts, with the attributes it carries.
 *
 * The population is the UNION of two artifacts that are NOT interchangeable:
 * `expected-registry.json` is the cross-port contract, `spec/metamodel/*.json` is what
 * the providers declare, and the gap is exactly `metadata.root` on one side and the 13
 * TS-web presentation-only `view.*` controls on the other. A carve-out from the
 * cross-port manifest is a statement about portability, not a licence to leave
 * vocabulary unpromised.
 *
 * NOTE on `abstract`: no `spec/metamodel` entry carries an `abstract` flag today, so
 * abstractness is expressed only by the `base` subtype name and, in one case, by prose.
 * The flag is still honoured here so that marking one has an effect, but it is not a
 * filter anything currently relies on — see `view.web` in the ledger's notes.
 */
export function population(specDir = DEFAULT_SPEC_DIR, manifestPath = DEFAULT_MANIFEST): Map<string, Entry> {
  const out = new Map<string, Entry>();
  const add = (type: string, subType: string, attrs: string[]): void => {
    const key = `${type}.${subType}`;
    const e = out.get(key) ?? { key, attrs: new Set<string>() };
    for (const a of attrs) e.attrs.add(a);
    out.set(key, e);
  };

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    types: { type: string; subType: string; attrs?: { name: string }[] }[];
  };
  for (const t of manifest.types) {
    if (t.subType === "base") continue; // abstract root: nothing authors it directly
    add(t.type, t.subType, (t.attrs ?? []).map((a) => a.name));
  }

  for (const f of readdirSync(specDir).filter((f) => f.endsWith(".json"))) {
    const m = JSON.parse(readFileSync(join(specDir, f), "utf8")) as {
      types?: { type?: string; subType: string; abstract?: boolean; attrs?: { name: string }[] }[];
    };
    for (const t of m.types ?? []) {
      const type = t.type ?? f.replace(/\.json$/, "");
      // `*.*` is the common-attribute wildcard, not a subtype anyone authors.
      if (t.abstract === true || t.subType === "base" || type === "*" || t.subType === "*") continue;
      add(type, t.subType, (t.attrs ?? []).map((a) => a.name));
    }
  }
  return out;
}

/** The closed type axis, longest first so a longer type wins a shared prefix. */
export function typeAxis(pop: Map<string, Entry>): string[] {
  return [...new Set([...pop.keys()].map((k) => k.split(".")[0]!))].sort((a, b) => b.length - a.length);
}

/** Split `fieldCurrency` into `field.currency` against the closed type axis. */
export function splitName(name: string, types: string[]): string | undefined {
  for (const t of types) {
    if (!name.startsWith(t) || name.length === t.length) continue;
    const rest = name.slice(t.length);
    if (rest[0] !== rest[0]?.toUpperCase()) continue; // `fieldset` must not match `field`
    return `${t}.${rest[0]!.toLowerCase()}${rest.slice(1)}`;
  }
  return undefined;
}

/** The camelCase requirement name a subtype key implies: `field.currency` -> `fieldCurrency`. */
export function nameFor(key: string): string {
  const [type, subType] = key.split(".") as [string, string];
  return `${type}${subType[0]!.toUpperCase()}${subType.slice(1)}`;
}

/**
 * Prove the derivation is unambiguous, by ROUND-TRIPPING every key in the population.
 *
 * The first version of this asserted the type axis was "prefix-free" with
 * `b.startsWith(a) && b[a.length] === b[a.length]?.toUpperCase()`. Every registered
 * type name is lowercase, so `b[a.length]` is always a lowercase letter and the
 * uppercase test is always false: the loop could not fire on any input, and there are
 * no prefix pairs among the current types for it to fire on anyway. It reported a
 * safety property it had never checked — the shape of failure this whole program is
 * about.
 *
 * A round trip tests the actual property: the name a subtype implies must split back
 * to exactly that subtype. That fires on a real ambiguity whatever causes it, and does
 * not depend on a guess about which shape ambiguity would take.
 */
export function derivationProblems(pop: Map<string, Entry>): string[] {
  const types = typeAxis(pop);
  const out: string[] = [];
  for (const key of pop.keys()) {
    const round = splitName(nameFor(key), types);
    if (round !== key) {
      out.push(
        `  '${key}' does not survive the name derivation: '${nameFor(key)}' reads back as ` +
        `'${round ?? "nothing"}'. The camelCase link is ambiguous — change the derivation, not this check.`,
      );
    }
  }
  return out;
}

/**
 * True when this requirement participates in the derived vocabulary link.
 *
 * FUNCTIONAL ONLY, and that is not a shortcut. An architectural requirement is
 * object-independent by definition — it states a policy that holds over everything, so
 * it names no single subtype and its name derives nothing. 0.23.0 made `@level` legal
 * on `requirement.architectural` precisely so a quality taxonomy can nest, which means
 * a levelled architectural node at L4 is VALID metadata; without this filter each of
 * these scripts convicts it for failing a rule written only for the other subtype.
 */
export function participatesInVocabularyLink(node: { subType: string }): boolean {
  return node.subType !== REQUIREMENT_SUBTYPE_ARCHITECTURAL;
}

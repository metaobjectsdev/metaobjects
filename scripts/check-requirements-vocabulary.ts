#!/usr/bin/env bun
/**
 * Phase 2 gate — every registered subtype has an authored requirement, and every
 * authored requirement names a registered subtype.
 *
 * ── The link is DERIVED, never declared ─────────────────────────────────────────
 *
 * `implementedBy` is omitted throughout this ledger. Its referent is a MODEL node
 * and the subject here is the metamodel itself, which has none. So the link from a
 * requirement to the vocabulary it promises something about is derived from the
 * requirement's own NAME:
 *
 *   L4  `fieldCurrency`   → `field.currency`     (camelCase <type><SubType>)
 *   L5  `currency`        → `field.currency.@currency`  (name resolved against its
 *                                                        L4 parent)
 *
 * This is the same ruling that retired `@verifiedBy` in 0.24.0: a link the author
 * types is a link the author can get wrong. Here the author types the name they were
 * going to type anyway, and the check owns the correspondence. Splitting `fieldCurrency`
 * is unambiguous because the type axis is CLOSED and no type name is a prefix of
 * another (`index` vs `identity` diverge at the fourth character) — asserted below
 * rather than assumed, because a future type could break it silently.
 *
 * ── One population, stated ──────────────────────────────────────────────────────
 *
 * Two denominators exist in this repository and they are NOT interchangeable:
 * `fixtures/registry-conformance/expected-registry.json` carries the cross-port
 * contract, and `spec/metamodel/*.json` carries what the providers declare. The gap
 * is exactly `metadata.root` (core, no spec file) on one side and the 13 generic
 * `view.*` controls (TS-web presentation-only, carved out of the manifest) on the
 * other.
 *
 * The population here is their UNION: every concrete subtype the loader can accept,
 * whichever artifact records it. A carve-out from the cross-port manifest is a
 * statement about portability, not a licence to leave the vocabulary unpromised — an
 * adopter can author `view.textarea` today, so something must say what it is for.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MetaDataLoader } from "../server/typescript/packages/metadata/src/index.js";
import { collectAddressedRequirements } from "../server/typescript/packages/cli/src/lib/requirement-check.js";

const REPO_ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
// Overridable by a positional argument for ONE caller — the self-test, which drives
// this gate against throwaway ledgers. CI invokes it bare.
const LEDGER_DIR = process.argv[2] ?? join(REPO_ROOT, "metaobjects");
const MANIFEST = join(REPO_ROOT, "fixtures/registry-conformance/expected-registry.json");
const SPEC_DIR = join(REPO_ROOT, "spec/metamodel");

/** The L4 level. Below it a requirement addresses a member, above it, nothing in the model. */
const LEVEL_SUBTYPE = 4;
const LEVEL_ATTR = 5;

interface Entry { key: string; attrs: Set<string> }

/** Every concrete `type.subType` the loader accepts, with the attributes it carries. */
function population(): Map<string, Entry> {
  const out = new Map<string, Entry>();
  const add = (type: string, subType: string, attrs: string[]): void => {
    const key = `${type}.${subType}`;
    const e = out.get(key) ?? { key, attrs: new Set<string>() };
    for (const a of attrs) e.attrs.add(a);
    out.set(key, e);
  };

  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as {
    types: { type: string; subType: string; attrs?: { name: string }[] }[];
  };
  for (const t of manifest.types) {
    if (t.subType === "base") continue; // abstract: nothing authors it directly
    add(t.type, t.subType, (t.attrs ?? []).map((a) => a.name));
  }

  for (const f of readdirSync(SPEC_DIR).filter((f) => f.endsWith(".json"))) {
    const m = JSON.parse(readFileSync(join(SPEC_DIR, f), "utf8")) as {
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

/** Split `fieldCurrency` into `field.currency` against the CLOSED type axis. */
function splitName(name: string, types: string[]): string | undefined {
  for (const t of types) {
    if (!name.startsWith(t) || name.length === t.length) continue;
    const rest = name.slice(t.length);
    if (rest[0] !== rest[0]?.toUpperCase()) continue; // `fieldset` must not match `field`
    return `${t}.${rest[0]!.toLowerCase()}${rest.slice(1)}`;
  }
  return undefined;
}

async function main(): Promise<number> {
  const pop = population();
  const types = [...new Set([...pop.keys()].map((k) => k.split(".")[0]!))].sort(
    (a, b) => b.length - a.length, // longest first, so a longer type wins a shared prefix
  );

  // The prefix-free assumption, asserted rather than trusted.
  for (const a of types) {
    for (const b of types) {
      if (a !== b && b.startsWith(a) && b[a.length] === b[a.length]?.toUpperCase()) {
        console.error(
          `requirements-vocabulary: type axis is no longer prefix-free — '${a}' prefixes '${b}'.\n` +
          `The camelCase name derivation cannot stay unambiguous. Change the derivation, not this check.\n`,
        );
        return 1;
      }
    }
  }

  const { root, errors } = await MetaDataLoader.fromDirectory(LEDGER_DIR, { strict: true });
  if (errors.length > 0 || root === undefined) {
    console.error("requirements-vocabulary: the ledger does not load.\n");
    for (const e of errors) console.error(`  ${e.code ?? ""} ${e.message}`);
    return 1;
  }

  const claimed = new Map<string, string>();      // type.subType -> requirement address
  const problems: string[] = [];

  for (const { node, path } of collectAddressedRequirements(root)) {
    const level = node.level();
    if (level === LEVEL_SUBTYPE) {
      const key = splitName(node.name, types);
      if (key === undefined || !pop.has(key)) {
        problems.push(
          `  ${path}: L4 name '${node.name}' does not derive a registered subtype` +
          (key !== undefined ? ` (read as '${key}', which is not registered)` : ""),
        );
        continue;
      }
      const prior = claimed.get(key);
      if (prior !== undefined) {
        problems.push(`  ${path}: '${key}' is already promised by ${prior} — one L4 per subtype`);
        continue;
      }
      claimed.set(key, path);
    } else if (level === LEVEL_ATTR) {
      const parent = node.parent;
      const parentKey = parent !== undefined ? splitName(parent.name, types) : undefined;
      if (parentKey === undefined || !pop.has(parentKey)) {
        problems.push(`  ${path}: L5 must nest under an L4 that names a registered subtype`);
        continue;
      }
      if (!pop.get(parentKey)!.attrs.has(node.name)) {
        problems.push(`  ${path}: '${parentKey}' carries no attribute '${node.name}'`);
      }
    }
  }

  const unpromised = [...pop.keys()].filter((k) => !claimed.has(k)).sort();

  if (problems.length > 0 || unpromised.length > 0) {
    if (unpromised.length > 0) {
      console.error(
        `requirements-vocabulary: ${unpromised.length} of ${pop.size} registered subtype(s) ` +
        `have no authored requirement:\n`,
      );
      for (const k of unpromised) console.error(`  ${k}`);
      console.error("");
    }
    if (problems.length > 0) {
      console.error(`requirements-vocabulary: ${problems.length} authoring problem(s):\n`);
      for (const p of problems) console.error(p);
      console.error("");
    }
    return 1;
  }

  const l5 = collectAddressedRequirements(root).filter((r) => r.node.level() === LEVEL_ATTR).length;
  console.log(
    `requirements-vocabulary: OK — ${pop.size} registered subtype(s), each promised by exactly ` +
    `one L4 requirement; ${l5} L5 attribute requirement(s), each naming an attribute its subtype carries.`,
  );
  return 0;
}

process.exit(await main());

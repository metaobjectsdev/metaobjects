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
import { MetaDataLoader } from "../server/typescript/packages/metadata/src/index.js";
import { collectAddressedRequirements } from "../server/typescript/packages/cli/src/lib/requirement-check.js";
import {
  DEFAULT_LEDGER_DIR,
  LEVEL_ATTR,
  LEVEL_SUBTYPE,
  derivationProblems,
  participatesInVocabularyLink,
  population,
  splitName,
  typeAxis,
} from "./lib/requirement-vocabulary.js";

// Overridable by a positional argument for ONE caller — the self-test, which drives
// this gate against throwaway ledgers. CI invokes it bare.
const LEDGER_DIR = process.argv[2] ?? DEFAULT_LEDGER_DIR;

async function main(): Promise<number> {
  const pop = population();
  const types = typeAxis(pop);

  // The derivation is only a safe link while every subtype's implied name reads back
  // as that subtype. Checked, not assumed — the previous form of this could not fire.
  const ambiguous = derivationProblems(pop);
  if (ambiguous.length > 0) {
    console.error("requirements-vocabulary: the camelCase name derivation is ambiguous.\n");
    for (const a of ambiguous) console.error(a);
    return 1;
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
    // Architectural requirements are object-independent and name no subtype (0.23.0
    // made them levellable, so one can legally sit at L4).
    if (!participatesInVocabularyLink(node)) continue;
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

  const l5 = collectAddressedRequirements(root)
    .filter((r) => participatesInVocabularyLink(r.node) && r.node.level() === LEVEL_ATTR).length;
  console.log(
    `requirements-vocabulary: OK — ${pop.size} registered subtype(s), each promised by exactly ` +
    `one L4 requirement; ${l5} L5 attribute requirement(s), each naming an attribute its subtype carries.`,
  );
  return 0;
}

process.exit(await main());

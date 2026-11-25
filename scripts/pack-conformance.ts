#!/usr/bin/env bun
/**
 * Run a pack's load fixtures through the TypeScript port (ADR-0069, "Conformance").
 *
 * A pack's corpus lives at packs/<name>/fixtures/conformance/, in the shared fixture
 * format (spec/conformance-tests.md), so the counts and the corpus x port matrix that
 * docs/CONFORMANCE.md gates for fixtures/ never move for pack work. This drives it with
 * the same engine and the same adapter as fixtures/conformance/, through the corpus-root
 * entry point `runCorpus` (@metaobjectsdev/conformance): the adapter is composed with
 * the pack's provider and the packs it requires, and every scenario must name the pack
 * in its providers.json, because a scenario that loads only the default bundle tests
 * core, not the pack.
 *
 * Error codes: the core list (fixtures/conformance/ERROR-CODES.json) plus
 * packs/<name>/fixtures/conformance/ERROR-CODES.json of the pack and of every pack it
 * requires, for each that declares codes of its own.
 * An optional packs/<name>/typescript/conformance-expected-failures.json is the port's
 * ledger, in the core ledger's format.
 *
 * Usage: bun scripts/pack-conformance.ts <name> | --all
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { runCorpus, loadErrorCodes, loadLedger, type CorpusResult } from "../server/typescript/packages/conformance/src/index.js";
import { createTsAdapter } from "../server/typescript/packages/metadata/test/conformance/adapter.js";
import type { MetaDataTypeProvider } from "../server/typescript/packages/metadata/src/index.js";
import { PACK_CORPUS, REPO_ROOT, loadPackClosure, packDir, packNamesFromArgs, packsById, readPackManifest } from "./lib/packs.js";

const ERROR_CODES = "ERROR-CODES.json";

/** The pack's corpus result, or undefined when the pack has no load fixtures yet. */
export async function runPackConformance(name: string, root: string = REPO_ROOT): Promise<CorpusResult | undefined> {
  const corpusRoot = join(packDir(name, root), PACK_CORPUS);
  if (!existsSync(corpusRoot)) return undefined;
  const closure = await loadPackClosure(name, root);
  const extra: Record<string, MetaDataTypeProvider> = {};
  for (const p of closure) extra[p.id] = p;
  // The codes a scenario may expect: core's, and those of this pack and every pack it
  // requires (a required pack's check runs on this pack's models too).
  const byId = packsById(root);
  const errorCodes = [...(await loadErrorCodes(join(root, "fixtures/conformance", ERROR_CODES)))];
  for (const p of closure) {
    // A pack with no codes of its own has no file; loadErrorCodes reads that as none.
    errorCodes.push(...(await loadErrorCodes(join(packDir(byId.get(p.id) ?? name, root), PACK_CORPUS, ERROR_CODES))));
  }
  return runCorpus({
    corpusRoot,
    adapter: createTsAdapter(extra),
    errorCodes,
    ledger: await loadLedger(join(packDir(name, root), "typescript", "conformance-expected-failures.json")),
    requireProviders: [readPackManifest(name, root).id],
  });
}

if (import.meta.main) {
  const names = packNamesFromArgs(process.argv.slice(2), "bun scripts/pack-conformance.ts <name>|--all");
  let failed = 0;
  for (const name of names) {
    const r = await runPackConformance(name);
    if (r === undefined) {
      console.log(`pack ${name}: no load fixtures (${PACK_CORPUS}/ is absent)`);
      continue;
    }
    const counts = new Map<string, number>();
    for (const f of r.fixtures) counts.set(f.status, (counts.get(f.status) ?? 0) + 1);
    const summary = [...counts].map(([s, n]) => `${n} ${s}`).join(", ");
    if (r.passed) {
      console.log(`pack ${name}: conformance ${summary || "0 fixtures"}`);
      continue;
    }
    failed++;
    if (r.fixtures.every((f) => f.status === "skipped")) {
      console.error(`pack ${name}: conformance FAILED — ${PACK_CORPUS}/ holds no runnable scenario${summary ? ` (${summary})` : ""}, so it tests nothing`);
      continue;
    }
    console.error(`pack ${name}: conformance FAILED (${summary})`);
    for (const f of r.fixtures.filter((x) => x.status === "fail" || x.status === "fixed-but-listed")) {
      console.error(`  ✖ ${f.name} [${f.status}]: ${f.problems.join("; ")}`);
    }
  }
  if (names.length === 0) console.log("pack conformance: no pack has a TypeScript port");
  process.exit(failed > 0 ? 1 : 0);
}

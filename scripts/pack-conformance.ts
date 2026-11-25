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
 * Error codes: the core list (fixtures/conformance/ERROR-CODES.json) plus the pack's own
 * packs/<name>/fixtures/conformance/ERROR-CODES.json when it declares codes of its own.
 * An optional packs/<name>/typescript/conformance-expected-failures.json is the port's
 * ledger, in the core ledger's format.
 *
 * Usage: bun scripts/pack-conformance.ts <name> | --all
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runCorpus, loadLedger, type CorpusResult } from "../server/typescript/packages/conformance/src/index.js";
import { createTsAdapter } from "../server/typescript/packages/metadata/test/conformance/adapter.js";
import type { MetaDataTypeProvider } from "../server/typescript/packages/metadata/src/index.js";
import { PACK_CORPUS, REPO_ROOT, listPackDirs, loadPackClosure, packDir, readPackManifest } from "./lib/packs.js";

const ERROR_CODES = "ERROR-CODES.json";

function codesIn(path: string): string[] {
  if (!existsSync(path)) return [];
  return Object.keys((JSON.parse(readFileSync(path, "utf8")) as { codes?: Record<string, string> }).codes ?? {});
}

/** The pack's corpus result, or undefined when the pack has no load fixtures yet. */
export async function runPackConformance(name: string, root: string = REPO_ROOT): Promise<CorpusResult | undefined> {
  const corpusRoot = join(packDir(name, root), PACK_CORPUS);
  if (!existsSync(corpusRoot)) return undefined;
  const closure = await loadPackClosure(name, root);
  const extra: Record<string, MetaDataTypeProvider> = {};
  for (const p of closure) extra[p.id] = p;
  const errorCodes = [
    ...codesIn(join(root, "fixtures/conformance", ERROR_CODES)),
    ...codesIn(join(corpusRoot, ERROR_CODES)),
  ];
  return runCorpus({
    corpusRoot,
    adapter: createTsAdapter(extra),
    errorCodes,
    ledger: await loadLedger(join(packDir(name, root), "typescript", "conformance-expected-failures.json")),
    requireProviders: [readPackManifest(name, root).id],
  });
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const names = args.includes("--all")
    ? listPackDirs().filter((n) => existsSync(join(packDir(n), "typescript", "package.json")))
    : args.filter((a) => !a.startsWith("--"));
  if (names.length === 0 && !args.includes("--all")) {
    console.error("usage: bun scripts/pack-conformance.ts <name>|--all");
    process.exit(2);
  }
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
    console.error(`pack ${name}: conformance FAILED (${summary})`);
    for (const f of r.fixtures.filter((x) => x.status === "fail" || x.status === "fixed-but-listed")) {
      console.error(`  ✖ ${f.name} [${f.status}]: ${f.problems.join("; ")}`);
    }
  }
  if (names.length === 0) console.log("pack conformance: no pack has a TypeScript port");
  process.exit(failed > 0 ? 1 : 0);
}

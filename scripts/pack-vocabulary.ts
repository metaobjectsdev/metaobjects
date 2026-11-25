#!/usr/bin/env bun
/**
 * A pack's pinned vocabulary, and the check that it leaves core alone (ADR-0069).
 *
 * Composes the default bundle (every bundled provider, `coreProviders`), then the bundle
 * plus the packs this pack requires plus this pack, and diffs the two registry
 * manifests row by row:
 *
 *  - LEAVES CORE ALONE: every row the bundle's own manifest has must still be there,
 *    byte-identical. A pack may add types, add attributes and child rules to types it
 *    does not own (which ADR-0050 requires to be optional) and add common attributes; it
 *    may not change or remove anything the bundle declares. This is the same composition
 *    invariant ADR-0050 holds bundled packs to, pointed outward.
 *  - THE PIN: the rows the pack adds are written to
 *    packs/<name>/fixtures/expected-vocabulary.json, the registry-conformance pattern
 *    scoped to one pack. TypeScript is the reference emitter; every port that carries the
 *    pack byte-matches the file. It never enters fixtures/registry-conformance/, so the
 *    pack never moves `metamodelVersion`.
 *
 * Usage:
 *   bun scripts/pack-vocabulary.ts <name>           # check the committed pin (the packs lane)
 *   bun scripts/pack-vocabulary.ts <name> --write   # regenerate it
 *   bun scripts/pack-vocabulary.ts --all [--write]  # every pack with a TypeScript port
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  PACK_VOCABULARY,
  REPO_ROOT,
  derivePackVocabulary,
  emitPackVocabulary,
  loadPackClosure,
  packDir,
  packNamesFromArgs,
  readPackManifest,
} from "./lib/packs.js";

export interface PackVocabularyCheck {
  readonly name: string;
  /** Every problem: the core changes, then the pin's. */
  readonly problems: string[];
  /** The rows of the bundle the pack changes; `--write` refuses while any remain. */
  readonly coreProblems: string[];
  /** The freshly derived pin, as it would be written, and the committed one (undefined when absent). */
  readonly emitted: string;
  readonly committed: string | undefined;
}

export async function checkPackVocabulary(name: string, root: string = REPO_ROOT): Promise<PackVocabularyCheck> {
  const closure = await loadPackClosure(name, root);
  const pack = closure[closure.length - 1]!;
  const { vocabulary, coreChanges } = derivePackVocabulary(readPackManifest(name, root).id, closure.slice(0, -1), pack);
  const emitted = emitPackVocabulary(vocabulary);
  const coreProblems = coreChanges.map((c) => `does not leave core alone — ${c}`);
  const problems = [...coreProblems];
  const pinPath = join(packDir(name, root), PACK_VOCABULARY);
  const committed = existsSync(pinPath) ? readFileSync(pinPath, "utf8").replace(/\r\n/g, "\n") : undefined;
  if (committed === undefined) problems.push(`${PACK_VOCABULARY} is missing — run: bun scripts/pack-vocabulary.ts ${name} --write`);
  else if (committed !== emitted) problems.push(`${PACK_VOCABULARY} is stale — the registered vocabulary changed; review it and run: bun scripts/pack-vocabulary.ts ${name} --write`);
  return { name, problems, coreProblems, emitted, committed };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const write = args.includes("--write");
  const names = packNamesFromArgs(args, "bun scripts/pack-vocabulary.ts <name>|--all [--write]");
  let failed = 0;
  for (const name of names) {
    const r = await checkPackVocabulary(name);
    if (write && r.coreProblems.length === 0) {
      const unchanged = r.committed === r.emitted;
      if (!unchanged) {
        const path = join(packDir(name), PACK_VOCABULARY);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, r.emitted);
      }
      console.log(`pack ${name}: ${unchanged ? "pin unchanged" : `wrote ${PACK_VOCABULARY}`}`);
      continue;
    }
    const shown = write ? r.coreProblems : r.problems;
    if (shown.length === 0) {
      console.log(`pack ${name}: vocabulary pinned, leaves core alone`);
    } else {
      failed++;
      console.error(`pack ${name}: ${shown.length} problem(s)`);
      for (const p of shown) console.error(`  ✖ ${p}`);
    }
  }
  if (names.length === 0) console.log("pack vocabulary: no pack has a TypeScript port");
  process.exit(failed > 0 ? 1 : 0);
}

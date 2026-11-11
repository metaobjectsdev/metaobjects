// The LEDGER arm of fixtures/dependency-conformance (FR-023): which loaded requirements are
// this project's own ledger, and whether object coverage is measured. A dependency's
// requirement joins the ledger only when `requirements.inherit` names its package, and
// never switches coverage on. Run here rather than in the sdk runner because the
// requirement gate lives in this package.

import { describe, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { effectiveRequirementPackage } from "@metaobjectsdev/metadata";
import { DEFAULT_METAOBJECTS_DIR, LOCK_FILE, loadMemory, resolveCollection } from "@metaobjectsdev/sdk";
import { scanRequirements } from "../src/lib/requirement-check.js";

interface Case {
  readonly name: string;
  readonly tree: Record<string, string>;
  readonly treeFiles?: Record<string, string>;
  readonly config: unknown | null;
  readonly lock?: unknown;
  /** `<package>::<dotted path>` → effective `@status`, EXHAUSTIVE over the ledger. */
  readonly expectLedger?: Record<string, string>;
  readonly expectCoverageMeasured?: boolean;
}

const CORPUS_DIR = resolve(import.meta.dir, "../../../../../fixtures/dependency-conformance");

async function materialize(c: Case): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mo-dep-ledger-"));
  for (const [rel, content] of Object.entries(c.tree)) {
    await mkdir(dirname(join(root, rel)), { recursive: true });
    await writeFile(join(root, rel), content);
  }
  for (const [rel, corpusRel] of Object.entries(c.treeFiles ?? {})) {
    await mkdir(dirname(join(root, rel)), { recursive: true });
    await copyFile(join(CORPUS_DIR, corpusRel), join(root, rel));
  }
  const dir = join(root, DEFAULT_METAOBJECTS_DIR);
  await mkdir(dir, { recursive: true });
  if (c.config !== null) await writeFile(join(dir, "config.json"), JSON.stringify(c.config, null, 2));
  if (c.lock !== undefined) await writeFile(join(dir, LOCK_FILE), JSON.stringify(c.lock, null, 2));
  return root;
}

const ledgerCases: Case[] = (JSON.parse(await readFile(join(CORPUS_DIR, "cases.json"), "utf8")).cases as Case[])
  .filter((c) => c.expectLedger !== undefined);

describe("dependency conformance: the ledger arm", () => {
  test("corpus has ledger cases (a silent zero-case run is a failed gate)", () => {
    expect(ledgerCases.length).toBeGreaterThan(0);
  });

  for (const c of ledgerCases) {
    test(c.name, async () => {
      const root = await materialize(c);
      const collection = await resolveCollection(root, { explicitDir: root });
      const loaded = await loadMemory(root, {
        files: collection.files,
        fileIds: collection.fileIds,
        importedPackages: collection.importedPackages,
        importedNodes: collection.importedNodes,
      });
      const scan = scanRequirements(loaded, {
        coverable: collection.inCoverage,
        inLedger: collection.inLedger,
        imported: collection.imported,
      });
      const ledger: Record<string, string> = {};
      for (const { node, path } of scan.addressed) {
        const pkg = effectiveRequirementPackage(node);
        ledger[pkg === "" ? path : `${pkg}::${path}`] = node.status() ?? "";
      }
      expect(ledger).toEqual(c.expectLedger ?? {});
      expect(scan.measureCoverage).toBe(c.expectCoverageMeasured ?? false);
    });
  }
});

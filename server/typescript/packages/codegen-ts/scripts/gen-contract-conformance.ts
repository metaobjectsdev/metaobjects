// gen-contract-conformance.ts — (re)write the contract emitters' golden trees (FR-022).
//
// Run: `bun run gen:contract-conformance` (from server/typescript/packages/codegen-ts). Pure
// metadata to JSON, no database. Each case under fixtures/contract-conformance/ runs jsonSchemaFile()
// in both profiles and openApiFile() through runGen, and its `expected/` is replaced with what they
// write. test/contract/contract-corpus.test.ts regenerates in a temp directory and fails on any
// difference. An `error-*` case's `expected-error.txt` is written by hand.
//
// Also exports the harness the corpus test uses.

import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadUris, type MetaObject, type MetaRoot, type WireFormat, wireFormatOf } from "@metaobjectsdev/metadata";
import { defineConfig, type Generator, runGen } from "../src/index.js";
import { jsonSchemaFile, openApiFile } from "../src/generators/index.js";
import { readTree } from "./gen-cube-model-canonical.js";

// scripts → codegen-ts → packages → typescript → server → repo root
const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..", "..");

export const CONTRACT_CORPUS_DIR = join(REPO_ROOT, "fixtures", "contract-conformance");

/** This script, as a failing test names it. */
export const CONTRACT_SCRIPT = "server/typescript/packages/codegen-ts/scripts/gen-contract-conformance.ts (bun run gen:contract-conformance)";

/** Every case serves under this prefix, the one the api-contract corpus requests. */
const API_PREFIX = "/api";

export interface ContractCase {
  readonly name: string;
  readonly dir: string;
  /** The metadata file: the case's own `meta.json`, or a shared one `case.json` names. */
  readonly meta: string;
  readonly wire?: Partial<WireFormat>;
  /** Objects the strict profile leaves out, because the strict subset cannot state them. */
  readonly strictExclude: readonly string[];
  /** The project wires `report-export`, so a report's list route takes `format`. */
  readonly reportExport: boolean;
}

interface CaseJson {
  /** Repository-relative metadata file. Default: `meta.json` beside it. */
  meta?: string;
  wire?: Partial<WireFormat>;
  strictExclude?: string[];
  reportExport?: boolean;
}

function readCase(name: string): ContractCase {
  const dir = join(CONTRACT_CORPUS_DIR, name);
  const path = join(dir, "case.json");
  const json = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as CaseJson) : {};
  return {
    name,
    dir,
    meta: json.meta === undefined ? join(dir, "meta.json") : join(REPO_ROOT, json.meta),
    ...(json.wire !== undefined && { wire: json.wire }),
    strictExclude: json.strictExclude ?? [],
    reportExport: json.reportExport ?? false,
  };
}

/** Every case, in name order. */
export function contractCases(): ContractCase[] {
  return readdirSync(CONTRACT_CORPUS_DIR)
    .filter((name) => statSync(join(CONTRACT_CORPUS_DIR, name)).isDirectory())
    .sort()
    .map(readCase);
}

export async function loadCaseModel(c: ContractCase): Promise<MetaRoot> {
  const result = await loadUris([pathToFileURL(c.meta).href]);
  if (result.errors.length > 0) {
    throw new Error(`${c.meta}: metadata did not load cleanly: ${result.errors.map((e) => e.message).join("; ")}`);
  }
  if (c.wire !== undefined) result.root.wireFormat = { ...wireFormatOf(result.root), ...c.wire };
  return result.root;
}

/** The generators a case runs. A caller passes its own factories to run the reference copies. */
export interface ContractFactories {
  readonly jsonSchemaFile: typeof jsonSchemaFile;
  readonly openApiFile: typeof openApiFile;
}

/** What marks `report-export` for the runner. The generator's own files are not this corpus's subject. */
const REPORT_EXPORT_MARKER: Generator = { name: "report-export", emitsReportExport: true, generate: () => [] };

function caseGenerators(c: ContractCase, factories: ContractFactories): Generator[] {
  const inStrict = (obj: MetaObject): boolean => !c.strictExclude.includes(obj.name);
  return [
    factories.jsonSchemaFile(),
    factories.jsonSchemaFile({ profile: "strict", filter: inStrict }),
    factories.openApiFile({ title: c.name, version: "1.0.0" }),
    ...(c.reportExport ? [REPORT_EXPORT_MARKER] : []),
  ];
}

/** Run a case's generators into a fresh temp directory and read back what they wrote. */
export async function contractTree(c: ContractCase, factories: ContractFactories = { jsonSchemaFile, openApiFile }): Promise<Map<string, string>> {
  const root = await loadCaseModel(c);
  const dir = mkdtempSync(join(tmpdir(), "contract-conformance-"));
  try {
    const outDir = join(dir, "out");
    await runGen({
      config: defineConfig({ outDir, dialect: "postgres", apiPrefix: API_PREFIX, generators: caseGenerators(c, factories) }),
      metadata: root,
      genStateDir: join(dir, ".gen-state"),
    });
    return readTree(outDir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  for (const c of contractCases()) {
    if (c.name.startsWith("error-")) continue;
    const fresh = mkdtempSync(join(tmpdir(), "contract-expected-"));
    try {
      for (const [path, content] of await contractTree(c)) {
        const full = join(fresh, path);
        mkdirSync(join(full, ".."), { recursive: true });
        await Bun.write(full, content);
      }
      const expected = join(c.dir, "expected");
      rmSync(expected, { recursive: true, force: true });
      cpSync(fresh, expected, { recursive: true });
      console.log(`${c.name}: wrote ${readdirSync(fresh, { recursive: true }).length} entries`);
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  }
}

if (import.meta.main) await main();

#!/usr/bin/env bun
/**
 * Write the `expected.json` of a requirement conformance corpus from the TypeScript
 * reference.
 *
 *   bun scripts/write-requirement-corpus-expected.ts check
 *
 * ── What this is, and what it is not ───────────────────────────────────────────
 *
 * ADR-0057 puts the requirement gate in every port, and the corpus is what holds the
 * other four to this one. The expectations come from the reference rather than being
 * typed by hand, so the message text is the text the reference really prints.
 *
 * That makes the output a SNAPSHOT, and a snapshot is not a contract. It becomes one
 * only when every written file is read against the tables the ports copy
 * (the corpus README says which). So: run this, then review the diff case by case. A
 * case that reports more than it is meant to pin gets its INPUT fixed. A disagreement
 * between the tables and the reference is a finding about the reference — it is never
 * settled by editing an expectation, and never by re-running this until it looks right.
 *
 * A case that does not load strict is refused: nothing is written for it and the run
 * exits non-zero. Each port's runner asserts a clean load first, so an expectation
 * computed over a model that did not load would pin nothing.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// RELATIVE, as in `generate-requirement-harness.ts`: `scripts/` sits outside the bun
// workspace, so a bare `@metaobjectsdev/*` specifier does not resolve from here.
import { MetaDataLoader, type MetaData } from "../server/typescript/packages/metadata/src/index.js";
import { REQUIREMENT_STATUSES } from "../server/typescript/packages/metadata/src/core/requirement/requirement-constants.js";
import {
  checkRequirements,
  scanRequirements,
  summariseRequirements,
  type Diagnostic,
  type RequirementSummary,
} from "../server/typescript/packages/cli/src/lib/requirement-check.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** One conformance corpus this script can write. Adding a corpus is one more entry in
 *  {@link CORPORA}: its directory, the option keys its cases may set, and how one loaded
 *  case becomes the object its `expected.json` holds. */
interface Corpus {
  /** Repository-relative directory holding one sub-directory per case. */
  readonly dir: string;
  /** Every key a case's `options.json` may carry. Anything else is refused. */
  readonly optionKeys: readonly string[];
  expected(root: MetaData, options: Readonly<Record<string, unknown>>): unknown;
}

// ---------------------------------------------------------------------------
// check — fixtures/requirement-check-conformance
// ---------------------------------------------------------------------------

/** Key order is fixed so a rewrite produces no diff: `path` is omitted, not nulled, on a
 *  diagnostic that has none (object coverage names its entity in the message). */
function diagnosticRecord(d: Diagnostic): Record<string, string> {
  return {
    severity: d.severity,
    code: d.code,
    ...(d.path === undefined ? {} : { path: d.path }),
    message: d.message,
  };
}

/** Statuses in their registered order, zero counts left out; the coverage pair only when
 *  the run measured coverage, which is what its absence means to a port. */
function summaryRecord(s: RequirementSummary): Record<string, unknown> {
  const byStatus: Record<string, number> = {};
  for (const status of REQUIREMENT_STATUSES) {
    const count = s.byStatus[status];
    if (count !== undefined) byStatus[status] = count;
  }
  return {
    total: s.total,
    functional: s.functional,
    architectural: s.architectural,
    byStatus,
    undecided: s.undecided,
    deferredUntracked: s.deferredUntracked,
    ...(s.entitiesClaimed === undefined ? {} : { entitiesClaimed: s.entitiesClaimed }),
    ...(s.entitiesTotal === undefined ? {} : { entitiesTotal: s.entitiesTotal }),
  };
}

function checkExpected(root: MetaData, options: Readonly<Record<string, unknown>>): unknown {
  const scan = scanRequirements(root, { requireImplementers: options["requireImplementers"] === true });
  const summary = summariseRequirements(root, scan);
  return {
    // Emission order — the order the reference evaluates its checks in — so the file
    // reads top to bottom against its input. Runners compare it as a multiset.
    diagnostics: checkRequirements(root, scan).map(diagnosticRecord),
    summary: summary === undefined ? null : summaryRecord(summary),
  };
}

const CORPORA: Readonly<Record<string, Corpus>> = {
  check: {
    dir: "fixtures/requirement-check-conformance",
    optionKeys: ["libraries", "requireImplementers"],
    expected: checkExpected,
  },
};

// ---------------------------------------------------------------------------
// The part every corpus shares: find the cases, load each one, write the file.
// ---------------------------------------------------------------------------

function readOptions(caseDir: string, corpus: Corpus): Record<string, unknown> {
  const file = join(caseDir, "options.json");
  if (!existsSync(file)) return {};
  const options = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  const unknown = Object.keys(options).filter((k) => !corpus.optionKeys.includes(k));
  if (unknown.length > 0) throw new Error(`unknown option(s) ${unknown.join(", ")} in options.json`);
  return options;
}

function librariesOf(options: Readonly<Record<string, unknown>>): string[] {
  const libraries = options["libraries"];
  if (libraries === undefined) return [];
  if (!Array.isArray(libraries) || !libraries.every((l): l is string => typeof l === "string")) {
    throw new Error("'libraries' in options.json must be an array of strings");
  }
  return libraries;
}

async function main(): Promise<number> {
  const name = process.argv[2];
  const corpus = name === undefined ? undefined : CORPORA[name];
  if (corpus === undefined) {
    console.error(
      `usage: bun scripts/write-requirement-corpus-expected.ts <corpus>\n` +
      `  corpora: ${Object.keys(CORPORA).join(", ")}\n`,
    );
    return 2;
  }

  const corpusDir = join(REPO_ROOT, corpus.dir);
  const cases = readdirSync(corpusDir).filter((n) => statSync(join(corpusDir, n)).isDirectory()).sort();
  let written = 0;
  let unchanged = 0;
  let refused = 0;

  for (const caseName of cases) {
    const caseDir = join(corpusDir, caseName);
    let content: string;
    try {
      const options = readOptions(caseDir, corpus);
      const libraries = librariesOf(options);
      const { root, errors } = await MetaDataLoader.fromDirectory(join(caseDir, "input"), {
        strict: true,
        ...(libraries.length > 0 ? { libraries } : {}),
      });
      if (errors.length > 0) throw new Error(`does not load strict:\n${errors.map((e) => `    ${String(e)}`).join("\n")}`);
      content = JSON.stringify(corpus.expected(root, options), null, 2) + "\n";
    } catch (err) {
      console.error(`  REFUSED  ${caseName}: ${err instanceof Error ? err.message : String(err)}`);
      refused++;
      continue;
    }
    const target = join(caseDir, "expected.json");
    if (existsSync(target) && readFileSync(target, "utf8") === content) {
      unchanged++;
      continue;
    }
    writeFileSync(target, content);
    console.log(`  wrote    ${caseName}/expected.json`);
    written++;
  }

  console.log(
    `${corpus.dir}: ${cases.length} case(s) — ${written} written, ${unchanged} unchanged, ${refused} refused.` +
    (written > 0 ? `\nReview every written file by hand before committing it.` : ``),
  );
  return refused > 0 ? 1 : 0;
}

process.exit(await main());

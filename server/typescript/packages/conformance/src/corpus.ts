// The corpus-root entry point: run every scenario under ANY corpus directory.
//
// The shared metamodel corpus (fixtures/conformance/) is driven per port by a test file
// that enumerates it as one bun test per fixture. An independent pack (ADR-0069) keeps
// its corpus inside its own directory, packs/<name>/fixtures/conformance/, so the same
// runner needs a second way in: give it a root and an adapter, get back one verdict per
// scenario. It changes nothing about how a fixture is read or checked — it is the
// discover → lint → run → classify loop the core test file performs, as a function.
//
// `requireProviders` is the independent-pack port rule made mechanical: a pack's corpus
// exists to prove the PACK, so every scenario must name the pack's provider id in its
// providers.json. A scenario with no providers.json falls back to the default bundle,
// which by definition does not carry an independent pack, and would test core instead.

import { discoverFixtures, isContractOnlyFixture, isDocsOnlyFixture } from "./fixture.js";
import type { ConformanceAdapter } from "./adapter.js";
import { lintFixture } from "./fixture-lint.js";
import { runFixture } from "./runner.js";
import { classifyAgainstLedger } from "./expected-failures.js";
import type { FixtureStatus } from "./report.js";

export interface CorpusOptions {
  /** Absolute path of the corpus directory: one sub-directory per scenario. */
  readonly corpusRoot: string;
  /** The port's adapter, composed with every provider id the corpus names. */
  readonly adapter: ConformanceAdapter;
  /** The error codes an `expected-errors.json` may name (fixtures/conformance/ERROR-CODES.json). */
  readonly errorCodes: readonly string[];
  /** Fixture names this port expects to fail (the expected-failures ledger). Default: none. */
  readonly ledger?: readonly string[];
  /** Provider ids every scenario's providers.json must list. Default: none. */
  readonly requireProviders?: readonly string[];
}

/** One scenario's verdict. `skipped` is a docs-only or contract-only fixture, run elsewhere. */
export interface CorpusFixtureResult {
  readonly name: string;
  readonly status: FixtureStatus | "skipped";
  /** Lint problems and failed-check details; empty on a pass. */
  readonly problems: readonly string[];
}

export interface CorpusResult {
  readonly corpusRoot: string;
  readonly fixtures: readonly CorpusFixtureResult[];
  /**
   * True when at least one scenario ran and none is `fail` or `fixed-but-listed`. A corpus
   * with nothing runnable (empty, or docs-only and contract-only scenarios alone) tests
   * nothing, so it does not pass.
   */
  readonly passed: boolean;
}

/** Run every scenario under `corpusRoot` through `adapter`. */
export async function runCorpus(opts: CorpusOptions): Promise<CorpusResult> {
  const ledger = opts.ledger ?? [];
  const required = opts.requireProviders ?? [];
  const results: CorpusFixtureResult[] = [];
  for (const fix of await discoverFixtures(opts.corpusRoot)) {
    // The provider rule comes first, so a docs-only or contract-only scenario in a pack's
    // corpus must name the pack too.
    const missing = required
      .filter((id) => !fix.providers.includes(id))
      .map((id) => `providers.json must name "${id}" (it lists: ${fix.providers.join(", ")})`);
    if (isDocsOnlyFixture(fix) || isContractOnlyFixture(fix)) {
      results.push(missing.length > 0 ? { name: fix.name, status: "fail", problems: missing } : { name: fix.name, status: "skipped", problems: [] });
      continue;
    }
    const problems = [...lintFixture(fix, opts.errorCodes), ...missing];
    if (problems.length > 0) {
      results.push({ name: fix.name, status: "fail", problems });
      continue;
    }
    let report: Awaited<ReturnType<typeof runFixture>>;
    try {
      report = await runFixture(fix, opts.adapter);
    } catch (e) {
      // An adapter that throws (an unknown provider id, say) is this scenario's failure,
      // not the run's: every other scenario still gets its verdict.
      results.push({ name: fix.name, status: "fail", problems: [`the adapter threw: ${(e as Error).message}`] });
      continue;
    }
    const status = classifyAgainstLedger(report.status === "pass" ? "pass" : "fail", fix.name, ledger);
    const failed = report.checks.filter((c) => !c.passed).map((c) => c.detail ?? c.kind);
    results.push({
      name: fix.name,
      status,
      problems: status === "fixed-but-listed" ? ["passes but is listed in the expected-failures ledger"] : failed,
    });
  }
  const ran = results.some((r) => r.status !== "skipped");
  const passed = ran && results.every((r) => r.status !== "fail" && r.status !== "fixed-but-listed");
  return { corpusRoot: opts.corpusRoot, fixtures: results, passed };
}

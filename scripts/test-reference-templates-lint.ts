#!/usr/bin/env bun
/**
 * Self-test for scripts/check-reference-templates-lint.ts.
 *
 * Two halves, for the two ways this gate could be useless.
 *
 * 1. It could pass because it checks nothing. The real tree is clean by design once
 *    the templates are fixed, so a green run proves only that SOMETHING exited 0 — an
 *    empty path list, a config that disables every rule, and a working gate all look
 *    identical from outside. So the first half replays the incident: a synthetic file
 *    carrying one instance of each of the five rules that actually shipped in the
 *    templates must be reported, BY NAME, one assertion per rule. A rule that leaves
 *    biome's `recommended` set in a future version fails here rather than silently
 *    dropping out of the gate's coverage.
 *
 * 2. Discovery could quietly shrink. It keys on a marker line, so a reworded header
 *    or a moved package reduces the set to a subset — and a smaller set still passes.
 *    The second half pins that all four kinds of copy are found (each package's
 *    `src/reference/`, the private test-generators package, and both example
 *    scaffolds), and that discovery over a tree with no templates returns nothing —
 *    which the gate turns into a REFUSAL, not a pass.
 *
 *   bun scripts/test-reference-templates-lint.ts
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverTemplates,
  resolveBiomeBin,
  writeStockConfig,
  lintPaths,
} from "./check-reference-templates-lint.js";

let fails = 0;
const ok = (m: string) => console.log(`ok:   ${m}`);
const bad = (m: string) => { console.error(`FAIL: ${m}`); fails++; };

// One instance of each rule a shipped reference template actually violated.
const REPLAYS: Record<string, string> = {
  noNonNullAssertion: "export function a(x?: { y: number }) { return x!.y; }",
  noUnusedTemplateLiteral: "export const b = `plain`;",
  useTemplate: 'export function c(n: number) { return "n is " + n; }',
  noConfusingVoidType: "export type D = string | void;",
  useImportType: 'import { type Stats } from "node:fs";\nexport type E = Stats;',
};

// Every kind of copy the marker is supposed to reach. Prefixes, not exact paths, so
// adding a template to a package that already has some does not fail this test —
// only LOSING a whole class of copy does.
const EXPECTED_KINDS = [
  "server/typescript/packages/codegen-ts/src/reference/",
  "server/typescript/packages/codegen-ts-react/src/reference/",
  "server/typescript/packages/codegen-ts-tanstack/src/reference/",
  "server/typescript/packages/test-generators/src/",
  "examples/showcase/codegen/generators/",
  "examples/advanced-modeling/codegen/generators/",
];

const bin = resolveBiomeBin();
if (!bin) {
  console.error("FAIL: no biome binary — run `bun install` first");
  process.exit(1);
}

const configDir = writeStockConfig();
const probe = mkdtempSync(join(tmpdir(), "mo-ref-lint-test-"));
try {
  // ── 1. the gate reports every rule the templates actually broke ──────────────
  const violating = join(probe, "violating.ts");
  writeFileSync(violating, `${Object.values(REPLAYS).join("\n")}\n`);
  const dirty = await lintPaths(bin, configDir, [violating], probe);
  if (dirty.ok) bad("a file violating all five rules was reported CLEAN");
  else ok("a violating file is reported (exit non-zero)");
  for (const rule of Object.keys(REPLAYS)) {
    if (dirty.output.includes(rule)) ok(`rule reported by name: ${rule}`);
    else bad(`rule NOT reported — no longer covered by biome's recommended set: ${rule}`);
  }

  // ...and a clean file in the same position passes, so the failure above is the
  // content and not the plumbing (a broken invocation fails every file alike).
  const cleanFile = join(probe, "clean.ts");
  writeFileSync(cleanFile, 'export const greeting = "hello";\n');
  const clean = await lintPaths(bin, configDir, [cleanFile], probe);
  if (clean.ok) ok("a clean file passes (the failure above is content, not plumbing)");
  else bad(`a clean file was reported dirty:\n${clean.output}`);

  // ── 2. discovery neither shrinks nor invents ────────────────────────────────
  const templates = await discoverTemplates();
  for (const kind of EXPECTED_KINDS) {
    const n = templates.filter((t) => t.startsWith(kind)).length;
    if (n > 0) ok(`discovery: ${kind} (${n} template(s))`);
    else bad(`discovery lost a whole class of copy: ${kind}`);
  }

  const emptyRepo = join(probe, "empty-repo");
  mkdirSync(emptyRepo, { recursive: true });
  await Bun.spawn(["git", "init", "-q"], { cwd: emptyRepo, stdout: "ignore", stderr: "ignore" }).exited;
  if ((await discoverTemplates(emptyRepo)).length === 0) {
    ok("discovery over a tree with no templates returns nothing (the gate refuses)");
  } else {
    bad("discovery invented templates in an empty tree");
  }
} finally {
  rmSync(configDir, { recursive: true, force: true });
  rmSync(probe, { recursive: true, force: true });
}

console.log(fails ? `\n${fails} test(s) FAILED` : "\nreference-template lint tests: all passed");
process.exit(fails ? 1 : 0);

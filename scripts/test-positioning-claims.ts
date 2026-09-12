#!/usr/bin/env bun
/**
 * Tests for scripts/check-positioning-claims.ts.
 *
 * The gate can only ever prove the happy path against the real tree, because the real tree
 * is compliant the moment the gate is green — and a green run over a compliant tree cannot
 * tell "nothing matched" from "this pattern matches nothing, ever". These synthetic cases
 * drive the scan in BOTH directions, including the exact sentences the 2026-09 positioning
 * work removed, so a typo'd pattern fails here instead of passing forever.
 *
 *   bun scripts/test-positioning-claims.ts
 */
import { BANNED, ALLOWED, scan, type Allowance } from "./check-positioning-claims.js";

let fails = 0;
const ok = (m: string) => console.log(`ok:   ${m}`);
const bad = (m: string) => { console.error(`FAIL: ${m}`); fails++; };

const one = (text: string, file = "README.md") => scan([{ file, text }]);

// --- every banned phrase actually matches something -------------------------------
// The sentences below are the real ones this FR removed, not invented strings: a pattern
// written against a phrasing nobody uses is a pattern that never fires.
const REAL_VIOLATIONS: [string, string][] = [
  ["One schema. Five languages. Zero drift.", "zero drift"],
  ["that class of error is now structurally impossible.", "structurally impossible"],
  ["Make schema drift a compile-time error.", "compile-time error"],
  ["Four pillars. All shipping.", "four-pillars slogan"],
  ["## Guardrails", "guardrails"],
  ["The metadata foundation for AI-native development", "AI-native"],
  ["The #1 reason in the AI era: drift breaks the build.", "for the AI era"],
  ["The metadata is the topology of requirements and implementation", "topology"],
  ["Nobody else has built this.", "nobody else has built this"],
  ["It is simply the best way to code with AI.", "best way to code with AI"],
];
for (const [text, label] of REAL_VIOLATIONS) {
  one(text).hits.length === 1
    ? ok(`catches: ${label}`)
    : bad(`${label}: expected exactly 1 hit for ${JSON.stringify(text)}`);
}

// Each rule is reachable — a rule nothing in the corpus above trips is a dead pattern.
const tripped = new Set(REAL_VIOLATIONS.flatMap(([t]) => one(t).hits.map((h) => h.rule.pattern.source)));
BANNED.every((r) => tripped.has(r.pattern.source))
  ? ok(`all ${BANNED.length} rules are reachable`)
  : bad(`dead rule(s): ${BANNED.filter((r) => !tripped.has(r.pattern.source)).map((r) => r.pattern.source).join(", ")}`);

// --- and does NOT match the sentences that replaced them --------------------------
// The false-positive direction is the one that makes a gate get disabled.
for (const text of [
  "The build fails when generated code drifts from the model.",
  "The other four pillars keep the code honest about the model.",
  "The first four pillars ship per-language across all five ports.",
  "four pillars: codegen, runtime metadata, drift detection, prompt construction",
  "one declaration instead of N restatements, and the build fails when any copy disagrees",
  "No one combines these.",
  "now fails the build instead of reaching production",
]) {
  one(text).hits.length === 0
    ? ok(`allows: ${text.slice(0, 52)}…`)
    : bad(`false positive on: ${text}`);
}

// --- allowances are file-scoped and substring-exact --------------------------------
// A blanket per-file allowance would excuse a real overclaim in the same file, which is
// how an allowlist stops being a list of exceptions and becomes a hole.
const allow: Allowance[] = [{ file: "a.md", contains: "reach **zero drift** against", reason: "test" }];
const sameFile = scan(
  [{ file: "a.md", text: "can reach **zero drift** against a hand-built schema\nMetaObjects gives you zero drift." }],
  BANNED, allow,
);
sameFile.hits.length === 1 && sameFile.hits[0]?.line === 2
  ? ok("allowance excuses its own line only, not the file")
  : bad(`expected 1 hit on line 2, got ${sameFile.hits.length} at line ${sameFile.hits[0]?.line}`);

scan([{ file: "b.md", text: "can reach **zero drift** against a hand-built schema" }], BANNED, allow).hits.length === 1
  ? ok("an allowance does not carry to another file")
  : bad("allowance leaked across files");

// --- a stale allowance is reported, not silently carried ---------------------------
const stale = scan([{ file: "a.md", text: "nothing to excuse here" }], BANNED, allow);
stale.orphans.length === 1
  ? ok("stale allowance is surfaced when its text is gone")
  : bad(`expected 1 orphan, got ${stale.orphans.length}`);

// --- every shipped allowance carries a real reason ---------------------------------
// The field is what separates "we thought about this one" from "we silenced it".
ALLOWED.every((a) => a.reason.trim().length > 40)
  ? ok(`all ${ALLOWED.length} shipped allowances carry a written reason`)
  : bad("an allowance has a missing or perfunctory reason");

console.log(fails === 0 ? "\npositioning-claims self-test: OK" : `\n${fails} failure(s)`);
process.exit(fails === 0 ? 0 : 1);

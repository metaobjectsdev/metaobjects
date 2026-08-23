#!/usr/bin/env bun
/**
 * Self-test for the shipped-example gate (scripts/check-doc-examples.ts).
 *
 * A gate is only worth its runtime if it FAILS on the thing it exists to catch, so this
 * replays the three incidents that motivated it (#337, #342, #343) as fixture documents
 * and asserts a non-zero exit each time. It also asserts the quiet cases stay quiet —
 * a partial fragment, an unrelated JSON block — because a gate that flags illustrations
 * gets switched off, and then catches nothing at all.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHECKER = new URL("check-doc-examples.ts", import.meta.url).pathname;

interface Case {
  readonly name: string;
  readonly markdown: string;
  /** true when the gate must reject this document. */
  readonly shouldFail: boolean;
  /** Substring the failure output must contain, proving it failed for the right reason. */
  readonly because?: string;
}

const CASES: readonly Case[] = [
  {
    // #337 — the agent-context docs described @verifiedBy as live after FR-038 retired it.
    name: "#337 retired attribute (@verifiedBy)",
    shouldFail: true,
    because: "ERR_UNKNOWN_ATTR",
    markdown: [
      "```json",
      '{ "requirement.functional": { "name": "recallMeasurement", "@level": 4,',
      '  "@verifiedBy": ["MeasurementTest"] } }',
      "```",
    ].join("\n"),
  },
  {
    // #343 — docs/llms taught the pre-0.24.0 @status enum a release after it shrank.
    name: "#343 retired enum member (@status: abandoned)",
    shouldFail: true,
    because: "ERR_BAD_ATTR_VALUE",
    markdown: [
      "```json",
      '{ "requirement.functional": { "name": "recallMeasurement", "@level": 4,',
      '  "@status": "abandoned" } }',
      "```",
    ].join("\n"),
  },
  {
    // #342 — metaobjects-authoring gave @fields together with @expr as a worked example,
    // the exact spelling that release turned into a load error. This is the case a
    // retired-token scan cannot see: both attributes are live, the COMBINATION is not.
    name: "#342 illegal combination (@fields with @expr)",
    shouldFail: true,
    because: "ERR_INVALID_INDEX",
    markdown: [
      "```json",
      '{ "index.lookup": { "name": "idx_users_lower_email",',
      '  "@fields": ["email"], "@expr": "lower(email)" } }',
      "```",
    ].join("\n"),
  },
  {
    // The everyday case: a fragment that omits everything around it must stay silent,
    // or the gate is noise and gets disabled.
    name: "partial fragment stays quiet",
    shouldFail: false,
    markdown: [
      "```json",
      '{ "field.string": { "name": "email", "@maxLength": 120 } }',
      "```",
    ].join("\n"),
  },
  {
    // A fragment pointing at an entity defined in a neighbouring block: a REFERENCES
    // error, which is fragment-ness, not drift.
    name: "unresolved reference stays quiet",
    shouldFail: false,
    markdown: [
      "```json",
      '{ "identity.reference": { "name": "refClient", "@fields": ["clientId"],',
      '  "@references": "Client" } }',
      "```",
    ].join("\n"),
  },
  {
    // Not metadata at all — a config snippet must not be dragged in.
    name: "non-metadata JSON is ignored",
    shouldFail: false,
    markdown: ['```json', '{ "outDir": "src/generated", "dialect": "sqlite" }', "```"].join("\n"),
  },
  {
    name: "opt-out marker suppresses a provider-registered attribute",
    shouldFail: false,
    markdown: [
      "<!-- meta-example: external-provider -->",
      "",
      "```json",
      '{ "template.toolcall": { "name": "InvokeTool", "@textRef": "custom" } }',
      "```",
    ].join("\n"),
  },
];

let failures = 0;

for (const testCase of CASES) {
  const dir = mkdtempSync(join(tmpdir(), "doc-example-gate-"));
  try {
    writeFileSync(join(dir, "example.md"), testCase.markdown, "utf8");

    const proc = Bun.spawnSync(["bun", CHECKER, dir], { stdout: "pipe", stderr: "pipe" });
    const output = proc.stdout.toString() + proc.stderr.toString();
    const failed = proc.exitCode !== 0;

    if (failed !== testCase.shouldFail) {
      failures++;
      console.error(
        `✗ ${testCase.name}\n    expected the gate to ${testCase.shouldFail ? "REJECT" : "ACCEPT"}` +
        `, it ${failed ? "rejected" : "accepted"}\n${output.replace(/^/gm, "    ")}`);
      continue;
    }
    if (testCase.because !== undefined && !output.includes(testCase.because)) {
      failures++;
      console.error(
        `✗ ${testCase.name}\n    rejected, but not for ${testCase.because} — the gate may be ` +
        `failing for an unrelated reason\n${output.replace(/^/gm, "    ")}`);
      continue;
    }
    console.log(`✓ ${testCase.name}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (failures > 0) {
  console.error(`\n✗ ${failures} doc-example gate self-test(s) failed`);
  process.exit(1);
}
console.log(`\n✓ ${CASES.length} doc-example gate self-test(s) passed`);

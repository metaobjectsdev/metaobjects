#!/usr/bin/env bun
/**
 * Self-test for the shipped-example gate (scripts/check-doc-examples.ts).
 *
 * A gate is only worth its runtime if it FAILS on the thing it exists to catch, so this
 * replays the three incidents that motivated it (#337, #342, #343) as fixture documents
 * and asserts a non-zero exit each time. It also asserts the quiet cases stay quiet —
 * a partial fragment, an unrelated JSON block — because a gate that flags illustrations
 * gets switched off, and then catches nothing at all.
 *
 * The second half of the file covers NORMALISATION: an elided or stacked fence used to be
 * skipped whole, hiding whatever else it said. Those cases come in pairs on purpose — one
 * proving the hidden defect is now caught, one proving correct documentation is still
 * accepted — because either half alone would be satisfied by a gate that is simply wrong
 * in one direction.
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
  /**
   * Substring the output must contain regardless of pass/fail — for asserting on the
   * skip-visibility report (#337-family blind-spot fix) without asserting anything
   * about the exit code, which stays 0 for every skip reason on purpose.
   */
  readonly mustContain?: string;
  /**
   * Extra scan roots appended after the fixture dir — the only way to exercise the
   * gate's handling of a root it cannot read, which has no `markdown` of its own.
   */
  readonly extraRoots?: readonly string[];
}

const CASES: readonly Case[] = [
  {
    // A root the gate cannot read is a BROKEN gate, not an empty one. It used to
    // `continue` past one, so a renamed directory — or a path that only exists after a
    // build step — shrank the corpus in silence and still printed a tick. That was live:
    // SCAN_ROOTS pointed at the gitignored agent-context BUNDLE rather than the tracked
    // source, so on a fresh clone the run reported "✓ 40 shipped metadata example(s)",
    // exit 0, having checked 51 fewer than it does with the root present — and the corpus
    // it silently dropped is the one this gate was built for (#337 was about the
    // agent-context skills teaching retired vocabulary).
    name: "a scan root that does not exist FAILS, rather than quietly grading less",
    shouldFail: true,
    because: "scan root not found",
    extraRoots: ["definitely/not/a/real/directory"],
    // Valid content, so the ONLY reason this run can fail is the unreadable root.
    markdown: [
      "# Fixture",
      "",
      "```json",
      '{ "field.string": { "name": "email", "@maxLength": 255 } }',
      "```",
      "",
    ].join("\n"),
  },
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
    // ADR-0006 makes YAML the universal authoring front-end, and the authoring skill
    // teaches in it — so a YAML example carrying retired vocabulary is the #337 shape
    // exactly. This case fails if the YAML path is ever skipped again.
    name: "retired attribute in a sigil-free YAML block",
    shouldFail: true,
    because: "ERR_UNKNOWN_ATTR",
    markdown: [
      "```yaml",
      "requirement.functional:",
      "  name: recallMeasurement",
      "  level: 4",
      "  verifiedBy: [MeasurementTest]",
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
  // ── De-elision: the two conventions that used to hide a whole block ──────────────
  //
  // An elision (`...`) and a stacked fence each made a block fail to parse AS ONE VALUE,
  // and the block was then skipped WHOLE — taking every attribute the author did write
  // with it. Both are now normalised and checked. The pairs below are deliberate: each
  // "is caught" case is matched by an "is not manufactured" case, because a gate that
  // starts flagging correct documentation gets switched off, and then catches nothing.
  {
    // The exact shape that motivated the work: a retired attribute two lines above the
    // `...` that hid it. `@emitTanstack` is retired vocabulary as of 0.24.6 (FR-040 —
    // the @emit* family left the model), which is what makes it the right fixture and
    // not merely an unused name: this is a spelling the docs really did teach.
    name: "an elision no longer hides a retired attribute",
    shouldFail: true,
    because: "ERR_UNKNOWN_ATTR",
    markdown: [
      "```json",
      '{ "object.entity": { "name": "InternalAudit", "@emitTanstack": false,',
      '  "children": [ ... ] } }',
      "```",
    ].join("\n"),
  },
  {
    // The anti-cry-wolf pin, and it matters as much as the case above. Eliding a long
    // `children` array is normal, good documentation practice; de-elision must leave a
    // correct block correct. The inner `{ ... }` also pins the hole-pruning: without it
    // the de-elided array holds an empty object and the loader fails a document that
    // said nothing wrong.
    // The summary assertion is what stops this pin being vacuous: "quiet" alone was also
    // true when the block was SKIPPED, which is the behaviour being replaced. One example
    // out of one block says it was read, and passed.
    name: "de-elision does not manufacture a failure",
    shouldFail: false,
    mustContain: "1 shipped metadata example(s) from 1 fenced block(s)",
    markdown: [
      "```json",
      '{ "object.entity": { "name": "Ledger", "children": [',
      '  { "field.string": { "name": "note" } },',
      "  { ... }",
      "] } }",
      "```",
    ].join("\n"),
  },
  {
    // Elision-stripping runs over a STRING-MASKED copy, so a "..." inside a quoted value
    // is never deleted. Observable only through a value the loader checks: an enum member
    // must match ^[A-Za-z_][A-Za-z0-9_]*$, so `CLO...SED` is illegal — and would silently
    // become the legal `CLOSED` if the mask were ever dropped, turning this into a pass.
    name: "quoted text survives de-elision (string mask)",
    shouldFail: true,
    because: "ERR_BAD_ATTR_VALUE",
    markdown: [
      "```json",
      '{ "object.entity": { "name": "Ledger", "children": [',
      '  { "field.enum": { "name": "status", "@values": ["OPEN", "CLO...SED"] } },',
      "  ...",
      "] } }",
      "```",
    ].join("\n"),
  },
  {
    // YAML elisions are the nastier half: an indented `...` is a valid plain scalar, so
    // the block PARSES and the string child aborts the node before the loader reaches its
    // attributes — a green tick over an unchecked document. ADR-0006 makes YAML the
    // authoring front-end, so this is the #337 shape on the surface agents write in.
    name: "an elision that PARSES as a YAML scalar no longer hides a retired attribute",
    shouldFail: true,
    because: "ERR_UNKNOWN_ATTR",
    markdown: [
      "```yaml",
      "object.entity:",
      "  name: Ledger",
      "  emitTanstack: false",
      "  children:",
      "    - ...",
      "```",
    ].join("\n"),
  },
  {
    // The other YAML shape: a bare indented `...` is a parse ERROR, and is rescued by the
    // line-based stripper rather than by the post-parse prune above. Two code paths, two
    // cases — one fixture cannot cover both.
    name: "an elision that BREAKS the YAML parse no longer hides a retired attribute",
    shouldFail: true,
    because: "ERR_UNKNOWN_ATTR",
    markdown: [
      "```yaml",
      "object.entity:",
      "  name: Ledger",
      "  emitTanstack: false",
      "  ...",
      "```",
    ].join("\n"),
  },
  // ── De-stacking ─────────────────────────────────────────────────────────────────
  {
    // Several one-line examples in one fence are several documents. Asserting the SUMMARY
    // is the point: "quiet" alone would also be satisfied by skipping them, which is what
    // used to happen. Two examples out of one block is the proof they were checked.
    name: "stacked one-liners are each checked, not skipped",
    shouldFail: false,
    mustContain: "2 shipped metadata example(s) from 1 fenced block(s)",
    markdown: [
      "```json",
      '{ "field.uuid": { "name": "id" } }',
      '{ "field.string": { "name": "id", "@dbColumnType": "uuid" } }',
      "```",
    ].join("\n"),
  },
  {
    // One bad piece fails the fence, and the report says WHICH — a finding a reader cannot
    // locate inside a four-line fence is a finding they will not act on.
    name: "a stacked fence fails on its bad piece, and names the piece",
    shouldFail: true,
    because: "ERR_UNKNOWN_ATTR",
    mustContain: "piece 2 of 3",
    markdown: [
      "```json",
      '{ "field.uuid": { "name": "id" } }',
      '{ "object.entity": { "name": "InternalAudit", "@emitTanstack": false } }',
      '{ "field.string": { "name": "email", "@maxLength": 120 } }',
      "```",
    ].join("\n"),
  },
  // ── What is still skipped, and stays visible ────────────────────────────────────
  //
  // A block that never becomes a loadable model must stay quiet (exit 0 — see the note on
  // `printSkipReport` for why a skip count is not turned into a failure) but must be
  // COUNTED and CLASSIFIED in the report. Each case pins one SkipReason so a future edit
  // that misclassifies, or silently drops the report, fails a test instead of shipping
  // unnoticed — the same failure mode this gate exists to close, one level up.
  {
    name: "a genuine syntax error is quiet but counted as unparseable",
    shouldFail: false,
    mustContain: "1 unparseable",
    markdown: [
      "```json",
      '{ "field.string": { "name": "email", } }',
      "```",
    ].join("\n"),
  },
  {
    name: "non-metadata JSON is quiet but counted as not-node-shape",
    shouldFail: false,
    mustContain: "1 not shaped like one metaobjects node",
    markdown: ['```json', '{ "outDir": "src/generated", "dialect": "sqlite" }', "```"].join("\n"),
  },
];

let failures = 0;

for (const testCase of CASES) {
  const dir = mkdtempSync(join(tmpdir(), "doc-example-gate-"));
  try {
    writeFileSync(join(dir, "example.md"), testCase.markdown, "utf8");

    const proc = Bun.spawnSync(
      ["bun", CHECKER, dir, ...(testCase.extraRoots ?? [])],
      { stdout: "pipe", stderr: "pipe" },
    );
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
    if (testCase.mustContain !== undefined && !output.includes(testCase.mustContain)) {
      failures++;
      console.error(
        `✗ ${testCase.name}\n    output missing "${testCase.mustContain}"\n` +
        `${output.replace(/^/gm, "    ")}`);
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

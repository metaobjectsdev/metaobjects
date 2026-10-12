#!/usr/bin/env node
// Tests for scripts/build-assess-prompt.mjs — the one-file hosted form of the fit-assessment skill.
//
// The real-tree cases pin what a reader of https://metaobjects.dev/assess.md must still get
// after the skill moved its capability sheet and JSON contract into references/. The synthetic
// cases pin the three ways the build can quietly lose content.
//
//   node scripts/test-build-assess-prompt.mjs

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildAssessPrompt } from "./build-assess-prompt.mjs";

let fails = 0;
const ok = (m) => console.log(`ok:   ${m}`);
const bad = (m) => { console.error(`FAIL: ${m}`); fails++; };
const check = (name, cond) => (cond ? ok(name) : bad(name));

const real = buildAssessPrompt();
check("hosted form starts at the top-level heading", real.startsWith("# MetaObjects Fit & Migration Assessment"));
check("no front-matter survives", !/^name: metaobjects-fit-assessment/m.test(real) && !real.includes("scaffold: false"));
check("no marker or skill-only comment survives", !real.includes("<!--"));
check("no pointer to a file the hosted reader cannot open", !real.includes("references/"));
check("the capability sheet is inlined under its heading", /## Capability sheet[^\n]*\n\nPaths are relative to the MetaObjects repository/.test(real));
check("the JSON contract is inlined under its heading", /## JSON contract[^\n]*\n\n```jsonc\n\{\n  "assessed_project"/.test(real));
check("the final self-check follows them", real.indexOf("## Final self-check") > real.indexOf("## Capability sheet"));
check("the hosted form is the whole prompt, not the 500-line skill body", real.split("\n").length > 550);

function skill(files) {
  const root = mkdtempSync(join(tmpdir(), "assess-prompt-"));
  mkdirSync(join(root, "references"), { recursive: true });
  for (const [path, text] of Object.entries(files)) writeFileSync(join(root, path), text);
  return root;
}
function expectThrow(name, files, needle) {
  const root = skill(files);
  try {
    buildAssessPrompt(root);
    bad(`${name}: expected a throw`);
  } catch (e) {
    check(name, String(e.message).includes(needle));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const head = "---\nname: x\n---\n\n# Title\n\n";
expectThrow("a reference file nothing inlines is an error", {
  "SKILL.md": `${head}Body.\n`,
  "references/orphan.md": "# Orphan\n\ntext\n",
}, "not inlined");
expectThrow("a marker naming a missing file is an error", {
  "SKILL.md": `${head}See <!-- inline: references/gone.md -->\n`,
}, "references/gone.md");
expectThrow("an unclosed skill-form-only block is an error", {
  "SKILL.md": `${head}<!-- skill-form-only:start -->\nrow\n`,
}, "never closed");

const root = skill({
  "SKILL.md": `${head}<!-- skill-form-only:start -->\n| table |\n<!-- skill-form-only:end -->\n\n## Part\n\n<!-- inline: references/part.md -->\n\nEnd.\n`,
  "references/part.md": "# Part\n\n## Contents\n- one\n- two\n\nBody line.\n",
});
check(
  "a marker line becomes the file's body, minus its title and Contents list",
  buildAssessPrompt(root) === "# Title\n\n## Part\n\nBody line.\n\nEnd.\n",
);
rmSync(root, { recursive: true, force: true });

if (fails > 0) {
  console.error(`\n${fails} failure(s)`);
  process.exit(1);
}
console.log("\nall passed");

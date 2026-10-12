#!/usr/bin/env node
// Builds the hosted fit-assessment prompt (https://metaobjects.dev/assess.md) as ONE file.
//
// The skill at agent-context/skills/metaobjects-fit-assessment/ keeps its body under 500
// lines by moving the capability sheet and the JSON contract into references/. A reader who
// fetches the hosted prompt has no skill directory to open them from, so the hosted form is
// the skill with those files inlined. This script is the only thing that writes it; the site
// deploy runs it instead of copying SKILL.md.
//
//   node scripts/build-assess-prompt.mjs [--out FILE]      (stdout when --out is absent)
//
// Rules, all enforced here rather than trusted:
//   - front-matter is dropped, and so is everything above the first top-level heading;
//   - lines between <!-- skill-form-only:start --> and <!-- skill-form-only:end --> are
//     dropped (the reference table means nothing once the files are inlined);
//   - a line carrying <!-- inline: references/<file>.md --> is replaced by that file's body,
//     minus its top-level title and its "## Contents" list;
//   - every references/*.md file must be inlined exactly once, so a file added to the skill
//     cannot silently go missing from the hosted form.

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_FORM_ONLY_START = "<!-- skill-form-only:start -->";
const SKILL_FORM_ONLY_END = "<!-- skill-form-only:end -->";
const INLINE_MARKER = /<!-- inline: (references\/[A-Za-z0-9._-]+\.md) -->/;

export const DEFAULT_SKILL_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "agent-context",
  "skills",
  "metaobjects-fit-assessment",
);

/** A reference file's body: without its `# Title` line and its `## Contents` list. */
function referenceBody(text) {
  const lines = text.split("\n");
  let i = 0;
  if (lines[i]?.startsWith("# ")) i++;
  while (i < lines.length && lines[i].trim() === "") i++;
  if (lines[i]?.trim() === "## Contents") {
    i++;
    while (i < lines.length && lines[i].trim() !== "") i++;
    while (i < lines.length && lines[i].trim() === "") i++;
  }
  return lines.slice(i).join("\n").replace(/\n+$/, "");
}

export function buildAssessPrompt(skillDir = DEFAULT_SKILL_DIR) {
  let lines = readFileSync(join(skillDir, "SKILL.md"), "utf8").split("\n");

  if (lines[0] === "---") {
    const close = lines.indexOf("---", 1);
    if (close < 0) throw new Error("SKILL.md: front-matter is not closed");
    lines = lines.slice(close + 1);
  }

  const kept = [];
  let skipping = false;
  let afterBlock = false;
  for (const line of lines) {
    // The blank line after a dropped block would sit next to the one before it.
    if (afterBlock && line.trim() === "") {
      afterBlock = false;
      continue;
    }
    afterBlock = false;
    if (line.trim() === SKILL_FORM_ONLY_START) {
      if (skipping) throw new Error(`SKILL.md: nested ${SKILL_FORM_ONLY_START}`);
      skipping = true;
    } else if (line.trim() === SKILL_FORM_ONLY_END) {
      if (!skipping) throw new Error(`SKILL.md: ${SKILL_FORM_ONLY_END} with no start`);
      skipping = false;
      afterBlock = true;
    } else if (!skipping) {
      kept.push(line);
    }
  }
  if (skipping) throw new Error(`SKILL.md: ${SKILL_FORM_ONLY_START} is never closed`);

  const firstHeading = kept.findIndex((l) => l.startsWith("# "));
  if (firstHeading < 0) throw new Error("SKILL.md: no top-level heading");

  const refDir = join(skillDir, "references");
  const unused = new Set(
    existsSync(refDir) ? readdirSync(refDir).filter((f) => f.endsWith(".md")).map((f) => `references/${f}`) : [],
  );

  const out = [];
  for (const line of kept.slice(firstHeading)) {
    const m = INLINE_MARKER.exec(line);
    if (m === null) {
      out.push(line);
      continue;
    }
    const rel = m[1];
    if (!unused.has(rel)) {
      throw new Error(`SKILL.md inlines ${rel}, which is missing or already inlined`);
    }
    unused.delete(rel);
    out.push(referenceBody(readFileSync(join(skillDir, rel), "utf8")));
  }

  if (unused.size > 0) {
    throw new Error(`not inlined into the hosted prompt: ${[...unused].sort().join(", ")}`);
  }
  return out.join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const outIdx = process.argv.indexOf("--out");
  const text = buildAssessPrompt();
  if (outIdx >= 0 && process.argv[outIdx + 1]) writeFileSync(process.argv[outIdx + 1], text);
  else process.stdout.write(text);
}

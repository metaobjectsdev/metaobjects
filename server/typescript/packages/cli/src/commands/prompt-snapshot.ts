// `meta prompt-snapshot` — deterministic rendered-prompt goldens (FR-004 #4).
//
// For each template.* node with a committed fixture payload, render its @textRef
// text against that payload (same engine, provider, and @format escaping prod
// uses) and snapshot the byte-exact output under .metaobjects/snapshots/<name>/.
// Write mode (default) overwrites output.snap; --check (a later task) diffs and
// fails on drift. Closes the gap the template's own git history misses: a shared
// partial or payload-shape change that silently alters the rendered prompt.

import { join } from "node:path";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { parsePromptSnapshotArgs } from "../lib/args.js";
import { log } from "../lib/log.js";
import { FileProvider } from "../lib/file-provider.js";
import { snapshotPaths } from "../lib/snapshot.js";
import { loadMemory } from "@metaobjectsdev/sdk";
import { TYPE_TEMPLATE, TEMPLATE_ATTR_TEXT_REF, TEMPLATE_ATTR_FORMAT } from "@metaobjectsdev/metadata";
import { render, type RenderFormat } from "@metaobjectsdev/render";

const DEFAULT_PROMPTS_DIR = "prompts";

export async function promptSnapshotCommand(args: string[], cwd: string): Promise<number> {
  let flags;
  try {
    flags = parsePromptSnapshotArgs(args);
  } catch (err) {
    log.error((err as Error).message);
    return 2;
  }

  let root;
  try {
    root = await loadMemory(cwd);
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes("ENOENT") || msg.includes("no such") || msg.includes("cannot read")) {
      log.error(`no metaobjects/ found in ${cwd}; run 'meta init' to scaffold`);
      return 2;
    }
    log.error(`failed to load metadata: ${msg}`);
    return 1;
  }

  const promptsDir = join(cwd, flags.prompts ?? DEFAULT_PROMPTS_DIR);
  const provider = new FileProvider(promptsDir);

  const templates = root.ownChildren().filter((c) => c.type === TYPE_TEMPLATE);
  if (templates.length === 0) {
    log.info("meta prompt-snapshot — no template.* nodes found; nothing to snapshot.");
    return 0;
  }

  let errorCount = 0;
  let wrote = 0;
  let skipped = 0;

  for (const tmpl of templates) {
    const textRef = tmpl.ownAttr(TEMPLATE_ATTR_TEXT_REF);
    // Absent/typeless required attrs are a loader-schema concern, not ours.
    if (typeof textRef !== "string") continue;

    const { dir, payloadPath, snapPath } = snapshotPaths(cwd, tmpl.name);
    if (!existsSync(payloadPath)) {
      log.info(`[${tmpl.name}] skipped — no payload at ${payloadPath}`);
      skipped++;
      continue;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(readFileSync(payloadPath, "utf8"));
    } catch (err) {
      log.error(`[${tmpl.name}] invalid payload.json: ${(err as Error).message}`);
      errorCount++;
      continue;
    }

    const fmtAttr = tmpl.ownAttr(TEMPLATE_ATTR_FORMAT);
    const format = typeof fmtAttr === "string" ? (fmtAttr as RenderFormat) : undefined;

    let rendered: string;
    try {
      rendered = render({ ref: textRef, payload, provider, ...(format ? { format } : {}) });
    } catch (err) {
      log.error(`[${tmpl.name}] render failed: ${(err as Error).message}`);
      errorCount++;
      continue;
    }

    mkdirSync(dir, { recursive: true });
    writeFileSync(snapPath, rendered, "utf8");
    log.info(`[${tmpl.name}] wrote ${snapPath}`);
    wrote++;
  }

  if (errorCount > 0) {
    log.error(`meta prompt-snapshot — ${errorCount} error(s); ${wrote} snapshot(s) written.`);
    return 1;
  }
  log.info(
    `meta prompt-snapshot — ${wrote} snapshot(s) written${skipped > 0 ? `, ${skipped} skipped` : ""}.`,
  );
  return 0;
}

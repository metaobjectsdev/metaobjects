// `meta prompt-snapshot` — deterministic rendered-prompt goldens (FR-004 #4).
//
// For each template.* node with a committed fixture payload, render its @textRef
// text against that payload (same engine, provider, and @format escaping prod
// uses) and snapshot the byte-exact output under .metaobjects/snapshots/<name>/.
// Write mode (default) overwrites output.snap; --check compares against the
// committed golden and exits 1 on drift (never writes). Closes the gap the
// template's own git history misses: a shared partial or payload-shape change
// that silently alters the rendered prompt.

import { join } from "node:path";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { parsePromptSnapshotArgs } from "../lib/args.js";
import { log } from "../lib/log.js";
import { FileProvider } from "../lib/file-provider.js";
import { snapshotPaths, unifiedDiff } from "../lib/snapshot.js";
import { loadMetaobjectsConfig } from "../lib/load-metaobjects-config.js";
import { loadMemory } from "@metaobjectsdev/sdk";
import { TYPE_TEMPLATE, TEMPLATE_ATTR_TEXT_REF, TEMPLATE_ATTR_FORMAT } from "@metaobjectsdev/metadata";
import { render, ESCAPERS, type RenderFormat } from "@metaobjectsdev/render";

const DEFAULT_PROMPTS_DIR = "prompts";

export async function promptSnapshotCommand(args: string[], cwd: string): Promise<number> {
  let flags;
  try {
    flags = parsePromptSnapshotArgs(args);
  } catch (err) {
    log.error((err as Error).message);
    return 2;
  }

  // Best-effort load of metaobjects.config.ts to pick up consumer-supplied
  // providers. prompt-snapshot doesn't require codegen config; if it's absent
  // or invalid, fall back to defaults — the loader still works for any
  // metadata that only uses core+forge subtypes.
  let configProviders: NonNullable<Awaited<ReturnType<typeof loadMetaobjectsConfig>>["providers"]> | undefined;
  try {
    const forgeConfig = await loadMetaobjectsConfig(cwd);
    configProviders = forgeConfig.providers;
  } catch {
    configProviders = undefined;
  }

  let root;
  try {
    root = await loadMemory(cwd, {
      ...(configProviders !== undefined ? { providers: configProviders } : {}),
    });
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
  let driftCount = 0;
  let wrote = 0;
  let checked = 0;
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

    // @format is loader-validated against the template format vocabulary; narrow
    // against the render engine's own escaper registry so the RenderFormat cast is
    // a checked narrowing (never a TypeError on an unknown format), and omit the
    // key entirely when absent (exactOptionalPropertyTypes forbids `format: undefined`).
    const fmtAttr = tmpl.ownAttr(TEMPLATE_ATTR_FORMAT);
    const format =
      typeof fmtAttr === "string" && fmtAttr in ESCAPERS ? (fmtAttr as RenderFormat) : undefined;

    let rendered: string;
    try {
      rendered = render({ ref: textRef, payload, provider, ...(format ? { format } : {}) });
    } catch (err) {
      log.error(`[${tmpl.name}] render failed: ${(err as Error).message}`);
      errorCount++;
      continue;
    }

    if (flags.check) {
      checked++;
      if (!existsSync(snapPath)) {
        log.error(
          `[${tmpl.name}] no committed snapshot at ${snapPath}; run 'meta prompt-snapshot' to create it`,
        );
        driftCount++;
        continue;
      }
      const golden = readFileSync(snapPath, "utf8");
      if (golden !== rendered) {
        log.error(`[${tmpl.name}] snapshot drift:\n${unifiedDiff(golden, rendered)}`);
        log.error(`[${tmpl.name}] run 'meta prompt-snapshot' to accept the change`);
        driftCount++;
      }
    } else {
      mkdirSync(dir, { recursive: true });
      writeFileSync(snapPath, rendered, "utf8");
      log.info(`[${tmpl.name}] wrote ${snapPath}`);
      wrote++;
    }
  }

  if (flags.check) {
    if (errorCount > 0 || driftCount > 0) {
      log.error(
        `meta prompt-snapshot --check — ${driftCount} drifted, ${errorCount} error(s) across ${checked} checked.`,
      );
      return 1;
    }
    log.info(
      `meta prompt-snapshot --check — ${checked} snapshot(s) clean${skipped > 0 ? `, ${skipped} skipped` : ""}.`,
    );
    return 0;
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

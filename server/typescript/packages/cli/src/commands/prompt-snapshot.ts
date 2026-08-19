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
import { loadMemory, resolveCollection } from "@metaobjectsdev/sdk";
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

  // Where the metadata lives is `resolveCollection`'s decision, not this
  // command's — `--check` is a drift GATE, so a project declaring `sources`
  // elsewhere would otherwise gate against a stale `metaobjects/` (or report
  // "no metaobjects/ found" for metadata it can see perfectly well). Discovery
  // and load stay separate failure modes, the `meta gen` pattern: a broad catch
  // around both reports a genuine ParseError as "no metadata found".
  // `resolveCollection` raises ERR_COLLECTION_NOT_FOUND with its own message,
  // replacing the hand-rolled ENOENT sniff that used to live here.
  let collection;
  try {
    collection = await resolveCollection(cwd);
  } catch (err) {
    log.error((err as Error).message);
    return 2;
  }

  // Everything project-relative below hangs off the DECLARING directory, not
  // ambient cwd: `.metaobjects/snapshots/` is that config's own state, and the
  // prompt text belongs to the same project as the metadata that references it.
  // Identical to cwd for a run from the project root, which is the only
  // invocation that worked before metadata sources were resolvable at all.
  const projectRoot = collection.configDir;

  // Best-effort load of metaobjects.config.ts to pick up consumer-supplied
  // providers. prompt-snapshot doesn't require codegen config; if it's absent
  // or invalid, fall back to defaults — the loader still works for any
  // metadata that only uses core+forge subtypes.
  let configProviders: NonNullable<Awaited<ReturnType<typeof loadMetaobjectsConfig>>["providers"]> | undefined;
  try {
    const forgeConfig = await loadMetaobjectsConfig(projectRoot);
    configProviders = forgeConfig.providers;
  } catch {
    configProviders = undefined;
  }

  let root;
  try {
    root = await loadMemory(collection.configDir, {
      files: collection.files,
      ...(configProviders !== undefined ? { providers: configProviders } : {}),
    });
  } catch (err) {
    log.error(`failed to load metadata: ${(err as Error).message}`);
    return 1;
  }

  const promptsDir = join(projectRoot, flags.prompts ?? DEFAULT_PROMPTS_DIR);
  const provider = new FileProvider(promptsDir);

  // ADR-0039: effective children — resolve rather than rely on root being unextended.
  const templates = root.children().filter((c) => c.type === TYPE_TEMPLATE);
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
    // ADR-0039: effective attr — @textRef may be inherited via an abstract template.
    const textRef = tmpl.attr(TEMPLATE_ATTR_TEXT_REF);
    // Absent/typeless required attrs are a loader-schema concern, not ours.
    if (typeof textRef !== "string") continue;

    const { dir, payloadPath, snapPath } = snapshotPaths(projectRoot, tmpl.name);
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
    // ADR-0039: effective attr — @format may be inherited via an abstract template.
    const fmtAttr = tmpl.attr(TEMPLATE_ATTR_FORMAT);
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

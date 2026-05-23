// `meta verify` — the build-time drift gate (FR-004 Plan #3, T6).
//
// Loads metadata + a filesystem provider; for each template.* node resolves its
// @textRef text, derives its @payloadRef view-object field tree, and runs the
// render engine's `verify` (template variable ↔ payload field drift). Exits
// non-zero on any drift error so CI fails loud — the "a renamed field can't
// silently break a prompt" guarantee, enforced at the last fixed point before
// the text ships. Required-slot misses are warnings (don't fail the build).

import { join } from "node:path";
import { parseVerifyArgs } from "../lib/args.js";
import { log } from "../lib/log.js";
import { FileProvider } from "../lib/file-provider.js";
import { derivePayloadFieldTree } from "../lib/payload-field-tree.js";
import { loadMemory } from "@metaobjectsdev/sdk";
import {
  TYPE_TEMPLATE,
  TEMPLATE_ATTR_PAYLOAD_REF,
  TEMPLATE_ATTR_TEXT_REF,
  TEMPLATE_ATTR_REQUIRED_SLOTS,
} from "@metaobjectsdev/metadata";
import { verify, ERR_REQUIRED_SLOT_UNUSED, ERR_PARTIAL_UNRESOLVED } from "@metaobjectsdev/render";

const DEFAULT_PROMPTS_DIR = "prompts";

export async function verifyCommand(args: string[], cwd: string): Promise<number> {
  let flags;
  try {
    flags = parseVerifyArgs(args);
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
    log.info("meta verify — no template.* nodes found; nothing to check.");
    return 0;
  }

  let errorCount = 0;
  let warnCount = 0;
  let checked = 0;

  for (const tmpl of templates) {
    const textRef = tmpl.ownAttr(TEMPLATE_ATTR_TEXT_REF);
    const payloadRef = tmpl.ownAttr(TEMPLATE_ATTR_PAYLOAD_REF);
    // Absent/typeless required attrs are a loader-schema concern, not verify's.
    if (typeof textRef !== "string" || typeof payloadRef !== "string") continue;

    const text = provider.resolve(textRef);
    if (text === undefined) {
      log.error(
        `[${tmpl.name}] ${ERR_PARTIAL_UNRESOLVED}: @textRef "${textRef}" did not resolve under ${promptsDir}`,
      );
      errorCount++;
      continue;
    }

    const fieldTree = derivePayloadFieldTree(root, payloadRef);
    const slotsAttr = tmpl.ownAttr(TEMPLATE_ATTR_REQUIRED_SLOTS);
    const requiredSlots = Array.isArray(slotsAttr)
      ? slotsAttr.filter((s): s is string => typeof s === "string")
      : typeof slotsAttr === "string"
        ? [slotsAttr]
        : [];

    const drift = verify(text, fieldTree, { provider, requiredSlots });
    checked++;
    for (const e of drift) {
      if (e.code === ERR_REQUIRED_SLOT_UNUSED) {
        log.warn(`[${tmpl.name}] ${e.code}: ${e.path}`);
        warnCount++;
      } else {
        log.error(`[${tmpl.name}] ${e.code}: ${e.path}`);
        errorCount++;
      }
    }
  }

  if (errorCount > 0) {
    log.error(
      `meta verify — ${errorCount} drift error(s) across ${templates.length} template(s).`,
    );
    return 1;
  }
  log.info(
    `meta verify — ${checked} template(s) clean${warnCount > 0 ? ` (${warnCount} warning(s))` : ""}.`,
  );
  return 0;
}

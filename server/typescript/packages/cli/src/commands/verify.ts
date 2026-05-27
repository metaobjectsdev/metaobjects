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
import { loadMetaobjectsConfig } from "../lib/load-metaobjects-config.js";
import { loadMemory } from "@metaobjectsdev/sdk";
import {
  TYPE_TEMPLATE,
  TEMPLATE_SUBTYPE_PROMPT,
  TEMPLATE_SUBTYPE_OUTPUT,
  TEMPLATE_ATTR_PAYLOAD_REF,
  TEMPLATE_ATTR_TEXT_REF,
  TEMPLATE_ATTR_REQUIRED_SLOTS,
  TEMPLATE_ATTR_REQUIRED_TAGS,
} from "@metaobjectsdev/metadata";
import { verify, ERR_REQUIRED_SLOT_UNUSED, ERR_PARTIAL_UNRESOLVED } from "@metaobjectsdev/render";

const DEFAULT_PROMPTS_DIR = "prompts";

/** Coerce a string-array attr (array, or a single string) into a string[]. */
function attrAsStringArray(attr: unknown): string[] {
  if (Array.isArray(attr)) return attr.filter((s): s is string => typeof s === "string");
  if (typeof attr === "string") return [attr];
  return [];
}

export async function verifyCommand(args: string[], cwd: string): Promise<number> {
  let flags;
  try {
    flags = parseVerifyArgs(args);
  } catch (err) {
    log.error((err as Error).message);
    return 2;
  }

  // Best-effort load of metaobjects.config.ts to pick up consumer-supplied
  // providers (e.g. a project's `template.toolcall` subtype). verify doesn't
  // require codegen config; if it's absent or invalid, fall back to defaults
  // — the loader will surface a stable ERR_UNKNOWN_SUBTYPE if the metadata
  // actually uses a non-default subtype.
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

    // Both subtypes verify that @payloadRef resolves to a loaded object.value.
    // The render-engine `verify()` would also throw on missing refs, but the
    // output branch doesn't call it — explicit check keeps the error symmetric.
    const fieldTree = derivePayloadFieldTree(root, payloadRef);
    if (fieldTree.length === 0) {
      log.error(
        `[${tmpl.name}] (${tmpl.subType}) ${ERR_PARTIAL_UNRESOLVED}: ` +
          `@payloadRef "${payloadRef}" did not resolve to a loaded object.value`,
      );
      errorCount++;
      continue;
    }

    if (tmpl.subType === TEMPLATE_SUBTYPE_PROMPT) {
      // Render-engine drift check: template variables ↔ payload field names.
      const text = provider.resolve(textRef);
      if (text === undefined) {
        log.error(
          `[${tmpl.name}] (prompt) ${ERR_PARTIAL_UNRESOLVED}: @textRef "${textRef}" did not resolve under ${promptsDir}`,
        );
        errorCount++;
        continue;
      }

      const requiredSlots = attrAsStringArray(tmpl.ownAttr(TEMPLATE_ATTR_REQUIRED_SLOTS));
      const requiredTags = attrAsStringArray(tmpl.ownAttr(TEMPLATE_ATTR_REQUIRED_TAGS));

      const drift = verify(text, fieldTree, { provider, requiredSlots, requiredTags });
      checked++;
      for (const e of drift) {
        if (e.code === ERR_REQUIRED_SLOT_UNUSED) {
          log.warn(`[${tmpl.name}] (prompt) ${e.code}: ${e.path}`);
          warnCount++;
        } else {
          log.error(`[${tmpl.name}] (prompt) ${e.code}: ${e.path}`);
          errorCount++;
        }
      }
    } else if (tmpl.subType === TEMPLATE_SUBTYPE_OUTPUT) {
      // Output drift check: re-derive the payload field tree (already done above);
      // if it resolved, the parser codegen can produce a schema. Field-type
      // unsupported-by-Zod issues are caught by the codegen itself if/when
      // `meta gen` runs; verify confines itself to ref-resolution checks.
      checked++;
    } else {
      // Unknown subtype — ignore (loader-schema concern).
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

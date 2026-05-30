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
import { buildKyselyFromUrl, type Dialect } from "../lib/kysely.js";
import { tokensToAllowOptions, describeChange } from "../lib/allow.js";
import { computeDrift, type Change } from "@metaobjectsdev/migrate-ts";
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
  let flags: ReturnType<typeof parseVerifyArgs>;
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

  let root: Awaited<ReturnType<typeof loadMemory>>;
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

  // Exit-code composition: the overall result is max(templateExit, schemaExit)
  // so either kind of drift fails CI. The schema path only runs when --db is
  // present (and not --skip-schema); with no --db it is skipped entirely and
  // the exit reflects the template path alone (unchanged behavior).
  const templateExit = runTemplateVerify();
  const schemaExit = await runSchemaVerify();
  return Math.max(templateExit, schemaExit);

  // -- template (prompt / output) drift --------------------------------------
  function runTemplateVerify(): number {
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

  // -- schema drift (live DB) ------------------------------------------------
  // Gated on --db. With no --db (or --skip-schema), this is a no-op returning 0
  // — the DB-free default behavior is unchanged.
  async function runSchemaVerify(): Promise<number> {
    if (flags.db === undefined || flags.skipSchema) return 0;

    // d1 has no Kysely-driver introspection path, so the schema-drift gate
    // can't support it. `buildKyselyFromUrl` already throws for the d1 dialect
    // ("does not use a URL connection") — the catch below surfaces that as a
    // clear exit 1, so no separate d1 guard is needed here.
    let kysely;
    try {
      kysely = await buildKyselyFromUrl(flags.db, flags.dialect as Dialect | undefined);
    } catch (err) {
      log.error(`verify: ${(err as Error).message}`);
      return 1;
    }

    try {
      const allow = tokensToAllowOptions(flags.allow);
      let driftResult;
      try {
        driftResult = await computeDrift(kysely.db, kysely.dialect, root, { allow });
      } catch (err) {
        log.error(`verify: failed to introspect ${kysely.displayUrl}: ${(err as Error).message}`);
        return 1;
      }

      // TODO(Unit 3 — migration-history ledger): when the ledger table exists,
      // a migration that is recorded-as-pending-but-unapplied must also count as
      // drift here. Until Unit 3 ships the ledger, this MUST no-op — do not query
      // a table that doesn't exist. `reconcileLedger` returns no extra drift today.
      const ledgerDrift = await reconcileLedger();

      const changes = driftResult.changes;
      if (changes.length === 0 && ledgerDrift.length === 0) {
        log.info(`meta verify — schema in sync with ${kysely.displayUrl}.`);
        return 0;
      }

      log.error(`meta verify — schema drift vs ${kysely.displayUrl} (${changes.length} change(s)):`);
      for (const line of summarizeDrift(changes)) log.error(`  ${line}`);
      for (const line of ledgerDrift) log.error(`  ${line}`);
      return 1;
    } finally {
      try {
        await kysely.close();
      } catch (err) {
        log.warn(`verify: failed to close DB cleanly: ${(err as Error).message}`);
      }
    }
  }
}

/**
 * Migration-history ledger reconciliation hook (Unit 3 — not yet built).
 *
 * When the ledger lands, this will read it and report any recorded-but-unapplied
 * migration as drift. Until then it is a deliberate no-op: returning an empty
 * array means "no ledger-derived drift", and crucially it does NOT touch any
 * ledger table (which doesn't exist yet) so a fresh DB never trips on it.
 */
async function reconcileLedger(): Promise<string[]> {
  return [];
}

// Per-kind glyph (+ add / - drop / ~ change) and noun for the drift summary.
// The detail string itself comes from the shared `describeChange`.
const DRIFT_PRESENTATION: Record<Change["kind"], { glyph: string; noun: string }> = {
  "create-table": { glyph: "+", noun: "table" },
  "drop-table": { glyph: "-", noun: "table" },
  "rename-table": { glyph: "~", noun: "table" },
  "add-column": { glyph: "+", noun: "column" },
  "drop-column": { glyph: "-", noun: "column" },
  "rename-column": { glyph: "~", noun: "column" },
  "change-column-type": { glyph: "~", noun: "column" },
  "change-column-nullable": { glyph: "~", noun: "column" },
  "change-column-default": { glyph: "~", noun: "column" },
  "add-index": { glyph: "+", noun: "index" },
  "drop-index": { glyph: "-", noun: "index" },
  "add-fk": { glyph: "+", noun: "fk" },
  "drop-fk": { glyph: "-", noun: "fk" },
  "create-view": { glyph: "+", noun: "view" },
  "replace-view": { glyph: "~", noun: "view" },
  "drop-view": { glyph: "-", noun: "view" },
};

/** Human-readable one-line-per-change drift summary (table/column/index/fk/view). */
function summarizeDrift(changes: Change[]): string[] {
  return changes.map((c) => {
    const p = DRIFT_PRESENTATION[c.kind];
    if (p === undefined) return JSON.stringify(c);
    return `${p.glyph} ${p.noun} ${describeChange(c)}`;
  });
}

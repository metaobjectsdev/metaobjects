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
import { warnIfAgentContextStale } from "../lib/agent-context-staleness.js";
import { scanSourceForAntiPatterns } from "../lib/anti-patterns.js";
import { FileProvider } from "../lib/file-provider.js";
import { derivePayloadFieldTree } from "../lib/payload-field-tree.js";
import { loadMetaobjectsConfig } from "../lib/load-metaobjects-config.js";
import { computeCodegenDrift } from "../lib/codegen-drift.js";
import type { MetaobjectsGenConfig } from "@metaobjectsdev/codegen-ts";
import { buildProjectionViews } from "@metaobjectsdev/codegen-ts";
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

// Loader error code (from @metaobjectsdev/metadata's ERROR_CODES) raised by the
// ADR-0023 strict-attr check for an undeclared/typo'd own @attr. Not individually
// exported by the package, so named here to avoid an inline literal at the use site.
const ERR_UNKNOWN_ATTR = "ERR_UNKNOWN_ATTR";

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

  // Advisory: nudge to refresh the .claude/skills docs if they predate this CLI.
  warnIfAgentContextStale(cwd);

  // ADR-0021 D2 — explicit verify subverbs. Each flag selects one drift mode;
  // any combination runs each and the overall exit code is the MAX (non-zero on
  // any drift). A bare `verify` (no explicit subverb) keeps its documented
  // back-compat default: the template/prompt drift gate — plus a one-line note
  // advertising the explicit subverbs.
  const runTemplates = flags.templates || !flags.anyExplicit;
  // The schema (--db) gate is selected by the presence of --db; that check lives
  // inside runSchemaVerify (where `flags.db === undefined` also narrows the type).
  const runCodegen = flags.codegen;
  if (!flags.anyExplicit) {
    log.info(
      "meta verify — running --templates (default). Explicit subverbs: " +
        "--templates (prompt drift), --db (schema drift), --codegen (codegen drift).",
    );
  }

  // Best-effort load of metaobjects.config.ts. Two consumers:
  //  1) consumer-supplied providers (e.g. a `template.toolcall` subtype) threaded
  //     into loadMemory — verify doesn't REQUIRE codegen config for templates/db;
  //  2) the full config object, which `--codegen` needs to locate outDir/targets.
  // If absent/invalid we fall back to defaults; `--codegen` then reports a clear
  // error (it can't diff without knowing where the committed output lives).
  let forgeConfig: MetaobjectsGenConfig | undefined;
  try {
    forgeConfig = await loadMetaobjectsConfig(cwd);
  } catch {
    forgeConfig = undefined;
  }
  const configProviders = forgeConfig?.providers;

  // ADR-0023 strict-by-default (#96): verify loads strict unless --lax is passed,
  // so an undeclared/typo'd own @attr fails verify (matching Java's Maven goal).
  let root: Awaited<ReturnType<typeof loadMemory>>;
  try {
    root = await loadMemory(cwd, {
      ...(configProviders !== undefined ? { providers: configProviders } : {}),
      strict: !flags.lax,
    });
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes("ENOENT") || msg.includes("no such") || msg.includes("cannot read")) {
      log.error(`no metaobjects/ found in ${cwd}; run 'meta init' to scaffold`);
      return 2;
    }
    log.error(`failed to load metadata: ${msg}`);
    // Strict-load rejection (ADR-0023): give the author the three exits — register
    // the attr on a provider, stash it in the `attr.properties` bag, or pass --lax.
    const code = (err as { code?: string }).code;
    if (code === ERR_UNKNOWN_ATTR || msg.includes("Unknown attribute")) {
      log.error(
        "meta verify is strict (ADR-0023): every authored @attr must be declared. " +
          "Fix: register the attr on a metadata provider, OR move arbitrary " +
          "author-supplied properties into an `attr.properties` bag, OR re-run " +
          "with `meta verify --lax` to keep the legacy open-attr load.",
      );
    }
    return 1;
  }

  const promptsDir = join(cwd, flags.prompts ?? DEFAULT_PROMPTS_DIR);
  const provider = new FileProvider(promptsDir);

  // Exit-code composition: the overall result is the MAX across every selected
  // subverb so ANY kind of drift fails CI. Each gate only runs when its mode is
  // selected; an unselected gate contributes 0.
  const templateExit = runTemplates ? runTemplateVerify() : 0;
  const schemaExit = await runSchemaVerify();
  const codegenExit = runCodegen ? await runCodegenVerify() : 0;

  // Advisory verify-as-teacher pass: surface hand-rolled work the metadata could
  // model. Warnings ONLY — never changes the exit code (bias to under-flagging).
  // Suppressed with --no-antipatterns or META_NO_ANTIPATTERNS=1 for the rare
  // noisy project (both opt-outs work on `meta verify` and `meta gen`).
  if (!flags.noAntipatterns && process.env.META_NO_ANTIPATTERNS !== "1") runAntiPatternAdvisory();

  return Math.max(templateExit, schemaExit, codegenExit);

  // -- verify-as-teacher (advisory) ------------------------------------------
  function runAntiPatternAdvisory(): void {
    let findings;
    try {
      findings = scanSourceForAntiPatterns(cwd);
    } catch {
      return; // never let an advisory scan break verify
    }
    if (findings.length === 0) return;
    const CAP = 10;
    log.warn(
      `meta verify — ${findings.length} place(s) hand-roll what MetaObjects can model ` +
        `(advisory — does not fail the build):`,
    );
    for (const f of findings.slice(0, CAP)) log.warn(`  ${f.message}`);
    if (findings.length > CAP) log.warn(`  …and ${findings.length - CAP} more.`);
  }

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
    // `flags.db === undefined` is exactly `!runDb`; written this way so TS
    // narrows flags.db to `string` for buildKyselyFromUrl below.
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
      // Expected views from the single view-SQL source (codegen-ts), so view-body
      // drift is detected against the live DB.
      const viewStrategy = forgeConfig?.columnNamingStrategy ?? "snake_case";
      const expectedViews = buildProjectionViews(root, { dialect: kysely.dialect, columnNamingStrategy: viewStrategy });
      let driftResult;
      try {
        driftResult = await computeDrift(kysely.db, kysely.dialect, root, { allow, views: expectedViews });
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

  // -- codegen drift (ADR-0021 D2) -------------------------------------------
  // Gated on --codegen. Regenerates to a temp dir and diffs against the
  // committed output (config outDir / per-target outDirs). Requires a config:
  // without one, there's no committed-output location to diff against, so it
  // errors clearly (exit 2 — a usage/configuration problem, not a drift result).
  async function runCodegenVerify(): Promise<number> {
    if (forgeConfig === undefined) {
      log.error(
        "verify --codegen: no metaobjects.config.ts found (or it is invalid) — " +
          "cannot locate the committed generated output to diff against. " +
          "Run 'meta init' to scaffold one, or run without --codegen.",
      );
      return 2;
    }

    let result;
    try {
      result = await computeCodegenDrift(forgeConfig, root, cwd);
    } catch (err) {
      log.error(`verify --codegen: regeneration failed: ${(err as Error).message}`);
      return 1;
    }

    if (result.error !== undefined) {
      log.error(result.error);
      return 2;
    }

    if (result.clean) {
      log.info("meta verify — generated output is in sync with the metadata (no codegen drift).");
      return 0;
    }

    log.error(
      `meta verify — codegen drift (${result.driftedFiles.length} file(s) differ from a fresh regen):`,
    );
    for (const line of result.lines) log.error(`  ${line}`);
    log.error("Run 'meta gen' to regenerate, then commit the result.");
    return 1;
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
  "add-check": { glyph: "+", noun: "check" },
  "drop-check": { glyph: "-", noun: "check" },
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

// `meta verify` — the build-time drift gate (FR-004 Plan #3, T6).
//
// Loads metadata + a filesystem provider; for each template.* node resolves its
// @textRef text, derives its @payloadRef view-object field tree, and runs the
// render engine's `verify` (template variable ↔ payload field drift). Exits
// non-zero on any drift error so CI fails loud — the "a renamed field can't
// silently break a prompt" guarantee, enforced at the last fixed point before
// the text ships. Required-slot misses are warnings (don't fail the build).

import { join, resolve as resolvePath } from "node:path";
import { parseVerifyArgs } from "../lib/args.js";
import { log } from "../lib/log.js";
import { warnIfAgentContextStale } from "../lib/agent-context-staleness.js";
import { scanSourceForAntiPatterns } from "../lib/anti-patterns.js";
import { FileProvider } from "../lib/file-provider.js";
import { derivePayloadFieldTree } from "../lib/payload-field-tree.js";
import { loadMetaobjectsConfig } from "../lib/load-metaobjects-config.js";
import { computeCodegenDrift } from "../lib/codegen-drift.js";
import { checkRequirements } from "../lib/requirement-check.js";
import { resolveD1Config } from "../lib/config.js";
import {
  buildWranglerExecuteArgs,
  defaultWranglerRunner,
  isWranglerLocalD1StatePath,
  type WranglerRunner,
} from "../lib/wrangler.js";
import type { MetaobjectsGenConfig } from "@metaobjectsdev/codegen-ts";
import { buildProjectionViews } from "@metaobjectsdev/codegen-ts";
import { buildKyselyFromUrl, type Dialect } from "../lib/kysely.js";
import { tokensToAllowOptions, describeChange } from "../lib/allow.js";
import {
  computeDrift,
  computeDriftFromActual,
  collectUnmanagedNames,
  introspectD1,
  findWranglerConfig,
  parseWranglerConfig,
  resolveD1Binding,
  type Change,
  type D1Binding,
  type D1Runner,
  type DiffResult,
} from "@metaobjectsdev/migrate-ts";
import { loadMemory } from "@metaobjectsdev/sdk";
import {
  TYPE_TEMPLATE,
  TEMPLATE_SUBTYPE_PROMPT,
  TEMPLATE_SUBTYPE_OUTPUT,
  TEMPLATE_ATTR_PAYLOAD_REF,
  TEMPLATE_ATTR_TEXT_REF,
  TEMPLATE_ATTR_REQUIRED_SLOTS,
  TEMPLATE_ATTR_REQUIRED_TAGS,
  TEMPLATE_ATTR_KIND,
  TEMPLATE_KIND_EMAIL,
  TEMPLATE_KIND_DEFAULT,
  TEMPLATE_ATTR_SUBJECT_REF,
  TEMPLATE_ATTR_HTML_BODY_REF,
  TEMPLATE_ATTR_TEXT_BODY_REF,
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

export async function verifyCommand(
  args: string[],
  cwd: string,
  /** Injectable wrangler runner (D1 path only) — tests pass a mock; production uses the default. */
  wranglerRunner?: WranglerRunner,
): Promise<number> {
  const activeWranglerRunner = wranglerRunner ?? defaultWranglerRunner;
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
  // The schema gate is selected by the presence of --db, or --dialect d1 (#225 —
  // D1 has no URL connection); that check lives inside runSchemaVerify.
  const runCodegen = flags.codegen;
  if (!flags.anyExplicit) {
    log.info(
      "meta verify — running --templates (default). Explicit subverbs: " +
        "--templates (prompt drift), --db/--dialect d1 (schema drift), --codegen (codegen drift).",
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
  // Requirements have no subverb: `requirement.*` nodes are metadata, so they
  // are checked on every `meta verify`. Opt-in by DECLARATION — a model with no
  // requirement nodes is silent, not in drift.
  const requirementExit = runRequirementVerify();

  // Advisory verify-as-teacher pass: surface hand-rolled work the metadata could
  // model. Warnings ONLY — never changes the exit code (bias to under-flagging).
  // Suppressed with --no-antipatterns or META_NO_ANTIPATTERNS=1 for the rare
  // noisy project (both opt-outs work on `meta verify` and `meta gen`).
  if (!flags.noAntipatterns && process.env.META_NO_ANTIPATTERNS !== "1") runAntiPatternAdvisory();

  return Math.max(templateExit, schemaExit, codegenExit, requirementExit);

  // -- requirements (#290) ---------------------------------------------------
  function runRequirementVerify(): number {
    const diags = checkRequirements(root);
    if (diags.length === 0) return 0;
    const errors = diags.filter((d) => d.severity === "error");
    const warns = diags.filter((d) => d.severity === "warn");
    const CAP = 20;
    for (const d of errors) log.error(`  ${d.code}${d.name !== undefined ? ` [${d.name}]` : ""}: ${d.message}`);
    for (const d of warns.slice(0, CAP)) {
      log.warn(`  ${d.code}${d.name !== undefined ? ` [${d.name}]` : ""}: ${d.message}`);
    }
    if (warns.length > CAP) log.warn(`  …and ${warns.length - CAP} more.`);
    if (errors.length > 0) {
      log.error(`meta verify — requirements: ${errors.length} error(s).`);
      return 1;
    }
    return 0;
  }

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
    // ADR-0039: effective children — resolve rather than rely on root being unextended.
    const templates = root.children().filter((c) => c.type === TYPE_TEMPLATE);
    if (templates.length === 0) {
      log.info("meta verify — no template.* nodes found; nothing to check.");
      return 0;
    }

    let errorCount = 0;
    let warnCount = 0;
    let checked = 0;

    for (const tmpl of templates) {
      // ADR-0039: effective attrs — @payloadRef may be inherited via an abstract template.
      const payloadRef = tmpl.attr(TEMPLATE_ATTR_PAYLOAD_REF);
      // A typeless/absent @payloadRef is a loader-schema concern, not verify's. Every
      // renderable template needs it (do NOT gate on @textRef — an @kind=email output
      // has no @textRef, and gating on it silently skipped email drift; #193).
      if (typeof payloadRef !== "string") continue;

      // @payloadRef must resolve to a loaded object.value (drives the field tree
      // every render-engine drift check runs against).
      const fieldTree = derivePayloadFieldTree(root, payloadRef, tmpl.package ?? tmpl.fileDefaultPackage ?? "");
      if (fieldTree.length === 0) {
        log.error(
          `[${tmpl.name}] (${tmpl.subType}) ${ERR_PARTIAL_UNRESOLVED}: ` +
            `@payloadRef "${payloadRef}" did not resolve to a loaded object.value`,
        );
        errorCount++;
        continue;
      }

      // Collect every renderable mustache ref for this template + whether the
      // prompt-only @requiredSlots/@requiredTags rules apply — mirroring the
      // gen-time render-helper drift gate so `verify` and `gen` agree (#193):
      //   template.prompt                    → the single @textRef (WITH required slots/tags).
      //   template.output document (default) → the @textRef body.
      //   template.output @kind=email        → @subjectRef + @htmlBodyRef + optional @textBodyRef.
      let refs: { label: string; ref: string }[] = [];
      let promptRules = false;
      if (tmpl.subType === TEMPLATE_SUBTYPE_PROMPT) {
        // ADR-0039: effective attrs — @textRef may be inherited via an abstract template.
        const textRef = tmpl.attr(TEMPLATE_ATTR_TEXT_REF);
        if (typeof textRef === "string") refs = [{ label: "prompt", ref: textRef }];
        promptRules = true;
      } else if (tmpl.subType === TEMPLATE_SUBTYPE_OUTPUT) {
        // ADR-0039: effective attrs — @kind / part refs may be inherited via an abstract template.
        const kind = ((tmpl.attr(TEMPLATE_ATTR_KIND) as string | undefined) ?? TEMPLATE_KIND_DEFAULT).toLowerCase();
        if (kind === TEMPLATE_KIND_EMAIL) {
          const subjectRef = tmpl.attr(TEMPLATE_ATTR_SUBJECT_REF);
          const htmlBodyRef = tmpl.attr(TEMPLATE_ATTR_HTML_BODY_REF);
          const textBodyRef = tmpl.attr(TEMPLATE_ATTR_TEXT_BODY_REF);
          if (typeof subjectRef === "string") refs.push({ label: "email/subject", ref: subjectRef });
          if (typeof htmlBodyRef === "string") refs.push({ label: "email/html", ref: htmlBodyRef });
          if (typeof textBodyRef === "string") refs.push({ label: "email/text", ref: textBodyRef });
        } else {
          const textRef = tmpl.attr(TEMPLATE_ATTR_TEXT_REF);
          if (typeof textRef === "string") refs = [{ label: "document", ref: textRef }];
        }
      } else {
        continue; // unknown subtype — loader-schema concern.
      }

      // No renderable body ref present — absent required refs are a loader-schema
      // concern, not verify's (mirrors the pre-#193 behavior for a bodyless template).
      if (refs.length === 0) continue;

      // Slot/tag requirements are a template.prompt concept; the render-helper's
      // email/document gate does NOT apply them per part (they would false-flag a
      // slot as unused in each part). So only the prompt path carries them.
      // ADR-0039: effective attrs — @requiredSlots/@requiredTags may be inherited.
      const requiredSlots = promptRules ? attrAsStringArray(tmpl.attr(TEMPLATE_ATTR_REQUIRED_SLOTS)) : [];
      const requiredTags = promptRules ? attrAsStringArray(tmpl.attr(TEMPLATE_ATTR_REQUIRED_TAGS)) : [];

      for (const { label, ref } of refs) {
        // Render-engine drift check: mustache variables ↔ payload field names.
        const text = provider.resolve(ref);
        if (text === undefined) {
          log.error(
            `[${tmpl.name}] (${label}) ${ERR_PARTIAL_UNRESOLVED}: ref "${ref}" did not resolve under ${promptsDir}`,
          );
          errorCount++;
          continue;
        }
        const drift = verify(text, fieldTree, { provider, requiredSlots, requiredTags });
        checked++;
        for (const e of drift) {
          if (e.code === ERR_REQUIRED_SLOT_UNUSED) {
            log.warn(`[${tmpl.name}] (${label}) ${e.code}: ${e.path}`);
            warnCount++;
          } else {
            log.error(`[${tmpl.name}] (${label}) ${e.code}: ${e.path}`);
            errorCount++;
          }
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

  // -- schema drift (live DB) ------------------------------------------------
  // Gated on --db OR --dialect d1 (D1 has no URL connection — see the `d1` field
  // doc on VerifyFlags). With neither (or --skip-schema), this is a no-op
  // returning 0 — the DB-free default behavior is unchanged.
  async function runSchemaVerify(): Promise<number> {
    const usingD1 = flags.dialect === "d1";
    if ((flags.db === undefined && !usingD1) || flags.skipSchema) return 0;

    if (usingD1 && flags.db !== undefined) {
      log.error(`verify: --db is not used for dialect 'd1' — wrangler.toml owns the connection; pass --d1 <binding> instead`);
      return 2;
    }

    // #225 — the reported footgun: `--db file:` pointed inside wrangler's LOCAL D1
    // state directory RUNS (it's an ordinary sqlite file) and reports "schema in
    // sync", but it verified the LOCAL shadow database, not the deployed one — a
    // false green on exactly the failure mode a D1 adopter most needs the gate to
    // catch. Warn only; never auto-redirect (the local file becoming a convenient
    // default is exactly the confusion this issue rejected).
    if (flags.db !== undefined && isWranglerLocalD1StatePath(flags.db)) {
      log.warn(
        `verify: --db '${flags.db}' points inside a wrangler local D1 state directory — this ` +
          `verifies the LOCAL database, not the deployed one. Use 'verify --dialect d1 --d1 <binding>' ` +
          `(add --remote to target the deployed database) to check the real D1 schema.`,
      );
    }

    // TODO(Unit 3 — migration-history ledger): when the ledger table exists,
    // a migration that is recorded-as-pending-but-unapplied must also count as
    // drift here. Until Unit 3 ships the ledger, this MUST no-op — do not query
    // a table that doesn't exist. `reconcileLedger` returns no extra drift today.
    const ledgerDrift = await reconcileLedger();

    if (usingD1) return await runD1SchemaVerify(ledgerDrift);

    // `flags.db` is guaranteed defined here: the only way to reach this point
    // with it undefined is `usingD1`, which just returned above.
    let kysely;
    try {
      kysely = await buildKyselyFromUrl(flags.db as string, flags.dialect as Dialect | undefined);
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

      return reportSchemaDrift(driftResult, ledgerDrift, kysely.displayUrl);
    } finally {
      try {
        await kysely.close();
      } catch (err) {
        log.warn(`verify: failed to close DB cleanly: ${(err as Error).message}`);
      }
    }
  }

  // -- schema drift (D1, via wrangler) ---------------------------------------
  // #225 — D1 has no client wire protocol, so it can't go through
  // buildKyselyFromUrl/computeDrift's Kysely-driver introspection path. Mirrors
  // `meta migrate`'s D1 wiring (migrate.ts's runD1Migrate): resolve the wrangler
  // binding, shell out via the SAME wrangler runner migrate uses, introspect with
  // introspectD1 (which already excludes wrangler/D1's own bookkeeping tables —
  // `_cf_METADATA`, `d1_migrations`, `sqlite_sequence` — so there is no second
  // exclusion mechanism to maintain), then feed the snapshot into
  // computeDriftFromActual and the SAME reportSchemaDrift the sqlite/postgres
  // path uses — no forked reporting/exit-code logic.
  async function runD1SchemaVerify(ledgerDrift: string[]): Promise<number> {
    const d1Config = await resolveD1Config({ d1Binding: flags.d1, remote: flags.remote }, cwd);

    const wranglerConfigPath = d1Config.wranglerConfigPath
      ? resolvePath(cwd, d1Config.wranglerConfigPath)
      : findWranglerConfig(cwd);

    if (wranglerConfigPath === undefined && d1Config.binding === undefined) {
      log.error(`verify: no wrangler.toml found in ${cwd} or parents; pass --d1 <binding> to bypass`);
      return 2;
    }

    let binding: D1Binding;
    if (wranglerConfigPath !== undefined) {
      const parsed = parseWranglerConfig(wranglerConfigPath);
      try {
        binding = resolveD1Binding(parsed.d1Bindings, d1Config.binding);
      } catch (err) {
        log.error(`verify: ${(err as Error).message}`);
        return 2;
      }
    } else {
      // No wrangler config but explicit binding — let wrangler discover the DB itself.
      binding = { binding: d1Config.binding as string, database_name: "", database_id: "", migrations_dir: undefined };
    }

    const remote = d1Config.remote;
    const d1Runner: D1Runner = async (sql) => {
      const wranglerArgs = buildWranglerExecuteArgs({
        binding: binding.binding,
        remote,
        command: sql,
        configPath: wranglerConfigPath,
      });
      const { stdout } = await activeWranglerRunner(wranglerArgs, cwd);
      return stdout;
    };

    let actual;
    try {
      actual = await introspectD1({ runner: d1Runner, binding: binding.binding, remote, configPath: wranglerConfigPath });
    } catch (err) {
      log.error(`verify: failed to introspect D1 binding '${binding.binding}': ${(err as Error).message}`);
      return 1;
    }

    const allow = tokensToAllowOptions(flags.allow);
    const viewStrategy = forgeConfig?.columnNamingStrategy ?? "snake_case";
    const expectedViews = buildProjectionViews(root, { dialect: "d1", columnNamingStrategy: viewStrategy });
    let driftResult;
    try {
      driftResult = await computeDriftFromActual(actual, "d1", root, { allow, views: expectedViews });
    } catch (err) {
      log.error(`verify: ${(err as Error).message}`);
      return 1;
    }

    const displayUrl = `d1:${binding.binding}${remote ? " (--remote)" : " (local)"}`;
    return reportSchemaDrift(driftResult, ledgerDrift, displayUrl);
  }

  // Shared drift-reporting + exit-code logic for BOTH schema-drift paths (sqlite/
  // postgres via computeDrift, D1 via computeDriftFromActual) — #225 requires the
  // D1 path to feed the SAME reporting, not a forked copy.
  function reportSchemaDrift(driftResult: DiffResult, ledgerDrift: string[], displayUrl: string): number {
    // #208 §8 — make declared-external objects visible: they are excluded from the
    // drift comparison (computeDrift/computeDriftFromActual thread them out), so
    // annotate them as external (declared) rather than let them vanish silently.
    const externalDeclared = collectUnmanagedNames(root);
    if (externalDeclared.length > 0) {
      log.info(
        `meta verify — ${externalDeclared.length} object(s) external (declared @unmanaged, managed elsewhere): ${externalDeclared.join(", ")}`,
      );
    }

    const changes = driftResult.changes;
    if (changes.length === 0 && ledgerDrift.length === 0) {
      log.info(`meta verify — schema in sync with ${displayUrl}.`);
      return 0;
    }

    log.error(`meta verify — schema drift vs ${displayUrl} (${changes.length} change(s)):`);
    for (const line of summarizeDrift(changes)) log.error(`  ${line}`);
    for (const line of ledgerDrift) log.error(`  ${line}`);
    return 1;
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

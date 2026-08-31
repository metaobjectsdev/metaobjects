// `meta verify` — the build-time drift gate (FR-004 Plan #3, T6).
//
// Loads metadata + a filesystem provider; for each template.* node resolves its
// @textRef text, derives its @payloadRef view-object field tree, and runs the
// render engine's `verify` (template variable ↔ payload field drift). Exits
// non-zero on any drift error so CI fails loud — the "a renamed field can't
// silently break a prompt" guarantee, enforced at the last fixed point before
// the text ships. Required-slot misses are warnings (don't fail the build).

import { join, resolve as resolvePath } from "node:path";
import { parseVerifyArgs, type MigrateFlags } from "../lib/args.js";
import { log } from "../lib/log.js";
import { warnIfAgentContextStale } from "../lib/agent-context-staleness.js";
import { warnIfManifestIgnored } from "../lib/manifest-ignored-check.js";
import { scanSourceForAntiPatterns } from "../lib/anti-patterns.js";
import { FileProvider } from "../lib/file-provider.js";
import { derivePayloadFieldTree } from "../lib/payload-field-tree.js";
import { loadMemoryOptionsFrom, loadMetaobjectsConfig, resolveGenCollection, resolveGenConfigDir } from "../lib/load-metaobjects-config.js";
import { computeCodegenDrift } from "../lib/codegen-drift.js";
import {
  checkRequirements, summariseRequirements, scanRequirements, type Diagnostic,
} from "../lib/requirement-check.js";
import { lintRequirements } from "../lib/requirement-lint.js";
import { resolveD1Config, resolveMigrateConfig } from "../lib/config.js";
import {
  buildWranglerExecuteArgs,
  defaultWranglerRunner,
  isWranglerLocalD1StatePath,
  type WranglerRunner,
} from "../lib/wrangler.js";
import type { MetaobjectsGenConfig } from "@metaobjectsdev/codegen-ts";
import { buildProjectionViews } from "@metaobjectsdev/codegen-ts";
import { buildKyselyFromUrl, inferDialect, type Dialect } from "../lib/kysely.js";
import { tokensToAllowOptions, describeChange } from "../lib/allow.js";
import {
  computeDrift,
  computeDriftFromActual,
  collectUnmanagedNames,
  excludeFromSnapshot,
  scopedDiffInputs,
  scopeExpectedSchema,
  buildExpectedSchemaWithProvenance,
  type GovernedScope,
  applyPending,
  type ApplyPendingResult,
  openReplayEngine,
  type ReplayEngine,
  verifyReplay,
  introspect,
  diff,
  readSnapshot,
  snapshotPath,
  type SchemaSnapshot,
  introspectD1,
  findWranglerConfig,
  parseWranglerConfig,
  resolveD1Binding,
  type Change,
  type D1Binding,
  type D1Runner,
  type DriftResult,
} from "@metaobjectsdev/migrate-ts";
import { loadMemory, resolveCollection } from "@metaobjectsdev/sdk";
import { migrateScopeMismatch, outOfScopeNote } from "../lib/migrate-scope.js";
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
  REQUIREMENT_STATUSES,
} from "@metaobjectsdev/metadata";
import { verify, ERR_REQUIRED_SLOT_UNUSED, ERR_PARTIAL_UNRESOLVED } from "@metaobjectsdev/render";

const DEFAULT_PROMPTS_DIR = "prompts";

// Loader error code (from @metaobjectsdev/metadata's ERROR_CODES) raised by the
// ADR-0023 strict-attr check for an undeclared/typo'd own @attr. Not individually
// exported by the package, so named here to avoid an inline literal at the use site.
const ERR_UNKNOWN_ATTR = "ERR_UNKNOWN_ATTR";

/**
 * A no-flags MigrateFlags, so `resolveMigrateConfig` yields exactly what `meta migrate`
 * would use with nothing passed on the command line — config value, else default.
 *
 * verify consumes `outDir` (#292) and — for the replay gate ONLY — `dialect`. The #292
 * restriction that reading anything else "would be reaching into migrate's decisions"
 * was written about the DRIFT gate, whose dialect comes from the live `--db` URL. The
 * replay gate has no `--db` at all, and the dialect a committed chain was EMITTED for
 * is a migrate decision by definition, so migrate's own resolution is the only correct
 * source for it. Everything else here exists to satisfy the shared shape.
 */
const EMPTY_MIGRATE_FLAGS = {
  db: undefined, dialect: undefined, format: undefined, outDir: undefined, slug: undefined,
  allow: [], onAmbiguous: undefined, dryRun: false, d1Binding: undefined, remote: false,
  apply: false, rollback: undefined, yes: false, fromDb: false, baseline: false,
  applyPending: false,
} as const satisfies MigrateFlags;

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
        "--templates (prompt drift), --db/--dialect d1 (schema drift), --codegen (codegen drift), " +
        "--replay/--replay-snapshot (the committed migration chain replays from empty).",
    );
  }

  // Where the metadata lives is `resolveCollection`'s decision, not a hardcoded
  // directory. It also carries the per-command `migrate.scope` the schema gate below
  // honours — `verify --db` and `migrate` govern the identical object set — and the
  // top-level `scope` `runCodegenVerify` (a nested function below) threads into
  // `computeCodegenDrift`. Explicitly typed (unlike the `let collection;` pattern
  // elsewhere in this codebase): a nested function body is OUTSIDE the control-flow
  // narrowing TS performs on a same-scope `let x;` reassignment, so a bare
  // `let collection;` type-checked clean until this task added exactly that nested
  // reference — the reader who removes the annotation next reintroduces TS7034.
  let collection: Awaited<ReturnType<typeof resolveCollection>>;
  try {
    collection = await resolveCollection(cwd);
  } catch (err) {
    log.error((err as Error).message);
    return 2;
  }

  // The project root is whichever directory `resolveCollection` decided the
  // metadata belongs to (design §4.6.1: "Per-port generator config is then read
  // from that same directory"). The line this draws, applied throughout this
  // command: anything named BY the metadata or by `.metaobjects/config.json`
  // resolves against `projectRoot` — that file's operational block, the migrations
  // `outDir` and `wranglerConfigPath` it carries, the `prompts/` a `@textRef`
  // resolves in. Identical paths for a run from the project root.
  //
  // The two advisory passes — the agent-context staleness nudge and the
  // anti-pattern scan — are rooted here too, matching `meta gen`. Both commands
  // describe them as the same pass, and scanning two different trees for it made
  // that false: a `verify` run from a subdirectory scanned only that subtree and
  // found no agent-context manifest at all, so the nudge silently never fired.
  const projectRoot = collection.configDir;

  // The one thing NOT named by the metadata or its config: `metaobjects.config.ts`
  // is this TypeScript package's own answer to a different question (design §4.6),
  // so it gets its own nearest-ancestor walk and everything IT names follows —
  // `outDir`/`targets` for `--codegen`. (It also carried `verify.testFiles` until
  // 0.24.0 retired the `@verifiedBy` scan; both are gone.) In a
  // Maven- or pip-rooted monorepo the collection is declared at the repo root while
  // the TS config sits in the app; reading the second from the first made
  // `--codegen` report "no config" for a package that has one (#326). Identical to
  // `projectRoot` whenever the two files sit together, which is every `meta init`
  // project.
  const genConfigDir = resolveGenConfigDir(cwd, collection.configDir);

  // Advisory: nudge to refresh the .claude/skills docs if they predate this CLI.
  warnIfAgentContextStale(projectRoot);
  // Advisory: the committed hash manifest is what makes hand-edit detection work on a
  // machine that did not generate the output. Silent unless it is ignored. Keyed on
  // projectRoot, not cwd, for the same reason its neighbour is — the manifest belongs to
  // whichever directory `resolveCollection` decided the metadata lives in.
  warnIfManifestIgnored(projectRoot);

  // Best-effort load of metaobjects.config.ts. Two consumers:
  //  1) consumer-supplied providers (e.g. a `template.toolcall` subtype) threaded
  //     into loadMemory — verify doesn't REQUIRE codegen config for templates/db;
  //  2) the full config object, which `--codegen` needs to locate outDir/targets.
  // If absent/invalid we fall back to defaults; `--codegen` then reports a clear
  // error (it can't diff without knowing where the committed output lives).
  let forgeConfig: MetaobjectsGenConfig | undefined;
  try {
    forgeConfig = await loadMetaobjectsConfig(genConfigDir);
  } catch {
    forgeConfig = undefined;
  }
  // Both of the gen config's contributions to the load, together — see
  // `loadMemoryOptionsFrom`. Threading `providers` and forgetting `libraries` is how
  // a shipped library became unloadable through the CLI (#333).
  const configLoadOptions = loadMemoryOptionsFrom(forgeConfig);

  // ADR-0023 strict-by-default (#96): verify loads strict unless --lax is passed,
  // so an undeclared/typo'd own @attr fails verify (matching Java's Maven goal).
  let root: Awaited<ReturnType<typeof loadMemory>>;
  try {
    root = await loadMemory(collection.configDir, {
      files: collection.files,
      ...configLoadOptions,
      strict: !flags.lax,
    });
  } catch (err) {
    const msg = (err as Error).message;
    log.error(`failed to load metadata: ${msg}`);
    // Strict-load rejection (ADR-0023). Two different failures reach here and they need
    // different advice:
    //
    //   a TYPO'd or genuinely undeclared attr — the three exits below are right;
    //   a RETIRED attr — the loader already knows the exits and attaches them as
    //   ADR-0009 `suggestions[]`, so we print those and say nothing of our own.
    //
    // The distinction is not cosmetic. The middle generic exit — the `attr.properties`
    // bag — is EXEMPT from the strict-attr check by subtype, so it loads. Offer it for a
    // retired attribute and the author gets a green `meta verify` over a value that now
    // reaches nothing: a correct, loud failure converted into a quiet, wrong pass. That is
    // strictly worse than the error it replaced.
    const code = (err as { code?: string }).code;
    const suggestions = (err as { suggestions?: string[] }).suggestions;
    if (suggestions !== undefined && suggestions.length > 0) {
      for (const s of suggestions) log.error(`  ${s}`);
    } else if (code === ERR_UNKNOWN_ATTR || msg.includes("Unknown attribute")) {
      log.error(
        "meta verify is strict (ADR-0023): every authored @attr must be declared. " +
          "Fix: register the attr on a metadata provider, OR move arbitrary " +
          "author-supplied properties into an `attr.properties` bag, OR re-run " +
          "with `meta verify --lax` to keep the legacy open-attr load.",
      );
    }
    return 1;
  }

  // The schema gate governs exactly the objects `meta migrate` governs — ONE
  // declaration (`migrate.scope`), not a second key: a drift gate that fails on
  // tables migrate deliberately does not own is incoherent. Undefined ⇒ everything
  // loaded, which is every project that declares no scope.
  const schemaScope = collection.inMigrateScope;

  const promptsDir = join(projectRoot, flags.prompts ?? DEFAULT_PROMPTS_DIR);
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
  // #313 — BOTH replay flags select this gate. `--replay-snapshot` implies
  // `--replay`'s work, so a broken chain must fail under it even when `--replay`
  // was not passed; naming only `flags.replay` here is how `--replay-snapshot`
  // would parse cleanly and do nothing at all.
  const replayExit = flags.replay || flags.replaySnapshot ? await runReplayVerify() : 0;

  // Advisory verify-as-teacher pass: surface hand-rolled work the metadata could
  // model. Warnings ONLY — never changes the exit code (bias to under-flagging).
  // Suppressed with --no-antipatterns or META_NO_ANTIPATTERNS=1 for the rare
  // noisy project (both opt-outs work on `meta verify` and `meta gen`).
  if (!flags.noAntipatterns && process.env.META_NO_ANTIPATTERNS !== "1") runAntiPatternAdvisory();

  return Math.max(templateExit, schemaExit, codegenExit, requirementExit, replayExit);

  // -- replay (#313) ---------------------------------------------------------
  /**
   * Replay the committed migration chain into an EMPTY throwaway database and assert
   * it applies. `--replay-snapshot` additionally asserts the result equals the
   * committed snapshot.
   *
   * This exists because `meta migrate` could write a chain that cannot be replayed —
   * a bare `DROP TABLE "x"` for an object no migration ever created — and nothing
   * noticed until someone tried to provision a fresh database, which for the reporter
   * was three months later. The two tiers are separate because a project adopted via
   * `migrate baseline --from-db` passes the first trivially and CANNOT pass the second
   * by construction: its snapshot is the whole introspected database and its chain is
   * empty.
   *
   * Exit codes follow verify's convention: a chain that fails to apply, or a snapshot
   * mismatch, is drift → 1; an engine that will not start is operational → 2.
   */
  async function runReplayVerify(): Promise<number> {
    // Resolve the migrations directory and the chain's dialect through MIGRATE's own
    // precedence, never a second derivation — verify must not look somewhere migrate
    // does not write, nor assume a dialect the chain was not emitted for.
    const migrateConfig = await resolveMigrateConfig(EMPTY_MIGRATE_FLAGS, projectRoot);

    if (migrateConfig.format === "flyway") {
      log.error(
        `meta verify --replay is not supported with --migration-format flyway — run 'flyway migrate' against a scratch database to replay`,
      );
      return 2;
    }

    // --dialect wins; else migrate's resolved dialect; else refuse. There is no --db
    // to infer from, so guessing would replay a postgres chain through sqlite.
    const dialect: Dialect | undefined = flags.dialect ?? migrateConfig.dialect;
    if (dialect === undefined) {
      log.error(
        `meta verify --replay: no dialect — pass --dialect <postgres|sqlite>, or set migrate.dialect in .metaobjects/config.json`,
      );
      return 2;
    }
    if (dialect === "d1") {
      log.error(
        `meta verify --replay is not supported for dialect 'd1' — use 'wrangler d1 migrations apply' against a scratch database to replay committed migrations`,
      );
      return 2;
    }

    const dir = resolvePath(projectRoot, migrateConfig.outDir);

    let engine: ReplayEngine;
    try {
      engine = await openReplayEngine(dialect);
    } catch (err) {
      // A missing optional driver lands here, and its message already carries the
      // install hint. Operational, not drift.
      log.error(`meta verify --replay: ${(err as Error).message}`);
      return 2;
    }

    try {
      let applied: ApplyPendingResult;
      try {
        applied = await applyPending(engine.db, dir, { dryRun: false, dialect });
      } catch (err) {
        log.error(`meta verify --replay: ${(err as Error).message}`);
        log.error(
          `meta verify --replay: the committed chain does not apply to an empty database. ` +
            `Applied migrations are immutable, so fix this with a NEW migration that creates the ` +
            `missing object — not by editing a committed up.sql.`,
        );
        return 1;
      }

      // Not a silent pass. `discoverMigrations` returns [] for a missing directory, so
      // a run over an empty chain would otherwise "succeed" having proved nothing —
      // and a gate that is quiet when it checked nothing cannot be told from one that
      // passed. Every migration is pending against a fresh engine, so an empty
      // `pending` means the directory held none.
      //
      // This return is for TIER 1 ONLY: an empty chain trivially "applies" (there is
      // nothing that could fail), so tier 1 is done. Tier 2 is NOT done — its job is
      // "does the replay reproduce the committed snapshot?", and a wrong
      // `migrate.outDir` or a project adopted via `migrate baseline --from-db` (whose
      // own chain is empty by construction) both look identical to this point. Return
      // ONLY when `--replay-snapshot` was not requested; otherwise fall through so an
      // empty replay is still compared against a snapshot that may record dozens of
      // tables, rather than reporting success having compared nothing.
      if (applied.pending.length === 0) {
        log.info(`meta verify --replay: no committed migrations — nothing to replay`);
        if (!flags.replaySnapshot) return 0;
      } else {
        log.info(
          `meta verify --replay — the committed chain applies to an empty ${dialect} database ` +
            `(${applied.applied.length} migration(s)).`,
        );
      }

      if (!flags.replaySnapshot) return 0;
      return await runReplaySnapshotTier(engine, dialect, dir);
    } finally {
      await engine.dispose();
    }
  }

  /**
   * The second tier: the replayed schema must EQUAL the committed snapshot.
   *
   * This is the 2026-05-31 §8 integrity aid, finally wired — `verifyReplay` has been
   * built and exported with no CLI caller since then. What it catches that tier 1
   * cannot is hand-edited structural DDL: a committed up.sql someone changed so the
   * chain still applies but no longer produces the schema the snapshot records.
   *
   * It does NOT support a project adopted via `migrate baseline --from-db`, and does
   * not try to detect one. The only candidate signal (`BASELINE_NAME`/`recordBaseline`)
   * has no production caller and would live in the TARGET database's ledger, while
   * this runs against a fresh engine with no ledger at all. So the failure message
   * names baseline adoption as the first thing to rule out.
   */
  async function runReplaySnapshotTier(
    engine: ReplayEngine,
    dialect: Extract<Dialect, "postgres" | "sqlite">,
    dir: string,
  ): Promise<number> {
    // Fails OPEN on a missing snapshot: a project that has never generated one
    // offline is not in an error state, and an unreadable/unparseable file is
    // migrate's error to raise with its own message, not a drift verdict. It still
    // SAYS so — silence here would be indistinguishable from a pass.
    let snapshot: SchemaSnapshot | null;
    try {
      snapshot = await readSnapshot(snapshotPath(dir, dialect));
    } catch {
      log.info(`meta verify --replay-snapshot: the committed snapshot could not be read — nothing to compare`);
      return 0;
    }
    if (snapshot === null) {
      log.info(`meta verify --replay-snapshot: no committed snapshot — nothing to compare`);
      return 0;
    }

    // A scoped project carries the OTHER owner's tables into its snapshot on purpose
    // and its chain never creates them, so they must leave the comparison. The
    // committed snapshot alone cannot be scoped — `scopeExpectedSchema` decides on a
    // qualified-name → metadata-FQN provenance map the snapshot does not carry — so
    // the expected side is rebuilt from metadata purely to derive that decision.
    //
    // Only for a project that actually declares `migrate.scope`. An unscoped project
    // passes no `governed` and gets the comparison exactly as it was.
    let governed: GovernedScope | undefined;
    if (schemaScope !== undefined) {
      const viewStrategy = forgeConfig?.columnNamingStrategy ?? "snake_case";
      const built = buildExpectedSchemaWithProvenance(root, {
        dialect,
        columnNamingStrategy: viewStrategy,
        views: buildProjectionViews(root, { dialect, columnNamingStrategy: viewStrategy }),
      });
      governed = scopeExpectedSchema(built, schemaScope);
    }

    // `verifyReplay` calls `applyPending` itself. That is NOT a second replay: the
    // first one recorded every migration in this engine's ledger, so the call finds
    // nothing pending and returns immediately.
    const result = await verifyReplay({
      db: engine.db,
      dialect,
      migrationsDir: dir,
      snapshot,
      ...(governed !== undefined ? { governed } : {}),
    });
    if (result.ok) {
      log.info(`meta verify --replay-snapshot — the replayed chain reproduces the committed snapshot.`);
      return 0;
    }

    log.error(
      `meta verify --replay-snapshot: the replayed chain does not reproduce the committed snapshot. ` +
        `If this project was adopted with 'migrate baseline --from-db', its chain does not build the ` +
        `schema and this tier does not apply — use --replay instead.`,
    );
    for (const line of summarizeDrift([...result.drift, ...result.unmanaged])) log.error(`  ${line}`);
    return 1;
  }

  // -- requirements (#290) ---------------------------------------------------
  function runRequirementVerify(): number {
    // No test-corpus scan runs here any more. `@verifiedBy` asked the author to
    // name a test and checked only that the NAME occurred somewhere in the test
    // sources — an audit of one real 19-name ledger found 4 names that did not
    // verify their claim (a comment, a DI key, a test of a different claim, a
    // test of the output where the claim was about the source text) while verify
    // reported zero errors throughout. Existence was never proof, and no lexical
    // rule reaches the semantic cases. FR-038 retires the attribute rather than
    // narrowing it; the replacement generates the test FROM the requirement, so
    // the link is structural instead of a string the author picks.
    // ONE scan for all three passes. The gate and the summary each used to walk the
    // model AND resolve every @implementedBy claim for themselves — the resolution
    // being the expensive half — and the lint added a third walk on top.
    const scan = scanRequirements(root);
    const diags = [...checkRequirements(root, scan)];

    // Printed on EVERY run, clean or not — a gate that says nothing when it
    // passes cannot be told apart from a gate that checked nothing, and the
    // recorded-gap counts are the whole reason to keep a ledger.
    const s = summariseRequirements(root, scan);
    if (s !== undefined) {
      const order = [...REQUIREMENT_STATUSES];
      const parts = order
        .filter((k) => (s.byStatus[k] ?? 0) > 0)
        .map((k) => `${s.byStatus[k]} ${k}`);
      // The file count is the DENOMINATOR'S PROVENANCE, and it is here because
      // `entitiesTotal` is only ever computed over what actually loaded. A spine that
      // covers half an estate reports the covered half as fully claimed — an adopter
      // found `76/76` while two of their four metadata trees were not in `sources` at
      // all, which is why nothing had ever flagged the templates living in them. No
      // check can see a tree it was never pointed at, so the honest fix is to publish
      // what the count was taken over and let a wrong number be noticeable.
      log.info(
        `meta verify — requirements: ${s.total} entries (${s.functional} functional, ` +
        `${s.architectural} architectural) — ${parts.join(", ")}; ` +
        `${s.entitiesClaimed}/${s.entitiesTotal} entities claimed, ` +
        `counted over ${collection.files.length} metadata file(s).`,
      );
      if (s.undecided > 0) {
        log.info(
          `meta verify — requirements: ${s.undecided} recorded gap(s) with no @disposition. ` +
          `These are known problems nobody has ruled on — set 'accepted' or 'deferred' to close the question.`,
        );
      }
    }

    const errors = diags.filter((d) => d.severity === "error");
    const warns = diags.filter((d) => d.severity === "warn");
    const CAP = 20;
    const fmt = (d: Diagnostic): string =>
      `  ${d.code}${d.path !== undefined ? ` [${d.path}]` : ""}: ${d.message}`;
    /** Print a capped run of warnings. Capped per SECTION, never across them: a
     *  ledger of a few hundred entries can produce hundreds of prose findings, and a
     *  shared cap would let the advisory lint push every gate warning off the end. */
    const warnCapped = (ds: readonly Diagnostic[]): void => {
      for (const d of ds.slice(0, CAP)) log.warn(fmt(d));
      if (ds.length > CAP) log.warn(`  …and ${ds.length - CAP} more.`);
    };
    for (const d of errors) log.error(fmt(d));
    warnCapped(warns);

    // -- the authoring lint: its own section, its own cap ----------------------
    // Separate from the gate above because it makes a different claim. The gate
    // says the ledger DISAGREES WITH THE MODEL; the lint says it agrees but
    // records less than its author thinks — a name that is not an address, two
    // slots holding one sentence, prose written where no surface reads it.
    //
    // The separate cap is the load-bearing part. A ledger of a few hundred
    // entries can produce hundreds of prose findings, and under one shared cap
    // those would push every WARN_REQUIREMENT_OBJECT_UNCLAIMED off the end of the
    // list — the lint would silence the gate it was added beside. Nothing here
    // reaches the exit code: every lint finding is a warning by construction.
    // Muted with --no-requirement-lint or META_NO_REQUIREMENT_LINT=1, the same pair
    // its sibling advisory offers. It mutes the ADVISORY half only — the gate above
    // still runs and can still fail the build, which is the point of the split.
    // `s === undefined` means the model declares no requirements at all, which the
    // two passes above have already established: opt-in by declaration, decided
    // without a third walk to rediscover it.
    const lint = s === undefined
        || flags.noRequirementLint
        || process.env.META_NO_REQUIREMENT_LINT === "1"
      ? []
      : lintRequirements(root, scan.addressed);
    if (lint.length > 0) {
      log.warn(
        `meta verify — requirements: ${lint.length} authoring warning(s) ` +
        `(advisory — does not fail the build):`,
      );
      warnCapped(lint);
    }

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
      findings = scanSourceForAntiPatterns(projectRoot);
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
    // Both report lines below must divide by the SAME thing, and it must be
    // something that was actually examined. They used to disagree: the failure line
    // divided by `templates.length` — every node found, INCLUDING every one the loop
    // `continue`s past (unknown subtype, no renderable body ref) — while the pass
    // line divided by a count of bodies verified. On a real project the same run read
    // "11 drift error(s) across 29 template(s)" while failing and "22 template(s)
    // clean" once fixed: seven templates apparently vanishing on the way to green,
    // and a failure line claiming a denominator of work that had not been done.
    // `checkedTemplates` is now the single unit — templates at least one body of
    // which was verified. (An @kind=email template has up to three bodies and still
    // counts once; the line says "template(s)", so it counts templates.)
    let checkedTemplates = 0;

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

      let anyBodyChecked = false;
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
        anyBodyChecked = true;
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
      if (anyBodyChecked) checkedTemplates++;
    }

    if (errorCount > 0) {
      log.error(
        `meta verify — ${errorCount} drift error(s) across ${checkedTemplates} template(s).`,
      );
      return 1;
    }
    log.info(
      `meta verify — ${checkedTemplates} template(s) clean${warnCount > 0 ? ` (${warnCount} warning(s))` : ""}.`,
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

    // A `migrate.scope` matching nothing it could govern is refused, not tolerated —
    // it would make this gate compare zero objects and report "in sync" (see
    // `migrateScopeMismatch`). Checked HERE rather than beside the other collection
    // work at the top of `verifyCommand`, because `migrate.scope` governs only the
    // schema gate: a stale pattern must not fail a `--templates` run that never
    // consults it.
    const scopeMismatch = migrateScopeMismatch(collection, () => {
      const dialect: Dialect = usingD1 ? "d1" : (flags.dialect ?? inferDialect(flags.db as string));
      const viewStrategy = forgeConfig?.columnNamingStrategy ?? "snake_case";
      return buildExpectedSchemaWithProvenance(root, {
        dialect,
        columnNamingStrategy: viewStrategy,
        views: buildProjectionViews(root, { dialect, columnNamingStrategy: viewStrategy }),
      }).provenance;
    });
    if (scopeMismatch !== undefined) {
      log.error(`verify: ${scopeMismatch}`);
      return 2;
    }

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
      let actual: SchemaSnapshot;
      try {
        // Introspect once and keep the result: #292's snapshot check needs the same
        // `actual` this drift comparison uses, and re-introspecting for it would both
        // cost a second round trip and open a window where the two could disagree.
        actual = await introspect(kysely.db, kysely.dialect);
        driftResult = await computeDriftFromActual(actual, kysely.dialect, root, {
          allow,
          views: expectedViews,
          ...(schemaScope !== undefined ? { inScope: schemaScope } : {}),
        });
      } catch (err) {
        log.error(`verify: failed to introspect ${kysely.displayUrl}: ${(err as Error).message}`);
        return 1;
      }

      const snapshotDrift =
        driftResult.changes.length === 0
          ? await checkCommittedSnapshot(actual, kysely.dialect, kysely.displayUrl, driftResult)
          : [];

      return reportSchemaDrift(driftResult, [...ledgerDrift, ...snapshotDrift], kysely.displayUrl);
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
    const d1Config = await resolveD1Config({ d1Binding: flags.d1, remote: flags.remote }, projectRoot);

    const wranglerConfigPath = d1Config.wranglerConfigPath
      ? resolvePath(projectRoot, d1Config.wranglerConfigPath)
      : findWranglerConfig(projectRoot);

    if (wranglerConfigPath === undefined && d1Config.binding === undefined) {
      log.error(`verify: no wrangler.toml found in ${projectRoot} or parents; pass --d1 <binding> to bypass`);
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
      const { stdout } = await activeWranglerRunner(wranglerArgs, projectRoot);
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
      driftResult = await computeDriftFromActual(actual, "d1", root, {
        allow,
        views: expectedViews,
        ...(schemaScope !== undefined ? { inScope: schemaScope } : {}),
      });
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
  // #292 — the committed reference snapshot is itself checked, and this is the only
  // place in the toolchain that can do it.
  //
  // `meta migrate` diffs metadata against `.metaobjects/migrations/.schema.<dialect>.json`
  // by default (`--from-db` is the documented opt-out), so that file decides what DDL the
  // next migration contains. Nothing verified it. A snapshot gone stale — an interrupted
  // migrate, a rollback, a bad merge resolution — passed `verify` clean and then made the
  // next `migrate --slug` emit DDL that fails at apply (`column ... already exists`), which
  // surfaces as a migration that cannot be applied and a history that cannot be reproduced.
  //
  // THE GATE IS CONDITIONED ON metadata==DB, deliberately, and that is what makes it
  // false-positive-free. The snapshot means "the schema the COMMITTED MIGRATIONS land you
  // in" and it advances at GENERATION time, so between `migrate --slug` and applying that
  // migration the snapshot legitimately leads the database. In exactly that window the
  // metadata↔DB drift is non-empty and this check stays silent; when metadata and the DB
  // agree there is no pending work left to explain a difference, so a snapshot that
  // disagrees is stale, full stop.
  //
  // Keying on the drift result rather than on the migration ledger is the load-bearing
  // choice. A ledger-based "are there unapplied migrations?" test looks equivalent and is
  // not: a project that applies its migrations out of band — psql, a CI step, another
  // tool — has no ledger rows at all, so every migration reads as pending and the gate
  // would silently never fire. That is the same class of defect as the one being fixed.
  //
  // Fails OPEN when there is no snapshot on disk (a project that has never generated one
  // offline is not in an error state) and when the file cannot be read or parsed (that is
  // migrate's error to raise, with its own message, not a drift verdict).
  async function checkCommittedSnapshot(
    actual: SchemaSnapshot,
    dialect: Dialect,
    displayUrl: string,
    governed: GovernedScope,
  ): Promise<string[]> {
    if (dialect === "d1") return []; // d1 keeps migrations Wrangler-native; no offline snapshot
    // Resolve the migrations dir through migrate's OWN precedence (flag > config >
    // default) rather than re-deriving it, so verify can never look somewhere migrate
    // does not write. Only `outDir` is consumed; the rest of the resolved config is
    // migrate's business.
    const migrateConfig = await resolveMigrateConfig(EMPTY_MIGRATE_FLAGS, projectRoot);
    const dir = resolvePath(projectRoot, migrateConfig.outDir);
    let snapshot: SchemaSnapshot | null;
    try {
      snapshot = await readSnapshot(snapshotPath(dir, dialect));
    } catch {
      return [];
    }
    if (snapshot === null) return [];

    // Out-of-scope objects leave BOTH sides of this comparison, and the schema pin
    // comes from the scope decision the DRIFT comparison already made — one door
    // (migrate-ts's `excludeFromSnapshot` + `scopedDiffInputs`), not a fifth
    // hand-rolled copy of the three-part contract. `unmanagedNames` suppresses the
    // actual side only, which is right for the metadata↔DB diff (its expected side
    // is already scoped) but not here: the committed snapshot IS the expected side,
    // and a snapshot written before the scope was declared still carries the other
    // owner's tables. Re-deriving the pin from the snapshot is what left an empty
    // (never-migrated) snapshot reaching `diff`'s whole-database fallback.
    const result = await diff({
      ...scopedDiffInputs(excludeFromSnapshot(snapshot, governed), collectUnmanagedNames(root)),
      actual,
      allow: {},
      // #297 — the SAME pipeline `meta migrate` runs, or this gate answers a different
      // question than the one it reports on. `DiffArgs.dialect` is optional, so omitting
      // it was silently accepted: views fell through to comparing our emitted body
      // against the deparser's (never equal, so permanent drift on Postgres), CHECK
      // constraints were skipped entirely, and SQLite type canonicalization no-opped.
      //
      // Note `unmanagedNames` is NOT restated here: `scopedDiffInputs` above supplies it
      // MERGED with the out-of-scope set, and a second key would silently drop that half.
      dialect,
    });
    if (result.changes.length === 0) return [];

    return [
      // `meta migrate --from-db` is NOT the repair: it writes a snapshot only when it has
      // changes to EMIT, so on a database that already matches the metadata it reports
      // "no schema changes / nothing to do", writes nothing, and leaves the stale snapshot
      // exactly as it was — so this gate fails again, identically, with the user having
      // been told everything is in sync. `baseline --from-db` rewrites it unconditionally,
      // which is the whole point of the subcommand.
      `the committed schema snapshot disagrees with ${displayUrl} ` +
        `(${result.changes.length} difference(s)) — the next 'meta migrate' would emit DDL from it ` +
        `and fail at apply. Re-derive it with ` +
        `'meta migrate baseline --from-db --db <url> --dialect ${dialect}'.`,
      ...summarizeDrift(result.changes),
    ];
  }

  function reportSchemaDrift(driftResult: DriftResult, ledgerDrift: string[], displayUrl: string): number {
    // #208 §8 — make declared-external objects visible: they are excluded from the
    // drift comparison (computeDrift/computeDriftFromActual thread them out), so
    // annotate them as external (declared) rather than let them vanish silently.
    const externalDeclared = collectUnmanagedNames(root);
    if (externalDeclared.length > 0) {
      log.info(
        `meta verify — ${externalDeclared.length} object(s) external (declared @unmanaged, managed elsewhere): ${externalDeclared.join(", ")}`,
      );
    }

    // Same reasoning for the per-command scope: an object `migrate.scope` excluded
    // was NOT checked, and silence would misreport it as checked-and-clean. Shared
    // wording with `meta migrate` — one declaration, one sentence about it.
    if (driftResult.outOfScope.length > 0) {
      log.info(outOfScopeNote("verify", driftResult.outOfScope));
    }

    const changes = driftResult.changes;
    if (changes.length === 0 && ledgerDrift.length === 0) {
      log.info(`meta verify — schema in sync with ${displayUrl}.`);
      return 0;
    }

    // The header is conditional: #292's snapshot findings arrive through `ledgerDrift`
    // with the metadata↔DB comparison clean, and announcing "schema drift (0 change(s))"
    // above them would contradict the very check that just passed.
    if (changes.length > 0) {
      log.error(`meta verify — schema drift vs ${displayUrl} (${changes.length} change(s)):`);
      for (const line of summarizeDrift(changes)) log.error(`  ${line}`);
    }
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

    // The identical predicate `meta gen` applies (Task 12b / design §7 open
    // question 3) — a `gen` that committed under a narrowed scope and a
    // `verify --codegen` that regenerates unscoped would disagree about which
    // files should exist, reporting every out-of-scope entity as drift.
    //
    // The same argument governs the SOURCE SET (#340), and it is the reason this
    // resolves its own collection instead of reusing the outer one: `gen` in a
    // sub-project generates from that package's own sources, so a `--codegen` gate
    // that regenerated from the ancestor's wider set would report every file the
    // ancestor contributes as drift — turning the #340 fix into a broken gate. It is
    // re-resolved rather than hoisted because `verify`'s subverbs COMPOSE: `--db` and
    // `--templates` are answering a question about the whole declared collection, and
    // narrowing the outer `root` would silently change what they check.
    const genCollection = await resolveGenCollection(collection, genConfigDir);
    let codegenRoot = root;
    if (genCollection !== collection) {
      try {
        codegenRoot = await loadMemory(genCollection.configDir, {
          files: genCollection.files,
          ...configLoadOptions,
          strict: !flags.lax,
        });
      } catch (err) {
        log.error(`verify --codegen: failed to load this package's metadata: ${(err as Error).message}`);
        // The second door onto the same strict load. It carried no remedy at all, which
        // meant a retirement diagnosed here told the author what broke and nothing about
        // how to fix it — the half-true rule this file's sibling comment warns about.
        for (const s of (err as { suggestions?: string[] }).suggestions ?? []) log.error(`  ${s}`);
        return 2;
      }
    }

    let result;
    try {
      result = await computeCodegenDrift(forgeConfig, codegenRoot, genConfigDir, genCollection.inScope);
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

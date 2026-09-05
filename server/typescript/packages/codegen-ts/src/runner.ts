import { join, relative, resolve, isAbsolute, dirname } from "node:path";
import { warnMissingPromptGenerators } from "./prompt-generator-gate.js";
import { warnRetiredCodegenAttrs } from "./retired-codegen-attrs.js";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import type { MetaData, MetaObject } from "@metaobjectsdev/metadata";
import { isMetaRoot, OBJECT_SUBTYPE_VALUE, FIELD_SUBTYPE_TIMESTAMP, FIELD_ATTR_FILTERABLE } from "@metaobjectsdev/metadata";
import { assignEmittedNames } from "./naming/collision-names.js";
import { isAbstract } from "./instance-artifacts.js";
import { dbEmittingObjects, missingDialectMessage } from "./db-emitting.js";
import { hasAnyRdbSource } from "./source-detect.js";
import type { Generator, GenContext, EmittedFile } from "./generator.js";
import type { MetaobjectsGenConfig } from "./metaobjects-config.js";
import { normalizeConfig, DEFAULT_TARGET_NAME } from "./metaobjects-config.js";
import type { ResolvedTarget } from "./import-path.js";
import { buildPkMap } from "./pk-resolver.js";
import { buildRelationMap } from "./relation-resolver.js";
import { makeRenderContext } from "./render-context.js";
import { sweepOrphans, type OrphanJob } from "./orphan-sweep.js";
import { refusedOrphanMessage } from "./reconcile-orphans.js";
import {
  decideAndWrite,
  previewWriteStatus,
  hasHashManifest,
  listGeneratedPaths,
  loadEngineVersion,
  saveEngineVersion,
  type WriteResult,
  type MergeStrategy,
  type BaselineMode,
  type DecideAndWriteOpts,
} from "./overwrite-policy.js";

/** JS-identifier-shape only. Prevents filesystem traversal when metadata comes
 *  from untrusted sources (e.g. MCP). Mirrors the guard in legacy generate.ts. */
const VALID_ENTITY_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** ADR-0025: doc generators whose single door is `meta docs`. If a `meta gen`
 *  config still lists one (by its stable `name`), the runner warns + skips it. */
const DEPRECATED_DOC_GENERATORS = new Set(["docs-file", "api-docs"]);

export interface RunGenOpts {
  config: MetaobjectsGenConfig;
  metadata: MetaData;
  /** Optional whitelist of entity names. */
  entityFilter?: string[];
  /** Overwrite strategy passed to decideAndWrite. Defaults to "overwrite". */
  mergeStrategy?: MergeStrategy;
  /** Project root (used to derive the .gen-state/ snapshot directory and to
   *  key snapshots by project-relative output path). When omitted, falls back
   *  to process.cwd(). */
  projectRoot?: string;
  /** Override the snapshot directory location. Defaults to
   *  `<projectRoot>/.metaobjects/.gen-state/`. */
  genStateDir?: string;
  /** First-time-on-existing-file behavior. Defaults to "default" (write-if-
   *  different). "fresh" → overwrite and re-baseline (the `--baseline=fresh`
   *  CLI flag). */
  baseline?: BaselineMode;
  /**
   * Preview only — render and report, touching NOTHING on disk (no output files,
   * no `.gen-state/` snapshot). Backs `meta gen --dry-run`.
   *
   * Until 0.21.x the flag existed only in the CLI's *display* object and was never
   * passed here, so `--dry-run` wrote every file exactly like a real run — while the
   * website, `meta init`'s next-steps and the CLI help all called it "preview without
   * writing". A fresh adopter found it by deleting a generated file, running
   * `--dry-run`, and watching it reappear.
   */
  dryRun?: boolean;
  /**
   * Output scope — an object is generated only when this predicate returns true
   * for its fully-qualified name (`obj.resolutionKey()`, `<package>::<name>`).
   * Intersects with `entityFilter`: both must pass. Absent ⇒ every object is
   * in scope (byte-identical to a project with no `scope` declared).
   *
   * The collection metadata always loads in FULL regardless of this predicate —
   * scope filters OUTPUT, never input (design §4.3). So an in-scope object may
   * reference an out-of-scope one (an FK target, a relationship `@objectRef`, a
   * projection's base) and resolve perfectly at load time, while the code
   * emitted FOR the in-scope object still imports/names a symbol that was never
   * generated. This is left silent by design, not auto-widened: the adopter
   * declared the scope precisely because something else (another consumer,
   * another codegen run) owns those objects, and the reference is real. Warning
   * on it correctly would require walking every reference kind (identity.reference,
   * every relationship.* @objectRef, projection extends bases, field.object
   * @objectRef) FQN-resolved against the SAME scope — genuinely new machinery,
   * not a fit for the existing `warnings: string[]` channel at this seam. If an
   * adopter hits it, the failure is a plain compiler error in the generated
   * code (an unresolved import) — loud, at build time, not silent at runtime.
   *
   * Deliberately a PLAIN PREDICATE, not the `include`/`exclude` pattern strings
   * `@metaobjectsdev/sdk`'s `scope.ts` compiles. `codegen-ts` must not depend on
   * `@metaobjectsdev/sdk` — the dependency runs the other way (`cli` depends on
   * both) — so it cannot import `matchesScope`/`CompiledScope` itself. The
   * design's "package patterns, never a predicate function" rule (§4.3 of the
   * metadata-source-resolution design doc) governs CONFIG SURFACES that must
   * port identically to a `pom.xml` / `metaobjects.config.yaml` in every
   * language port; it says nothing about internal plumbing between two
   * TypeScript packages in this one repo. Do not "fix" this into a config
   * shape — `cli`'s `gen`/`verify` commands are the only callers, and a
   * `Collection` already exposes exactly this predicate as `inScope`, which
   * they pass straight through.
   */
  scope?: (fqn: string) => boolean;
}

export interface RunGenResult {
  files: WriteResult[];
  warnings: string[];
  /** Subset of `files` with status "conflict" — surfaced separately so the
   *  CLI can print the end-of-run summary. */
  conflicts: WriteResult[];
}

/**
 * codegen-ts's own published version, for the #232 gen-state engine stamp. Read from
 * this package's package.json (one level above `dist/` or `src/`); undefined when it
 * can't be resolved (e.g. inside a compiled standalone binary with no on-disk
 * package.json) — the stamp is informational, so an unknown version simply skips it.
 */
function engineVersion(): string | undefined {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

export async function runGen(opts: RunGenOpts): Promise<RunGenResult> {
  const warnings: string[] = [];
  const strategy = opts.mergeStrategy ?? "overwrite";
  const baseline = opts.baseline ?? "default";
  // When projectRoot is not supplied we DON'T fall back to process.cwd() —
  // that would leak .gen-state/ into whatever directory happens to be cwd
  // (e.g. the package dir during a unit-test run). Instead, fall back to a
  // process-isolated tmpdir, which gives the new-write semantics every call
  // (the snapshot exists only for the current process). The CLI's
  // `genCommand` always passes a real projectRoot, so this fallback only
  // affects programmatic callers (tests, library embedding).
  const projectRoot = opts.projectRoot !== undefined
    ? (isAbsolute(opts.projectRoot) ? opts.projectRoot : resolve(opts.projectRoot))
    : undefined;
  const genStateDir = opts.genStateDir !== undefined
    ? (isAbsolute(opts.genStateDir)
        ? opts.genStateDir
        : resolve(projectRoot ?? process.cwd(), opts.genStateDir))
    : (projectRoot !== undefined
        ? join(projectRoot, ".metaobjects", ".gen-state")
        : join(tmpdir(), `meta-gen-state-${process.pid}`));

  // #232 — make an unexplained regen diff explained: if the codegen engine changed
  // since the last gen, note it (generated output may legitimately differ). Purely
  // informational — the version file is separate from `.hashes.json` and never
  // affects the merge. Only fires when a prior stamp exists AND differs.
  // Captured BEFORE any write, because the first write creates the manifest — read
  // it afterwards and every project looks migrated.
  const hadHashManifest = hasHashManifest(genStateDir);
  const relativeForDisplay = (p: string): string =>
    projectRoot !== undefined ? relative(projectRoot, p) : p;

  const hasPersistentGenState = opts.projectRoot !== undefined || opts.genStateDir !== undefined;
  const installedEngine = hasPersistentGenState ? engineVersion() : undefined;
  const recordedEngine = hasPersistentGenState ? loadEngineVersion(genStateDir) : undefined;
  if (
    installedEngine !== undefined &&
    recordedEngine !== undefined &&
    recordedEngine !== installedEngine
  ) {
    warnings.push(
      `codegen engine ${recordedEngine} → ${installedEngine} since last gen — ` +
        `generated output may differ; see CHANGELOG.`,
    );
  }

  // loadMemory now returns MetaRoot; guard here also covers callers that pass a
  // plain MetaData (e.g. test helpers that build trees programmatically).
  // isMetaRoot, not `instanceof`: a consumer embedding runGen() programmatically
  // never runs the CLI's @metaobjectsdev/metadata alias, so a split tree would
  // reject the very root the caller just loaded.
  if (!isMetaRoot(opts.metadata)) {
    throw new Error("runGen: opts.metadata must be a loaded MetaRoot.");
  }
  const root = opts.metadata;

  // 1. Resolve entities (entityFilter + scope + safety check). This is the
  // single choke point for entity selection — scope INTERSECTS entityFilter
  // (an object must pass both), matched against the object's
  // fully-qualified name (resolutionKey(), never the bare name — two
  // packages may declare the same short name).
  const allObjects = root.objects();
  const entityFilter = opts.entityFilter;
  const afterEntityFilter = entityFilter
    ? allObjects.filter((o) => entityFilter.includes(o.name))
    : allObjects;
  const scope = opts.scope;
  const filtered = scope
    ? afterEntityFilter.filter((o) => scope(o.resolutionKey()))
    : afterEntityFilter;
  if (filtered.length === 0) {
    // Name the REAL cause. When `scope` is absent, this is byte-identical to
    // the pre-scope two-way branch (kept as its own arm, rather than folded
    // into the scope-aware logic below, so an unscoped project's warning text
    // — including its quirky edge case: an empty root with entityFilter set
    // still blames entityFilter — is untouched). Only when `scope` is
    // present does a THIRD reason become reachable: "root has no object
    // children" for a scoped-out model, or "...entityFilter" for a scope
    // that admitted everything entityFilter then excluded, are both false
    // statements that send the reader to the wrong file.
    let reason: string;
    if (scope === undefined) {
      // Byte-identical to the pre-scope branch, quirk included: an EMPTY root
      // with an entityFilter set still blames the filter. Wrong, and untouched
      // — changing what an unscoped project reads is a behaviour change, and
      // this is a shape change.
      reason = entityFilter
        ? "no object children match the provided entityFilter"
        : "root has no object children";
    } else if (allObjects.length === 0) {
      reason = "root has no object children";
    } else if (afterEntityFilter.length === 0) {
      reason = "no object children match the provided entityFilter";
    } else {
      reason = "no object children match the configured scope";
    }
    warnings.push(`No entities to generate — ${reason}.`);
    return { files: [], warnings, conflicts: [] };
  }

  const safeEntities: MetaObject[] = [];
  for (const entity of filtered) {
    if (!VALID_ENTITY_NAME.test(entity.name)) {
      warnings.push(
        `Skipping entity with unsafe name "${entity.name}" — must match /^[A-Za-z_][A-Za-z0-9_]*$/.`,
      );
      continue;
    }
    safeEntities.push(entity);
  }
  if (safeEntities.length === 0) {
    return { files: [], warnings, conflicts: [] };
  }

  // #194 — dbImport / dialect are optional config, BUT a model that declares a
  // source.rdb genuinely needs `dialect`. Only a sourced object emits database
  // artifacts (schema / query / route code), and every generator below gates
  // that emission on hasAnyRdbSource — the #248 R2 source-based predicate — so a
  // sourceless object (a value object, or a sourceless projection) emits zero DB
  // code. Guard BEFORE normalizeConfig fills its inert defaults, so a DB project
  // that forgot it gets a clear error naming the objects, never
  // silently-defaulted output (a Postgres project quietly emitting sqlite).
  //
  // `dbImport` is NOT part of this check, and the difference is where the answer
  // is needed. A dialect is a property of the MODEL: every sourced object is
  // lowered to SQL, and a wrong default is silently wrong everywhere. A dbImport
  // is a property of a GENERATOR: only one that emits `import { db } from …` can
  // read it, and a project whose generated queries take `db` as a parameter has
  // no singleton to name. Demanding it from the model convicted exactly those
  // projects — the error even told them their model "generates database code"
  // that in fact imported nothing. It is demanded below at the point of USE, by
  // the generator that reads it, which the runner names in the thrown message.
  const dbEmitting = dbEmittingObjects(safeEntities);
  if (dbEmitting.length > 0 && opts.config.dialect === undefined) {
    throw new Error(missingDialectMessage(dbEmitting));
  }

  /** Did the AUTHOR declare a dbImport reachable by this target? Tracked, never
   *  inferred by comparing against DEFAULT_DB_IMPORT — `meta init` scaffolds a
   *  relative path and a project may legitimately write the default's own string,
   *  which a value comparison would then read as absent. */
  const dbImportUndeclaredFor = (targetName: string): boolean =>
    (opts.config.targets?.[targetName]?.dbImport ?? opts.config.dbImport) === undefined;

  // 2. Resolve targets + entity-module target.
  const config = normalizeConfig(opts.config);

  // (Historical: a warning stood here for a @filterable timestamp under
  // timestampMode:"date", which used to throw at REQUEST time in runtime-ts's
  // filter parser. That limitation is fixed — the generated allowlist now carries
  // `dateValues: true` for a Date-mode timestamp column and the parser coerces with
  // `new Date(...)` — so the warning was removed rather than left to cry wolf.)

  const targets = config.targets;
  const targetOf = (g: Generator): ResolvedTarget => {
    const name = g.target ?? DEFAULT_TARGET_NAME;
    const t = targets[name];
    if (!t) {
      throw new Error(
        `Generator "${g.name}" references unknown target "${name}". ` +
        `Valid targets: ${Object.keys(targets).join(", ")}.`,
      );
    }
    return t;
  };
  // Validate all target references up front.
  for (const g of config.generators) targetOf(g);

  const entityGen = config.generators.find((g) => g.emitsEntityModule);
  const entityModuleTarget = entityGen ? targetOf(entityGen) : targets[DEFAULT_TARGET_NAME]!;

  // NO eager importBase check here, deliberately.
  //
  // There used to be one: "any generator on a non-entity target ⇒ the entity
  // target must have importBase". It asked the wrong question — target placement,
  // not whether anything actually imports across targets — so it convicted every
  // multi-target project whose second target imports nothing, and the only way
  // out was to set a value that is provably inert. An adopter hit this with a
  // requirement-test target that imports no entity modules at all.
  //
  // `crossTargetEntityPath` (import-path.ts) is the SOLE consumer of importBase
  // and already throws when it is missing, naming the resolution that needed it —
  // and every cross-target entry point (`entityModuleSpecifier`,
  // `barrelModuleSpecifier`) routes through it. That throw happens inside phase 4,
  // before the write phase, and the runner tags it with the generator name, so
  // the diagnostic is strictly better than the one removed here.
  //
  // The trade, stated: a generator whose cross-target import is CONDITIONAL now
  // fails when a model change first makes it real, rather than at config time.
  // That is the correct moment — it is also the only moment the answer is known.

  // 3. Build shared render state once.
  const pkMap = buildPkMap(root);
  const relationMap = buildRelationMap(root);
  // ADR-0044/#228 — the ENTITY-tier collision domain is the run's EMITTED
  // `object.value` SET (NOT any per-payload closure): value-object module
  // filenames + `packageOf` are per-run/global, so the emitted-name map is built
  // ONCE over every top-level `object.value` that actually produces a file, keyed
  // by `resolutionKey()`. A bare short name unique across the set stays bare
  // (byte-identical to pre-#228 output); a cross-package short-name collision
  // qualifies every member (`AcmeAlphaNote`), and a still-colliding derived name
  // fails loud (ERR_PAYLOAD_NAME_COLLISION, thrown by assignEmittedNames). A
  // NON-emitted abstract value object (abstract + emitAbstractShapes off) produces
  // no file/reference and is excluded — the entity-file generator's own emit gate
  // (`isAbstract && !emitAbstractShapes` ⇒ skip) — so it can't over-qualify a
  // concrete value object that merely shares its bare name in another package.
  const isEmittedValueObject = (o: MetaObject): boolean =>
    o.subType === OBJECT_SUBTYPE_VALUE && (!isAbstract(o) || config.emitAbstractShapes);
  const valueObjectClosure = new Map<string, MetaData>();
  for (const o of root.objects()) {
    if (isEmittedValueObject(o)) valueObjectClosure.set(o.resolutionKey(), o);
  }
  const valueObjectNames = assignEmittedNames(valueObjectClosure);
  // `packageOf` keys value objects by their EMITTED name (unique by construction
  // via the backstop) so `valueObjectModuleSpecifier` resolves the right module
  // even when two same-bare-named value objects live in different packages (the
  // #244 misbinding disease). Non-value objects keep their bare name. With no
  // collision, every emitted name equals its bare name, so this map is
  // byte-identical to the pre-#228 `[o.name, o.package]` map.
  const packageOf = new Map<string, string | undefined>();
  for (const o of root.objects()) {
    const key = o.subType === OBJECT_SUBTYPE_VALUE
      ? (valueObjectNames.get(o.resolutionKey()) ?? o.name)
      : o.name;
    packageOf.set(key, o.package);
  }

  // Auto-detect: is the OPT-IN Hono routes generator in the active suite? If so,
  // surface it on every generator's ctx.config so api-docs documents the Hono
  // CRUD surface it actually emits (rather than silently omitting it).
  const includeHonoRoutes = config.generators.some((g) => g.emitsHonoRoutes === true);

  // §A6 — same auto-detection for the OPT-IN names generator. The entity tier may only
  // REFERENCE `<Entity>Names` when something in this run actually emits it; the names
  // generator is opt-in under ADR-0034 (meta gen runs the adopter's own copies), so an
  // unconditional import would break every project that has not added it. Surfaced BOTH
  // on ctx.config (the field reference/names.ts documents, and the shape a third-party
  // generator reads) and on every RenderContext below (what the templates can actually
  // see) — one aggregation, two consumers.
  //
  // Scoped BY TARGET, unlike includeHonoRoutes, because the two flags are read for
  // different reasons: api-docs asks "is this surface in the run?", while a template
  // referencing these constants emits a RELATIVE import at its own target's path. The
  // names artifact is not a registered cross-target module (there is no importBase route
  // to it), so `entityFile({ target: "db" })` beside a default-target `namesFile()` would
  // otherwise emit `./<Entity>.names` from a directory that does not hold one.
  const namesTargets = new Set(
    config.generators.filter((g) => g.emitsNames === true).map((g) => targetOf(g).name),
  );

  // A declared template.prompt with no prompt generator wired emits nothing and, before
  // this, said nothing — while `meta verify` reported the template "clean". See
  // prompt-generator-gate.ts. Self-extinguishing; warning only.
  warnMissingPromptGenerators(root, config.generators, (m) => warnings.push(m));

  // A retired `@emit*` codegen flag still sitting in the metadata suppresses nothing now.
  // Named here rather than left to be discovered as a file that reappeared. Scoped to
  // the run's own entity set (the same set every generator sees), so `meta gen <entity>`
  // reports on what it just generated rather than on objects it was told to skip.
  // See retired-codegen-attrs.ts. Self-extinguishing; warning only.
  warnRetiredCodegenAttrs(safeEntities, (m) => warnings.push(m));

  // 4. Run each generator with a per-target render context; collect with full path.
  const emitted: { fullPath: string; content: string; generatedBy: string }[] = [];
  // FR-038 §8 — generators that opted into orphan reconciliation, paired with the
  // directory their policy's relative paths are measured from. Collected here
  // because `writeOutDir` is resolved per generator inside this loop.
  const orphanJobs: OrphanJob[] = [];
  for (const generator of config.generators) {
    // ADR-0025: `meta docs` is the single docs door. A `meta gen` config that
    // still lists a deprecated doc generator is warned + skipped, not run — the
    // generator stays as `meta docs`'s internal engine.
    if (DEPRECATED_DOC_GENERATORS.has(generator.name)) {
      warnings.push(
        `[${generator.name}] docs are produced by 'meta docs' (ADR-0025); ` +
        `remove ${generator.name === "api-docs" ? "apiDocsFile()" : "docsFile()"} from generators. Skipped.`,
      );
      continue;
    }
    const selfTarget = targetOf(generator);
    // Resolve the WRITE-time location against projectRoot when outDir is
    // relative and projectRoot is known — otherwise a relative outDir (the
    // common, portable, `meta init`-scaffolded shape) silently resolves
    // against the ambient process.cwd() instead of the project the CLI's
    // `--cwd` flag says to run as. Import-path math below intentionally keeps
    // using selfTarget.outDir as configured (relative paths between targets
    // are compared to each other, not to projectRoot).
    const writeOutDir = projectRoot !== undefined && !isAbsolute(selfTarget.outDir)
      ? resolve(projectRoot, selfTarget.outDir)
      : selfTarget.outDir;
    if (generator.orphanPolicy !== undefined) {
      orphanJobs.push({
        generatorName: generator.name,
        writeOutDir,
        policy: generator.orphanPolicy,
      });
    }
    const renderContext = makeRenderContext({
      dialect: config.dialect,
      loadedRoot: root,
      outDir: selfTarget.outDir,
      dbImport: selfTarget.dbImport,
      extStyle: config.extStyle,
      columnNamingStrategy: config.columnNamingStrategy,
      pluralizeCollections: config.pluralizeCollections,
      collectionNameOverrides: config.collectionNameOverrides,
      timestampMode: config.timestampMode,
      clientDirective: config.clientDirective,
      apiPrefix: config.apiPrefix,
      emitAbstractShapes: config.emitAbstractShapes,
      outputLayout: selfTarget.outputLayout,
      includeNames: namesTargets.has(selfTarget.name),
      pkMap,
      relationMap,
      packageOf,
      valueObjectNames,
      selfTarget,
      entityModuleTarget,
      ...(config.providedEnumModule !== undefined && { providedEnumModule: config.providedEnumModule }),
    });
    const ctx: GenContext = {
      entities: safeEntities,
      loadedRoot: root,
      matches: (e) => generator.filter?.(e) ?? true,
      config: {
        outDir: selfTarget.outDir,
        extStyle: config.extStyle,
        dbImport: selfTarget.dbImport,
        dialect: config.dialect,
        outputLayout: selfTarget.outputLayout,
        includeHonoRoutes,
        includeNames: namesTargets.has(selfTarget.name),
      },
      renderContext,
      ...(projectRoot !== undefined && { projectRoot }),
      warn: (msg) => warnings.push(`[${generator.name}] ${msg}`),
    };

    // The point of USE for an undeclared dbImport (see the guard above). Reading
    // it is what proves this generator emits a db-singleton import, so reading is
    // what asks for it; a generator that never touches it never demands it. The
    // throw travels through the `[${generator.name}]` wrapper below, so the message
    // names the generator that wants the path. Both surfaces are covered because a
    // generator may read either.
    if (dbImportUndeclaredFor(selfTarget.name)) {
      const demand = (): never => {
        throw new Error(
          `codegen config is missing dbImport — this generator emits ` +
            `\`import { db } from …\` and needs the module to import it from. Set dbImport in ` +
            `metaobjects.config.ts (or on this generator's target). A project whose generated ` +
            `queries take \`db\` as a parameter never needs it.`,
        );
      };
      Object.defineProperty(renderContext, "dbImport", { get: demand, configurable: true });
      Object.defineProperty(ctx.config, "dbImport", { get: demand, configurable: true });
    }

    let files: EmittedFile[];
    try {
      files = await generator.generate(ctx);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // `cause` preserves the original throw. Without it a `runGen` caller sees a
      // plain Error carrying only the prefixed message, so it cannot tell a
      // CodegenError (a metadata/config problem it can report) from a genuine bug
      // in a generator, and every stack trace stops at this line.
      throw new Error(`[${generator.name}] ${msg}`, { cause: err });
    }

    for (const file of files) {
      const fullPath = join(writeOutDir, file.path);
      const collision = emitted.find((prev) => prev.fullPath === fullPath);
      if (collision) {
        // #266 — identical bytes at the same path are not a conflict: either
        // emission produces exactly the same file, so keep the first and move on.
        // This is what makes a SHARED artifact rendered from the whole loaded root
        // (the shared `enums.ts`, emitted by every entityFile() instance) work in a
        // config that runs more than one instance against one target — previously
        // the build failed on an emission colliding with a copy of itself. Content
        // that genuinely DIFFERS is still a hard error: the outcome would depend on
        // generator order, which is exactly the ambiguity this guard exists to catch.
        if (collision.content === file.content) continue;
        throw new Error(
          `Output path collision: "${fullPath}" emitted by both ` +
          `"${collision.generatedBy}" and "${generator.name}". ` +
          `Adjust one generator's filter or output path.`,
        );
      }
      emitted.push({ fullPath, content: file.content, generatedBy: generator.name });
    }
  }

  // 5. Write phase.
  const writes: WriteResult[] = [];
  const conflicts: WriteResult[] = [];

  // FR-038 §8 — reconcile files a previous run generated that this run does not.
  //
  // Gated on a real `projectRoot` for a load-bearing reason, not caution: without
  // one, `decideAndWrite` keys each snapshot by a hash of its absolute path
  // instead of a project-relative path, so gen-state holds no path to resolve and
  // reconciliation has nothing to reason about. That gate is also what keeps
  // `verify --codegen` inert — it runs against a throwaway root whose gen-state is
  // empty — and what keeps programmatic/test callers from ever deleting a file.
  // Refusals are reported ONE of two ways, and which one matters more than the
  // wording. A project with no manifest at all predates the manifest being
  // committed: every refusal in it has the SAME single cause and the same one-line
  // fix, so N per-file warnings would be a wall that buries the instruction — the
  // hostile-first-contact outcome that gets a tool switched off. A project that DOES
  // have a manifest is refusing because specific files were edited, and there the
  // per-file naming is the actionable part.
  //
  // Self-extinguishing: once the manifest is committed, the aggregate never fires
  // again.
  const MAX_NAMED = 5;
  const reportRefusals = (): void => {
    const refused = writes.filter((w) => w.status === "refused");
    if (refused.length === 0) return;

    if (!hadHashManifest) {
      const names = refused.slice(0, MAX_NAMED).map((w) => relativeForDisplay(w.path));
      const more = refused.length > MAX_NAMED ? `, and ${refused.length - MAX_NAMED} more` : "";
      warnings.push(
        `Refused to overwrite ${refused.length} existing file(s), and this project has ` +
        `no codegen hash manifest — so 'meta gen' cannot tell your edits from its own ` +
        `stale output, and it will not guess. This is the expected first run for a ` +
        `project created before the manifest was committed. ` +
        `ONE-TIME FIX: commit '.metaobjects/.gen-state/.hashes.json' (un-ignore it in ` +
        `.metaobjects/.gitignore with '.gen-state/*' + '!.gen-state/.hashes.json'), ` +
        `then re-run. To adopt fresh output and DISCARD any hand edits in these files ` +
        `instead, re-run with --baseline=fresh. Files: ${names.join(", ")}${more}.`,
      );
      return;
    }

    for (const w of refused) {
      warnings.push(
        `Refused to overwrite ${w.path}: ${w.conflictHint ?? "content differs and could not be verified as generated."}`,
      );
    }

    // The recovery, ONCE — for the same reason the no-manifest branch above aggregates:
    // it is the same three commands whether one file refused or sixteen, and repeating
    // it per file buries it.
    //
    // It is stated as a SEQUENCE rather than a menu because there is exactly one way to
    // keep an edit here and it is not obvious: a three-way merge needs a base, the
    // `.gen-state` bodies are gitignored, and this machine has none — so the base has to
    // be manufactured first. `--baseline=fresh` writes fresh output AND seeds the missing
    // snapshot; restoring the file from git then puts the edit back with a base now
    // present, and the next run merges it. Verified end to end (refused → overwrite →
    // merged, edit intact).
    //
    // Two remedies were removed from the per-file hint and are not restored here as
    // universal advice. "Move the edit into a non-generated file" holds only where the
    // edit CAN live elsewhere — a `requirementTests()` stub's body cannot, because the
    // test name is the link to the requirement and the stub's own header forbids renaming
    // it. "--baseline=fresh" alone is a discard, and is named as one.
    warnings.push(
      `To KEEP your version of the file(s) above, the edit must be committed first — ` +
      `then: 'meta gen --baseline=fresh' (writes fresh output over them and seeds the ` +
      `missing .gen-state snapshot), 'git checkout -- <paths>' to bring your version back, ` +
      `then 'meta gen' again — the snapshot now exists, so the edit merges. ` +
      `To DISCARD your version instead, '--baseline=fresh' on its own is the whole answer. ` +
      `Moving the edit into a non-generated file works only where the edit can live outside ` +
      `the generated one; a requirementTests() stub's body cannot, since the test name is ` +
      `its link to the requirement.`,
    );
  };

  const sweep = (dryRun: boolean): void => {
    if (projectRoot === undefined || orphanJobs.length === 0) return;

    // NEVER reconcile a PARTIAL run. `meta gen <entity>` narrows the object set, so
    // `emitted` is a subset of the full output BY CONSTRUCTION — every path belonging
    // to an unselected entity looks exactly like an orphan, and the untouched ones get
    // deleted. The shipped `requirementTests()` escapes only by accident (it walks
    // `ctx.loadedRoot` and ignores `ctx.matches`); any app generator that honours
    // `ctx.matches` — the documented, encouraged composition — would wipe every
    // non-selected entity's output on a routine filtered run.
    //
    // The runner is the ONLY layer that knows the run was partial: a generator sees a
    // narrowed entity list and cannot tell it from a model that genuinely has one
    // entity. So the guard has to live here.
    if (opts.entityFilter !== undefined && opts.entityFilter.length > 0) {
      // Say it only when something was ACTUALLY withheld. With no previously-generated
      // path outside this run's own output there are no orphan candidates at all, so
      // the sweep provably no-ops and there is nothing to report. `meta gen <entity>`
      // is a routine command; warning on every one of them teaches the reader to skim
      // the message, which is how the real one gets skimmed too.
      //
      // Note the manifest is NOT empty here even on a first run — the writes above have
      // already recorded this run's own paths in it — so the emitted set has to come
      // out before counting. Computing the candidate set is safe on a filtered run;
      // what must never happen is ACTING on it.
      //
      // A non-empty candidate set is the FLOOR, not proof that a specific file would
      // have been removed: whether one falls inside an opting-in generator's namespace
      // is the reconcile's answer, and running that is the thing being skipped.
      const emittedRel = new Set(emitted.map((f) => relative(projectRoot, f.fullPath)));
      const withheld = listGeneratedPaths(genStateDir).filter((p) => !emittedRel.has(p));
      if (withheld.length > 0) {
        warnings.push(
          `Skipped orphan cleanup: this run generated only ${opts.entityFilter.join(", ")}, ` +
          `so it cannot tell a file belonging to an unselected entity from one that is no ` +
          `longer generated. Run 'meta gen' with no entity filter to reconcile deletions.`,
        );
      }
      return;
    }
    const result = sweepOrphans({
      genStateDir,
      projectRoot,
      emittedRelPaths: emitted.map((f) => relative(projectRoot, f.fullPath)),
      jobs: orphanJobs,
      dryRun,
    });
    // Both kinds are the same file outcome — gone. What differs is what it cost,
    // which is what the warning below is for.
    for (const relPath of [...result.removed, ...result.forced]) {
      writes.push({ path: join(projectRoot, relPath), status: "removed" });
    }
    if (result.refused.length > 0) {
      // Grouped by the generator that refused, so each message names a generator the
      // project actually registered. `orphanPolicy` is generic and apps are encouraged
      // to compose their own, so one blanket message naming `requirement-tests` would
      // be wrong for precisely the users the seam exists for.
      const byGenerator = new Map<string, string[]>();
      for (const relPath of result.refused) {
        const owner = result.refusedBy.get(relPath) ?? "orphan cleanup";
        const list = byGenerator.get(owner);
        if (list === undefined) byGenerator.set(owner, [relPath]);
        else list.push(relPath);
      }
      for (const [owner, paths] of byGenerator) {
        warnings.push(refusedOrphanMessage(paths, owner));
      }
    }
    if (result.forced.length > 0) {
      warnings.push(
        `Deleted ${result.forced.length} hand-edited generated file(s) because a ` +
        `generator's orphanPolicy sets force: ${result.forced.join(", ")}. ` +
        `Hand-written content in them is gone — recover from version control.`,
      );
    }
  };

  // --dry-run: report what WOULD be written and touch nothing — no output files
  // and no .gen-state/ snapshot (writing the snapshot would silently re-baseline
  // the merge base, so a later real run could skip a genuinely-needed write).
  if (opts.dryRun === true) {
    for (const file of emitted) {
      // Ask the same policy the real run asks, in a read-only mode. This used to be
      // `existsSync(...) ? "overwrite" : "new"`, which previewed a hand-edited file
      // as "overwrite" while the real run refused it — the one case the preview most
      // needs to be right about. A merge outcome is still coarse (see
      // previewWriteStatus), because clean-vs-conflicted is unknowable without merging.
      const policyOpts: DecideAndWriteOpts = {
        strategy,
        genStateDir,
        baseline,
      };
      if (projectRoot !== undefined) {
        policyOpts.outputRelPath = relative(projectRoot, file.fullPath);
      }
      writes.push({
        path: file.fullPath,
        status: previewWriteStatus(file.fullPath, file.content, policyOpts),
      });
    }
    reportRefusals();
    // A preview that hides a pending deletion is worse than no preview at all, so
    // the sweep still runs — in decide-and-report mode, touching nothing.
    sweep(true);
    return { files: writes, warnings, conflicts };
  }

  for (const file of emitted) {
    // Key the snapshot by project-relative path so multi-target projects keep
    // distinct entries (e.g. `database/Post.ts` vs `web/Post.queries.ts`).
    // Without an explicit projectRoot we let decideAndWrite derive a stable
    // hash-of-path key — fine for ephemeral test runs.
    const policyOpts: DecideAndWriteOpts = {
      strategy,
      genStateDir,
      baseline,
    };
    if (projectRoot !== undefined) {
      policyOpts.outputRelPath = relative(projectRoot, file.fullPath);
    }
    const result = decideAndWrite(file.fullPath, file.content, policyOpts);
    writes.push(result);
    if (result.status === "conflict") {
      conflicts.push(result);
      warnings.push(
        `Merge conflict in ${file.fullPath}: resolve diff3 markers and re-run ` +
        `'meta gen' to advance the canonical state.`,
      );
    }
    // Refusals are reported together after the loop (see reportRefusals) so a
    // whole-project cause can be stated once instead of once per file.
  }

  reportRefusals();

  // Sweep AFTER the writes: writing is the primary job, and a deletion that runs
  // first would be unrecoverable if a later write threw. Ordering cannot change
  // the decision — a path this run emitted is never an orphan either way.
  sweep(false);

  // #232 — stamp the engine version that produced this snapshot, so the NEXT gen can
  // detect an engine change. Written after a successful run only.
  if (installedEngine !== undefined) saveEngineVersion(genStateDir, installedEngine);

  return { files: writes, warnings, conflicts };
}

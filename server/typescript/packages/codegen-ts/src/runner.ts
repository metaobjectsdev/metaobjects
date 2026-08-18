import { join, relative, resolve, isAbsolute, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import type { MetaData, MetaObject } from "@metaobjectsdev/metadata";
import { isMetaRoot, OBJECT_SUBTYPE_VALUE, FIELD_SUBTYPE_TIMESTAMP, FIELD_ATTR_FILTERABLE } from "@metaobjectsdev/metadata";
import { assignEmittedNames } from "./naming/collision-names.js";
import { isAbstract } from "./instance-artifacts.js";
import { hasAnyRdbSource } from "./source-detect.js";
import type { Generator, GenContext, EmittedFile } from "./generator.js";
import type { MetaobjectsGenConfig } from "./metaobjects-config.js";
import { normalizeConfig, DEFAULT_TARGET_NAME } from "./metaobjects-config.js";
import type { ResolvedTarget } from "./import-path.js";
import { buildPkMap } from "./pk-resolver.js";
import { buildRelationMap } from "./relation-resolver.js";
import { makeRenderContext } from "./render-context.js";
import {
  decideAndWrite,
  loadEngineVersion,
  saveEngineVersion,
  type WriteResult,
  type MergeStrategy,
  type BaselineMode,
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
  // source.rdb genuinely needs them. Only a sourced object emits database
  // artifacts (schema / query / route code), and every generator below gates
  // that emission on hasAnyRdbSource — the #248 R2 source-based predicate — so a
  // sourceless object (a value object, or a sourceless projection) emits zero DB
  // code. Guard BEFORE normalizeConfig fills its inert defaults, so a DB project
  // that forgot either gets a clear error naming the objects, never
  // silently-defaulted output (e.g. a Postgres project quietly emitting sqlite).
  // A model of only value objects and/or sourceless projections reaches
  // normalizeConfig and gets the harmless placeholders.
  const dbEmittingObjects = safeEntities.filter(
    (e) => !e.isAbstract && hasAnyRdbSource(e),
  );
  if (dbEmittingObjects.length > 0) {
    const missing: string[] = [];
    if (opts.config.dialect === undefined) missing.push("dialect");
    if (opts.config.dbImport === undefined) missing.push("dbImport");
    if (missing.length > 0) {
      const names = dbEmittingObjects.map((e) => e.name).join(", ");
      throw new Error(
        `codegen config is missing ${missing.join(" and ")} — required because this model ` +
          `generates database code for: ${names}. Set ${missing.join(" and ")} in ` +
          `metaobjects.config.ts. (A model of only value objects and/or sourceless projections may omit them.)`,
      );
    }
  }

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

  const needsCrossTarget = config.generators.some(
    (g) => (g.target ?? DEFAULT_TARGET_NAME) !== entityModuleTarget.name,
  );
  if (needsCrossTarget && entityModuleTarget.importBase === undefined) {
    throw new Error(
      `Target "${entityModuleTarget.name}" holds the entity modules that other ` +
      `targets import, but has no importBase. Set importBase on it (e.g. ` +
      `"@your-pkg/database/generated").`,
    );
  }

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

  // 4. Run each generator with a per-target render context; collect with full path.
  const emitted: { fullPath: string; content: string; generatedBy: string }[] = [];
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
      apiPrefix: config.apiPrefix,
      emitAbstractShapes: config.emitAbstractShapes,
      outputLayout: selfTarget.outputLayout,
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
      },
      renderContext,
      ...(projectRoot !== undefined && { projectRoot }),
      warn: (msg) => warnings.push(`[${generator.name}] ${msg}`),
    };

    let files: EmittedFile[];
    try {
      files = await generator.generate(ctx);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`[${generator.name}] ${msg}`);
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

  // --dry-run: report what WOULD be written and touch nothing — no output files
  // and no .gen-state/ snapshot (writing the snapshot would silently re-baseline
  // the merge base, so a later real run could skip a genuinely-needed write).
  if (opts.dryRun === true) {
    for (const file of emitted) {
      // Report the outcome faithfully rather than a placeholder: a path that does
      // not exist yet would be created ("new"), one that does would be rewritten.
      // Merge/conflict outcomes can't be known without doing the merge, so this
      // deliberately reports the coarser truth instead of guessing.
      writes.push({ path: file.fullPath, status: existsSync(file.fullPath) ? "overwrite" : "new" });
    }
    return { files: writes, warnings, conflicts };
  }

  for (const file of emitted) {
    // Key the snapshot by project-relative path so multi-target projects keep
    // distinct entries (e.g. `database/Post.ts` vs `web/Post.queries.ts`).
    // Without an explicit projectRoot we let decideAndWrite derive a stable
    // hash-of-path key — fine for ephemeral test runs.
    const policyOpts: import("./overwrite-policy.js").DecideAndWriteOpts = {
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
    if (result.status === "refused") {
      warnings.push(
        `Refused to overwrite ${file.fullPath}: file exists without @generated header. ` +
        `Move to a different outDir, delete the file, or add the header to opt in.`,
      );
    }
  }

  // #232 — stamp the engine version that produced this snapshot, so the NEXT gen can
  // detect an engine change. Written after a successful run only.
  if (installedEngine !== undefined) saveEngineVersion(genStateDir, installedEngine);

  return { files: writes, warnings, conflicts };
}

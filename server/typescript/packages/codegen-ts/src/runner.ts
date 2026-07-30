import { join, relative, resolve, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import type { MetaData, MetaObject } from "@metaobjectsdev/metadata";
import { MetaRoot, OBJECT_SUBTYPE_VALUE } from "@metaobjectsdev/metadata";
import { assignEmittedNames } from "./naming/collision-names.js";
import { isAbstract } from "./instance-artifacts.js";
import type { Generator, GenContext, EmittedFile } from "./generator.js";
import type { MetaobjectsGenConfig } from "./metaobjects-config.js";
import { normalizeConfig, DEFAULT_TARGET_NAME } from "./metaobjects-config.js";
import type { ResolvedTarget } from "./import-path.js";
import { buildPkMap } from "./pk-resolver.js";
import { buildRelationMap } from "./relation-resolver.js";
import { makeRenderContext } from "./render-context.js";
import {
  decideAndWrite,
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
}

export interface RunGenResult {
  files: WriteResult[];
  warnings: string[];
  /** Subset of `files` with status "conflict" — surfaced separately so the
   *  CLI can print the end-of-run summary. */
  conflicts: WriteResult[];
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

  // loadMemory now returns MetaRoot; guard here also covers callers that pass a
  // plain MetaData (e.g. test helpers that build trees programmatically).
  if (!(opts.metadata instanceof MetaRoot)) {
    throw new Error("runGen: opts.metadata must be a loaded MetaRoot.");
  }
  const root = opts.metadata;

  // 1. Resolve entities (filter + safety check).
  const allObjects = root.objects();
  const entityFilter = opts.entityFilter;
  const filtered = entityFilter
    ? allObjects.filter((o) => entityFilter.includes(o.name))
    : allObjects;
  if (filtered.length === 0) {
    const reason = opts.entityFilter
      ? "no object children match the provided entityFilter"
      : "root has no object children";
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

  // 2. Resolve targets + entity-module target.
  const config = normalizeConfig(opts.config);
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

  return { files: writes, warnings, conflicts };
}

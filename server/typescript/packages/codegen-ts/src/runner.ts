import { join, relative, resolve, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import type { MetaData, MetaObject } from "@metaobjectsdev/metadata";
import { MetaRoot } from "@metaobjectsdev/metadata";
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
  const packageOf = new Map<string, string | undefined>(
    root.objects().map((o) => [o.name, o.package]),
  );

  // 4. Run each generator with a per-target render context; collect with full path.
  const emitted: { fullPath: string; content: string; generatedBy: string }[] = [];
  for (const generator of config.generators) {
    const selfTarget = targetOf(generator);
    const renderContext = makeRenderContext({
      dialect: config.dialect,
      loadedRoot: root,
      outDir: selfTarget.outDir,
      dbImport: selfTarget.dbImport,
      extStyle: config.extStyle,
      columnNamingStrategy: config.columnNamingStrategy,
      apiPrefix: config.apiPrefix,
      emitAbstractShapes: config.emitAbstractShapes,
      outputLayout: selfTarget.outputLayout,
      pkMap,
      relationMap,
      packageOf,
      selfTarget,
      entityModuleTarget,
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
      const fullPath = join(selfTarget.outDir, file.path);
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

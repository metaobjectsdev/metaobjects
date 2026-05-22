import { join } from "node:path";
import type { MetaData, MetaObject } from "@metaobjectsdev/metadata";
import { MetaRoot } from "@metaobjectsdev/metadata";
import type { Generator, GenContext, EmittedFile } from "./generator.js";
import type { MetaobjectsGenConfig } from "./metaobjects-config.js";
import { normalizeConfig, DEFAULT_TARGET_NAME } from "./metaobjects-config.js";
import type { ResolvedTarget } from "./import-path.js";
import { buildPkMap } from "./pk-resolver.js";
import { buildRelationMap } from "./relation-resolver.js";
import { makeRenderContext } from "./render-context.js";
import { decideAndWrite, type WriteResult, type MergeStrategy } from "./overwrite-policy.js";

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
}

export interface RunGenResult {
  files: WriteResult[];
  warnings: string[];
}

export async function runGen(opts: RunGenOpts): Promise<RunGenResult> {
  const warnings: string[] = [];
  const strategy = opts.mergeStrategy ?? "overwrite";

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
    return { files: [], warnings };
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
    return { files: [], warnings };
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
  for (const file of emitted) {
    const result = decideAndWrite(file.fullPath, file.content, strategy);
    writes.push(result);
    if (result.status === "refused") {
      warnings.push(
        `Refused to overwrite ${file.fullPath}: file exists without @generated header. ` +
        `Move to a different outDir, delete the file, or add the header to opt in.`,
      );
    }
  }

  return { files: writes, warnings };
}

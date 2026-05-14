import { join } from "node:path";
import type { MetaModel } from "@metaobjects/metadata";
import { TYPE_OBJECT } from "@metaobjects/metadata";
import type { Generator, GenContext, EmittedFile } from "./generator.js";
import type { ForgeConfig } from "./forge-config.js";
import { normalizeConfig } from "./forge-config.js";
import { buildPkMap } from "./pk-resolver.js";
import { buildRelationMap } from "./relation-resolver.js";
import { makeRenderContext } from "./render-context.js";
import { decideAndWrite, type WriteResult, type MergeStrategy } from "./overwrite-policy.js";

/** JS-identifier-shape only. Prevents filesystem traversal when metadata comes
 *  from untrusted sources (e.g. MCP). Mirrors the guard in legacy generate.ts. */
const VALID_ENTITY_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface RunGenOpts {
  config: ForgeConfig;
  metadata: MetaModel;
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

  // 1. Resolve entities (filter + safety check).
  const allObjects = opts.metadata.children().filter((c) => c.type === TYPE_OBJECT);
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

  const safeEntities: MetaModel[] = [];
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

  // 2. Build the shared RenderContext (computed once per run).
  const config = normalizeConfig(opts.config);
  const pkMap = buildPkMap(opts.metadata);
  const relationMap = buildRelationMap(opts.metadata);
  const renderContext = makeRenderContext({
    dialect: config.dialect,
    loadedRoot: opts.metadata,
    outDir: config.outDir,
    dbImport: config.dbImport,
    extStyle: config.extStyle,
    columnNamingStrategy: config.columnNamingStrategy,
    apiPrefix: config.apiPrefix,
    pkMap,
    relationMap,
  });

  // 3. Run each generator sequentially.
  const emitted: EmittedFile[] = [];
  for (const generator of config.generators) {
    const ctx: GenContext = {
      entities: safeEntities,
      loadedRoot: opts.metadata,
      matches: (e) => generator.filter?.(e) ?? true,
      config: {
        outDir: config.outDir,
        extStyle: config.extStyle,
        dbImport: config.dbImport,
        dialect: config.dialect,
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
      const collision = emitted.find((prev) => prev.path === file.path);
      if (collision) {
        throw new Error(
          `Output path collision: "${file.path}" emitted by both ` +
          `"${collision.generatedBy}" and "${generator.name}". ` +
          `Adjust one generator's filter or output path.`,
        );
      }
      emitted.push({ ...file, generatedBy: generator.name });
    }
  }

  // 4. Write phase.
  const writes: WriteResult[] = [];
  for (const file of emitted) {
    const fullPath = join(config.outDir, file.path);
    const result = decideAndWrite(fullPath, file.content, strategy);
    writes.push(result);
    if (result.status === "refused") {
      warnings.push(
        `Refused to overwrite ${fullPath}: file exists without @generated header. ` +
        `Move to a different outDir, delete the file, or add the header to opt in.`,
      );
    }
  }

  return { files: writes, warnings };
}

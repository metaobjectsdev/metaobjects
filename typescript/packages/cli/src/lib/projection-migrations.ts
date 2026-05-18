import {
  resolveTableName,
  MetaRoot,
  type MetaData,
} from "@metaobjects/metadata";
import {
  isProjection,
  extractViewSpec,
  emitViewDdl,
} from "@metaobjects/codegen-ts";
import {
  computeViewMigrations,
  type ViewMigrationInput,
  type ViewMigrationsResult,
} from "@metaobjects/migrate-ts";

export interface ProjectionMigrationsOpts {
  readonly metadata: MetaData;
  readonly dialect: "postgres" | "sqlite";
  readonly allowBreaking?: boolean;
  /** Column naming strategy forwarded to extractViewSpec. Defaults to "snake_case". */
  readonly columnNamingStrategy?: "snake_case" | "literal" | "kebab-case";
}

/**
 * Walk all projection entities in metadata, extract their ViewSpec, emit CREATE
 * VIEW DDL, and compute view migration SQL via computeViewMigrations.
 *
 * Currently treats every projection as a new view (no previous-shape tracking).
 * Future: introspect existing views from the live DB to do safe-append/replace
 * detection.
 */
export function computeProjectionMigrations(
  opts: ProjectionMigrationsOpts,
): ViewMigrationsResult {
  // loadMemory now returns MetaRoot; guard here also covers callers that pass a
  // plain MetaData (e.g. test helpers or external callers with non-MetaRoot roots).
  if (!(opts.metadata instanceof MetaRoot)) {
    throw new Error("computeProjectionMigrations: opts.metadata must be a loaded MetaRoot.");
  }
  const root = opts.metadata;
  const columnNamingStrategy = opts.columnNamingStrategy ?? "snake_case";

  // Collect all writable entities for table name resolution.
  const joinTables: Record<string, string> = {};
  for (const obj of root.objects()) {
    joinTables[obj.name] = resolveTableName(obj);
  }

  // Find projection entities.
  const projections = root.objects().filter(isProjection);

  if (projections.length === 0) {
    return { migrations: [], errors: [] };
  }

  const views: ViewMigrationInput[] = [];
  for (const projection of projections) {
    const spec = extractViewSpec(projection, root, { columnNamingStrategy });

    const baseTableName = joinTables[spec.joinTree.baseEntity];
    if (!baseTableName) {
      return {
        migrations: [],
        errors: [
          `Projection ${projection.name}: base entity "${spec.joinTree.baseEntity}" has no resolvable table name.`,
        ],
      };
    }

    const createSql = emitViewDdl(spec, {
      dialect: opts.dialect,
      baseTableName,
      joinTables,
    });

    views.push({
      viewName: spec.viewName,
      // prevShape intentionally absent — treated as "safe-append" by
      // computeViewMigrations (source-aware-diff.ts line 32). On Postgres
      // this rewrites the emitted "CREATE VIEW" to "CREATE OR REPLACE VIEW",
      // so re-running migrate is idempotent. Future: introspect existing views
      // via pg_views / sqlite_master for true safe-replace/breaking detection.
      nextShape: {
        columns: spec.selectSpec.columns.map((c) => c.dbColAlias),
      },
      createSql,
    });
  }

  return computeViewMigrations({
    dialect: opts.dialect,
    allowBreaking: opts.allowBreaking ?? false,
    views,
  });
}

import {
  resolveTableName,
  MetaRoot,
  type MetaData,
} from "@metaobjectsdev/metadata";
import {
  isProjection,
  extractViewSpec,
  emitViewDdl,
} from "@metaobjectsdev/codegen-ts";
import {
  computeViewMigrations,
  viewSqlEquals,
  type ViewMigrationInput,
  type ViewMigrationsResult,
} from "@metaobjectsdev/migrate-ts";
import type { Dialect } from "./kysely.js";

/** view-name → set of source-table names the view's SELECT depends on. */
export type ProjectionViewDependencies = ReadonlyMap<string, ReadonlySet<string>>;

export interface ProjectionMigrationsOpts {
  readonly metadata: MetaData;
  readonly dialect: Dialect;
  readonly allowBreaking?: boolean;
  /** Column naming strategy forwarded to extractViewSpec. Defaults to "snake_case". */
  readonly columnNamingStrategy?: "snake_case" | "literal" | "kebab-case";
  /**
   * Existing view SQL keyed by view name (from sqlite_master.sql or
   * pg_views.definition). When provided, projections whose emitted CREATE
   * SQL matches the existing definition (whitespace-normalized) are skipped
   * — no DROP+CREATE noise for unchanged views.
   */
  readonly existingViewSql?: ReadonlyMap<string, string>;
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
  // D1 is SQLite at the SQL level; normalize before passing to downstream emitters.
  const dialect: "postgres" | "sqlite" = opts.dialect === "d1" ? "sqlite" : opts.dialect;
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
      dialect,
      baseTableName,
      joinTables,
    });

    // Skip if the existing DB view's CREATE SQL matches what we'd emit.
    // Avoids the "every migration re-creates every view" noise when nothing
    // about the view's body actually changed.
    const existing = opts.existingViewSql?.get(spec.viewName);
    if (existing !== undefined && viewSqlEquals(existing, createSql)) {
      continue;
    }

    views.push({
      viewName: spec.viewName,
      // prevShape intentionally absent — treated as "safe-append" by
      // computeViewMigrations (source-aware-diff.ts line 32). On Postgres
      // this rewrites the emitted "CREATE VIEW" to "CREATE OR REPLACE VIEW",
      // so re-running migrate is idempotent.
      nextShape: {
        columns: spec.selectSpec.columns.map((c) => c.dbColAlias),
      },
      createSql,
    });
  }

  return computeViewMigrations({
    dialect,
    allowBreaking: opts.allowBreaking ?? false,
    views,
  });
}

/**
 * For each projection view, compute the set of source table names that the
 * view's SELECT depends on (base entity + all joined entities). Used by the
 * CLI to pre-drop only the views whose source tables are being recreated.
 */
export function computeProjectionViewDependencies(
  opts: Pick<ProjectionMigrationsOpts, "metadata" | "columnNamingStrategy">,
): ProjectionViewDependencies {
  if (!(opts.metadata instanceof MetaRoot)) {
    throw new Error("computeProjectionViewDependencies: opts.metadata must be a loaded MetaRoot.");
  }
  const root = opts.metadata;
  const columnNamingStrategy = opts.columnNamingStrategy ?? "snake_case";

  const tableByEntity: Record<string, string> = {};
  for (const obj of root.objects()) {
    tableByEntity[obj.name] = resolveTableName(obj);
  }

  const result = new Map<string, Set<string>>();
  const projections = root.objects().filter(isProjection);

  for (const projection of projections) {
    const spec = extractViewSpec(projection, root, { columnNamingStrategy });
    const tables = new Set<string>();
    const baseTable = tableByEntity[spec.joinTree.baseEntity];
    if (baseTable) tables.add(baseTable);
    const walk = (joins: readonly typeof spec.joinTree.joins[number][]): void => {
      for (const j of joins) {
        const t = tableByEntity[j.targetEntity];
        if (t) tables.add(t);
        walk(j.children);
      }
    };
    walk(spec.joinTree.joins);
    result.set(spec.viewName, tables);
  }

  return result;
}

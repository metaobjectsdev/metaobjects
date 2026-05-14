import { classifyViewDiff, type ViewShape } from "./view-diff.js";
import { emitPostgresViewMigration } from "./view-ddl-postgres.js";
import { emitSqliteViewMigration } from "./view-ddl-sqlite.js";

export interface ViewMigrationInput {
  readonly viewName: string;
  /** Previous view shape (from migration log / prior generation). undefined = new view. */
  readonly prevShape?: ViewShape;
  readonly nextShape: ViewShape;
  /** Full `CREATE VIEW ... AS ...;` SQL for nextShape. */
  readonly createSql: string;
}

export interface ViewMigrationsOpts {
  readonly dialect: "postgres" | "sqlite";
  readonly allowBreaking: boolean;
  readonly views: readonly ViewMigrationInput[];
}

export interface ViewMigrationsResult {
  readonly migrations: readonly string[];
  readonly errors: readonly string[];
}

export function computeViewMigrations(opts: ViewMigrationsOpts): ViewMigrationsResult {
  const migrations: string[] = [];
  const errors: string[] = [];

  for (const view of opts.views) {
    const diffClass = view.prevShape
      ? classifyViewDiff(view.prevShape, view.nextShape)
      : "safe-append";  // new view = treated like safe-append

    if (diffClass === "breaking" && !opts.allowBreaking) {
      errors.push(
        `View ${view.viewName} has a breaking change. Pass --allow-breaking to allow drop+recreate.`
      );
      continue;
    }

    const emit = opts.dialect === "postgres"
      ? emitPostgresViewMigration
      : emitSqliteViewMigration;
    const sql = emit({ diffClass, viewName: view.viewName, createSql: view.createSql });
    if (sql) migrations.push(sql);
  }

  return { migrations, errors };
}

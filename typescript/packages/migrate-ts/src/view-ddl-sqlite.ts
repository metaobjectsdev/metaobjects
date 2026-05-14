import type { ViewMigrationOpts } from "./view-diff.js";

export function emitSqliteViewMigration(opts: ViewMigrationOpts): string {
  if (opts.diffClass === "no-change") return "";
  // SQLite has no CREATE OR REPLACE VIEW; must drop+create. Wrap in txn.
  return `BEGIN;\nDROP VIEW IF EXISTS ${opts.viewName};\n${opts.createSql}\nCOMMIT;`;
}

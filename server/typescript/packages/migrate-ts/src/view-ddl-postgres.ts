import type { ViewMigrationOpts } from "./view-diff.js";

export { type ViewMigrationOpts } from "./view-diff.js";

export function emitPostgresViewMigration(opts: ViewMigrationOpts): string {
  switch (opts.diffClass) {
    case "no-change": return "";
    case "safe-append":
    case "safe-replace":
      // Replace CREATE VIEW with CREATE OR REPLACE VIEW.
      return opts.createSql.replace(/^CREATE VIEW\b/i, "CREATE OR REPLACE VIEW");
    case "breaking":
      return `DROP VIEW IF EXISTS ${opts.viewName} CASCADE;\n${opts.createSql}`;
  }
}

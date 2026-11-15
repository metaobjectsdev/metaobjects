// `@metaobjectsdev/migrate-ts/offline` — the part of the schema engine that never opens a
// database: build the expected schema, diff it against a committed snapshot, and name what
// a change would need. `meta gen` and the other commands that touch no database import
// from here, so loading them loads no query builder and no driver. The package root
// re-exports all of this beside the parts that do connect (introspect, apply, replay).
export { buildExpectedSchemaWithProvenance } from "./expected-schema.js";
export { diff } from "./diff/index.js";
export { resolveSchemaConventions, type SchemaConventions } from "./schema-conventions.js";
export { qualifiedDbName } from "./qualified-name.js";
export { columnTypeSql } from "./column-type-sql.js";
export { withoutFlywayHistory } from "./write-migration-flyway.js";
export { snapshotPath, readSnapshot } from "./snapshot/store.js";
export { allowOptionFor, isUnknownSchemaConventionsError } from "./errors.js";
export { suggestColumnRenames, type ColumnRenameSuggestion } from "./diff/rename-suggestions.js";
export { describeSqlType } from "./sql-type.js";
export { isViewRecreateOnly, viewsNamingRenamedColumns } from "./view-change-reason.js";
export { findWranglerConfig, parseWranglerConfig, type D1Binding } from "./wrangler-config.js";
export type { AllowOptions, Change, ViewChangeReason } from "./types.js";

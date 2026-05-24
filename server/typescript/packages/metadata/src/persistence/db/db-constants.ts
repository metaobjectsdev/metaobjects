// DB concern constants — physical DB column attr keys.

/** Custom DB column name override on a field (maps to @dbColumn in metadata). */
export const FIELD_ATTR_DB_COLUMN = "dbColumn";
/** Source v2 (ADR-0007): column name override on a field (replaces the v1 @dbColumn). */
export const FIELD_ATTR_COLUMN = "column";
/** When true, suppress the @filterable-without-index Loader warning (Project D drift check). */
export const FIELD_ATTR_DB_INDEXED = "db.indexed";

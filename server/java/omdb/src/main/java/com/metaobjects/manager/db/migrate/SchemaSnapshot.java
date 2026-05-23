package com.metaobjects.manager.db.migrate;

import java.util.List;

/**
 * A snapshot of a schema — same shape for expected (metadata-derived) and actual (DB-introspected).
 * Port of the snapshot half of migrate-ts types.ts.
 *
 * Per spec §5.1.
 */
public record SchemaSnapshot(List<TableDescriptor> tables, List<ViewDescriptor> views) {

    /** schema == null means the dialect default (Postgres "public"; SQLite/Derby have no schema concept). */
    public record TableDescriptor(
            String name,
            String schema,
            List<ColumnDescriptor> columns,
            List<IndexDescriptor> indexes,
            List<FkDescriptor> foreignKeys,
            List<String> primaryKey) {}

    /** identity: "increment" | "uuid" | null. default is informational in v1. */
    public record ColumnDescriptor(String name, SqlType sqlType, boolean nullable, String identity) {}

    public record IndexDescriptor(String name, List<String> columns, boolean unique) {}

    public record FkDescriptor(
            String name,
            List<String> columns,
            String refTable,
            List<String> refColumns,
            String onDelete,
            String onUpdate) {}

    public record ViewDescriptor(String name, String schema, String sql) {}
}

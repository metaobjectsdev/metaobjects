package com.metaobjects.manager.db.migrate;

import com.metaobjects.manager.db.migrate.SchemaSnapshot.*;

import java.sql.*;
import java.util.*;

/**
 * Reads the live schema via {@link DatabaseMetaData} into a {@link SchemaSnapshot} (the "actual"
 * side of the diff).
 *
 * <p>Derby note: passing {@code schemaPattern=null} to {@code getTables} with
 * {@code types={"TABLE"}} excludes SYSTEM TABLEs in Derby. However, when {@code schema} is null
 * we resolve the connection's current schema via {@code Connection.getSchema()} (returns "APP"
 * for embedded Derby by default) and use it as the schema pattern. This avoids any system-table
 * pollution that could occur across JDBC drivers where null-schema means "all schemas".
 */
public final class SchemaIntrospector {

    /**
     * Introspects the live schema reachable via {@code c}.
     *
     * @param c      open JDBC connection
     * @param schema DB schema to scan; when null the connection's default schema is used
     * @return canonical snapshot of all user tables in the target schema
     */
    public SchemaSnapshot introspect(Connection c, String schema) throws SQLException {
        // Resolve schema: prefer the caller-supplied value; fall back to the connection's current
        // schema so that null-schema does not accidentally pull in system tables across drivers.
        String effectiveSchema = (schema != null) ? schema : resolveSchema(c);

        DatabaseMetaData md = c.getMetaData();
        List<TableDescriptor> tables = new ArrayList<>();

        try (ResultSet ts = md.getTables(null, effectiveSchema, "%", new String[]{"TABLE"})) {
            while (ts.next()) {
                String name = ts.getString("TABLE_NAME");
                List<ColumnDescriptor> cols = readColumns(md, effectiveSchema, name);
                List<String> pk = readPrimaryKey(md, effectiveSchema, name);
                tables.add(new TableDescriptor(name, effectiveSchema, cols, List.of(), List.of(), pk));
            }
        }

        return new SchemaSnapshot(tables, List.of());
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    /**
     * Returns the connection's current schema, or null if the driver does not support it.
     * For embedded Derby the default user schema is "APP".
     */
    private static String resolveSchema(Connection c) {
        try {
            return c.getSchema();
        } catch (SQLException e) {
            // Driver does not support Connection.getSchema(); proceed with null (driver default).
            return null;
        }
    }

    private static List<ColumnDescriptor> readColumns(DatabaseMetaData md, String schema, String table)
            throws SQLException {
        List<ColumnDescriptor> cols = new ArrayList<>();
        try (ResultSet cs = md.getColumns(null, schema, table, "%")) {
            while (cs.next()) {
                SqlType type = JdbcSqlTypes.fromJdbc(
                        cs.getInt("DATA_TYPE"),
                        cs.getInt("COLUMN_SIZE"));
                boolean nullable = "YES".equalsIgnoreCase(cs.getString("IS_NULLABLE"));
                cols.add(new ColumnDescriptor(cs.getString("COLUMN_NAME"), type, nullable, null));
            }
        }
        return cols;
    }

    private static List<String> readPrimaryKey(DatabaseMetaData md, String schema, String table)
            throws SQLException {
        List<String> pk = new ArrayList<>();
        try (ResultSet ks = md.getPrimaryKeys(null, schema, table)) {
            while (ks.next()) pk.add(ks.getString("COLUMN_NAME"));
        }
        return pk;
    }
}

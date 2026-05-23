package com.metaobjects.manager.db.migrate;

import java.sql.Types;

/**
 * Single source of truth for java.sql.Types &lt;-&gt; canonical SqlType
 * (used by both the expected-snapshot builder and the DB introspector).
 */
public final class JdbcSqlTypes {
    private JdbcSqlTypes() {}

    /** Convert a java.sql.Types value (+ column length) to a canonical SqlType. */
    public static SqlType fromJdbc(int jdbcType, int length) {
        switch (jdbcType) {
            case Types.BOOLEAN:
            case Types.BIT:
                return new SqlType.Bool();
            case Types.TINYINT:
            case Types.SMALLINT:
            case Types.INTEGER:
                return new SqlType.Int(32);
            case Types.BIGINT:
                return new SqlType.Int(64);
            case Types.FLOAT:
            case Types.REAL:
            case Types.DOUBLE:
                return new SqlType.Real();
            case Types.NUMERIC:
            case Types.DECIMAL:
                return new SqlType.Numeric(null, null);
            case Types.TIMESTAMP:
            case Types.TIMESTAMP_WITH_TIMEZONE:
                return new SqlType.Timestamp(true);
            case Types.DATE:
                return new SqlType.Date();
            case Types.BLOB:
            case Types.VARBINARY:
            case Types.LONGVARBINARY:
                return new SqlType.Blob();
            case Types.VARCHAR:
            case Types.CHAR:
            case Types.LONGVARCHAR:
            case Types.CLOB:
                return new SqlType.Text(length > 0 ? length : null);
            default:
                // Conservative fallback: treat as text with declared length
                return new SqlType.Text(length > 0 ? length : null);
        }
    }
}

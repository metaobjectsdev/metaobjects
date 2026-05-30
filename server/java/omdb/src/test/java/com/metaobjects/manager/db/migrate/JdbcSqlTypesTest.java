package com.metaobjects.manager.db.migrate;

import org.junit.Test;

import java.sql.Types;

import static org.junit.Assert.assertEquals;

/**
 * R6: java.sql.Types FLOAT/REAL route to {@link SqlType.Real4} (float4, single precision);
 * DOUBLE routes to {@link SqlType.Real} (float8). This single mapping point is shared by both
 * the expected-snapshot builder and the DB introspector, so the split round-trips cleanly.
 */
public class JdbcSqlTypesTest {
    @Test public void floatAndReal_mapToReal4() {
        assertEquals(new SqlType.Real4(), JdbcSqlTypes.fromJdbc(Types.FLOAT, 0));
        assertEquals(new SqlType.Real4(), JdbcSqlTypes.fromJdbc(Types.REAL, 0));
    }
    @Test public void double_mapsToReal() {
        assertEquals(new SqlType.Real(), JdbcSqlTypes.fromJdbc(Types.DOUBLE, 0));
    }
}

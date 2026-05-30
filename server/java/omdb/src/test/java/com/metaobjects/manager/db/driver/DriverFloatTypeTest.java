package com.metaobjects.manager.db.driver;

import com.metaobjects.manager.db.migrate.SqlType;
import org.junit.Test;

import static org.junit.Assert.assertEquals;

/**
 * R6: REAL (float4, field.float) renders distinctly from DOUBLE (float8, field.double)
 * per dialect. Guards against the two arms collapsing back to a single floating type.
 */
public class DriverFloatTypeTest {
    @Test public void postgres_real4_is_REAL_and_real_is_DOUBLE_PRECISION() {
        PostgresDriver pg = new PostgresDriver();
        assertEquals("REAL", pg.pgType(new SqlType.Real4()));
        assertEquals("DOUBLE PRECISION", pg.pgType(new SqlType.Real()));
    }
    @Test public void derby_real4_is_REAL_and_real_is_DOUBLE() {
        DerbyDriver derby = new DerbyDriver();
        assertEquals("REAL", derby.derbyType(new SqlType.Real4()));
        assertEquals("DOUBLE", derby.derbyType(new SqlType.Real()));
    }
}

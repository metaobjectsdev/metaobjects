/*
 * Copyright 2003 Doug Mealing LLC dba Meta Objects. All Rights Reserved.
 *
 * This software is the proprietary information of Doug Mealing LLC dba Meta Objects.
 * Use is subject to license terms.
 */
package com.metaobjects.manager.db.driver;

import com.metaobjects.manager.exp.Range;
import org.junit.Test;

import static org.junit.Assert.*;

/**
 * Verifies OracleDriver emits standard ANSI OFFSET/FETCH paging (Oracle 12c+)
 * for all ranges. The legacy ROWNUM form -- which produced a dangling
 * "AND ROWNUM <= N" appended after ORDER BY -- must be gone.
 */
public class OracleDriverPagingTest {

    private final OracleDriver driver = new OracleDriver();

    @Test
    public void firstPageUsesOffsetFetch() {
        String sql = driver.getRangeString(new Range(1, 25));
        assertEquals("OFFSET 0 ROWS FETCH NEXT 25 ROWS ONLY", sql);
    }

    @Test
    public void offsetPageUsesOffsetFetch() {
        String sql = driver.getRangeString(new Range(11, 20));
        assertEquals("OFFSET 10 ROWS FETCH NEXT 10 ROWS ONLY", sql);
    }

    @Test
    public void noDanglingRownum() {
        String sql = driver.getRangeString(new Range(1, 10));
        assertFalse("dangling AND ROWNUM bug must be gone: " + sql,
                sql.toUpperCase().contains("ROWNUM"));
        assertFalse("range clause must not begin with AND: " + sql,
                sql.trim().toUpperCase().startsWith("AND"));
    }

    @Test
    public void rangeRequiresOrderByHook() {
        assertTrue("Oracle OFFSET/FETCH requires an ORDER BY", driver.rangeRequiresOrderBy());
        assertNotNull(driver.getDefaultRangeOrderBy());
        assertTrue(driver.getDefaultRangeOrderBy().toUpperCase().startsWith("ORDER BY"));
    }
}

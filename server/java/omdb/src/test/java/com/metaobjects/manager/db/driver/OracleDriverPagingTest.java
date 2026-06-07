/*
 * Copyright 2003 Doug Mealing LLC dba Meta Objects
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
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

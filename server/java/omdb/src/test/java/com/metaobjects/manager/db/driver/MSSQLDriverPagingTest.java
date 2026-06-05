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
 * Verifies MSSQLDriver emits standard ANSI OFFSET/FETCH paging (SQL Server 2012+)
 * for all ranges -- including the first-page case that previously returned an
 * empty string relying on a never-wired-up TOP clause.
 */
public class MSSQLDriverPagingTest {

    private final MSSQLDriver driver = new MSSQLDriver();

    @Test
    public void firstPageUsesOffsetFetch() {
        // Range(1, 25) -> offset 0, fetch 25
        String sql = driver.getRangeString(new Range(1, 25));
        assertTrue("first page must use OFFSET: " + sql, sql.contains("OFFSET 0 ROWS"));
        assertTrue("first page must use FETCH NEXT: " + sql, sql.contains("FETCH NEXT 25 ROWS ONLY"));
        assertFalse("legacy TOP must be gone: " + sql, sql.toUpperCase().contains("TOP "));
        assertEquals("OFFSET 0 ROWS FETCH NEXT 25 ROWS ONLY", sql);
    }

    @Test
    public void offsetPageUsesOffsetFetch() {
        // Range(11, 20) -> offset 10, fetch 10
        String sql = driver.getRangeString(new Range(11, 20));
        assertEquals("OFFSET 10 ROWS FETCH NEXT 10 ROWS ONLY", sql);
    }

    @Test
    public void rangeRequiresOrderByHook() {
        assertTrue("MSSQL OFFSET/FETCH requires an ORDER BY", driver.rangeRequiresOrderBy());
        assertNotNull(driver.getDefaultRangeOrderBy());
        assertTrue(driver.getDefaultRangeOrderBy().toUpperCase().startsWith("ORDER BY"));
    }
}

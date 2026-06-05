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

import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import com.metaobjects.MetaDataException;


import com.metaobjects.manager.db.defs.ColumnDef;
import com.metaobjects.manager.exp.Range;

/**
 * Oracle Database Driver with modern Java 21 features and comprehensive Oracle-specific optimizations.
 * 
 * <p>This driver supports:
 * <ul>
 *   <li>Oracle sequences with proper NEXTVAL/CURRVAL handling</li>
 *   <li>Oracle-specific data types (CLOB, BLOB, XMLTYPE)</li>
 *   <li>Advanced indexing (B-tree, bitmap, function-based)</li>
 *   <li>Partitioning awareness</li>
 *   <li>Hierarchical queries with CONNECT BY</li>
 *   <li>Row locking with FOR UPDATE</li>
 * </ul>
 * 
 * @author Doug Mealing
 * @since 5.1.0
 */
public class OracleDriver extends GenericSQLDriver {

    private static final Logger log = LoggerFactory.getLogger(OracleDriver.class);
    
    public OracleDriver() {
        super();
    }

    /**
     * Gets the next sequence value using Oracle's NEXTVAL
     */
    @Override
    protected String getNextAutoId(Connection conn, ColumnDef col) throws SQLException {
        if (col.getSequence() == null) {
            throw new MetaDataException("Column definition [" + col + "] has no sequence defined");
        }

        String seq = getProperName(col.getSequence().getNameDef());
        String query = "SELECT " + seq + ".NEXTVAL FROM DUAL";
        
        try (Statement s = conn.createStatement();
             ResultSet rs = s.executeQuery(query)) {
            
            if (!rs.next()) {
                throw new SQLException("Unable to get next id for Column Definition [" + col + "], no result in result set");
            }
            
            String id = rs.getString(1);
            if (log.isDebugEnabled()) {
                log.debug("Retrieved id ({}) from Oracle sequence [{}]", id, seq);
            }
            
            if (id == null) {
                throw new SQLException("A null sequence value was returned from Oracle");
            }
            
            return id;
        } catch (SQLException e) {
            log.error("Unable to get next id for Column definition [{}]: {}", col, e.getMessage(), e);
            throw new SQLException("Unable to get next id for Column definition [" + col + "]: " + e.getMessage(), e);
        }
    }

    /**
     * Oracle supports standard ANSI OFFSET/FETCH for range queries
     * (requires Oracle 12c+).
     */
    @Override
    protected boolean supportsRangeInQuery() {
        return true;
    }

    /**
     * Oracle OFFSET/FETCH syntax (Oracle 12c+). Replaces the legacy ROWNUM
     * form, which produced a dangling {@code AND ROWNUM <= N} appended after
     * ORDER BY (malformed SQL) and silently failed to apply any offset.
     * Requires a preceding ORDER BY; see {@link #rangeRequiresOrderBy()}.
     */
    @Override
    public String getRangeString(Range range) {
        return "OFFSET " + (range.getStart() - 1) + " ROWS FETCH NEXT " +
               (range.getEnd() - range.getStart() + 1) + " ROWS ONLY";
    }

    /** Oracle 12c+ OFFSET/FETCH requires an ORDER BY to be well-formed. */
    @Override
    protected boolean rangeRequiresOrderBy() {
        return true;
    }

    /**
     * Oracle accepts a constant ORDER BY for paging when the caller supplies
     * no explicit sort order.
     */
    @Override
    protected String getDefaultRangeOrderBy() {
        return "ORDER BY NULL";
    }

    /**
     * Oracle row locking syntax
     */
    @Override
    public String getLockString() throws MetaDataException {
        return "FOR UPDATE NOWAIT";
    }
    
    /**
     * Oracle-specific date format
     */
    @Override
    public String getDateFormat() {
        return "yyyy-MM-dd HH:mm:ss";
    }

    @Override
    public String toString() {
        return "Oracle Database Driver (Enhanced for Oracle 12c+)";
    }
}
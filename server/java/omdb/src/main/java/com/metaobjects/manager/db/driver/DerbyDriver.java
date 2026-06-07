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
 * Apache Derby Database Driver with modern Java 21 features and Derby-specific optimizations.
 * 
 * <p>This driver supports:
 * <ul>
 *   <li>Derby IDENTITY columns with custom start/increment</li>
 *   <li>Derby-specific data types and constraints</li>
 *   <li>Embedded and network Derby configurations</li>
 *   <li>Derby sequences and generated columns</li>
 *   <li>Row locking and transaction isolation</li>
 *   <li>Derby system procedures and functions</li>
 * </ul>
 * 
 * @author Doug Mealing
 * @since 5.1.0
 */
public class DerbyDriver extends GenericSQLDriver {

    private static final Logger log = LoggerFactory.getLogger(DerbyDriver.class);
    
    public DerbyDriver() {
        super();
    }

    /**
     * Gets the last inserted IDENTITY value using Derby's IDENTITY_VAL_LOCAL()
     */
    @Override
    protected String getLastAutoId(Connection conn, ColumnDef col) throws SQLException {
        String query = "SELECT IDENTITY_VAL_LOCAL() FROM " + getProperName(col.getBaseTable().getNameDef());
        
        try (Statement s = conn.createStatement();
             ResultSet rs = s.executeQuery(query)) {
            
            if (!rs.next()) {
                return "1";
            }
            
            String tmp = rs.getString(1);
            if (tmp == null) {
                return "1";
            }
            
            if (log.isDebugEnabled()) {
                log.debug("Retrieved last IDENTITY ({}) for Derby column [{}]", tmp, col.getName());
            }
            
            return tmp;
            
        } catch (SQLException e) {
            log.error("Unable to get last id for Derby column [{}]: {}", col, e.getMessage(), e);
            throw new SQLException("Unable to get last id for Derby column [" + col + "]: " + e.getMessage(), e);
        }
    }

    /**
     * Derby supports FETCH FIRST/OFFSET for range queries (Derby 10.5+)
     */
    @Override
    protected boolean supportsRangeInQuery() {
        return true;
    }
    
    /**
     * Derby OFFSET/FETCH syntax
     */
    @Override
    public String getRangeString(Range range) {
        if (range.getStart() <= 1) {
            return "FETCH FIRST " + range.getEnd() + " ROWS ONLY";
        } else {
            return "OFFSET " + (range.getStart() - 1) + " ROWS FETCH NEXT " + 
                   (range.getEnd() - range.getStart() + 1) + " ROWS ONLY";
        }
    }

    /**
     * Derby row locking syntax
     */
    @Override
    public String getLockString() throws MetaDataException {
        return "FOR UPDATE";
    }
    
    /**
     * Derby date format
     */
    @Override
    public String getDateFormat() {
        return "yyyy-MM-dd HH:mm:ss";
    }

    @Override
    public String toString() {
        return "Apache Derby Database Driver (Enhanced for Derby 10.15+)";
    }
}

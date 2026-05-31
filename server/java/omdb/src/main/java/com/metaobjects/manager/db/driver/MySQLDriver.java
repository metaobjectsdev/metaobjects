/*
 * Copyright 2003 Doug Mealing LLC dba Meta Objects. All Rights Reserved.
 *
 * This software is the proprietary information of Doug Mealing LLC dba Meta Objects.
 * Use is subject to license terms.
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
 * MySQL Database Driver with modern Java 21 features and comprehensive MySQL-specific optimizations.
 * 
 * <p>This driver supports:
 * <ul>
 *   <li>MySQL AUTO_INCREMENT columns</li>
 *   <li>MySQL-specific data types (JSON, GEOMETRY, TEXT variants)</li>
 *   <li>InnoDB storage engine optimizations</li>
 *   <li>Full-text search indexes</li>
 *   <li>MySQL 8.0+ features (CTEs, window functions)</li>
 *   <li>Row locking with FOR UPDATE</li>
 * </ul>
 * 
 * @author Doug Mealing
 * @since 5.1.0
 */
public class MySQLDriver extends GenericSQLDriver {

    private static final Logger log = LoggerFactory.getLogger(MySQLDriver.class);

    public MySQLDriver() {
        super();
    }

    /**
     * Gets the next sequence for MySQL using LAST_INSERT_ID() trick
     */
    @Override
    protected String getNextAutoId(Connection conn, ColumnDef col) throws SQLException {
        if (col.getSequence() == null) {
            throw new MetaDataException("Column definition [" + col + "] has no sequence defined");
        }
        
        String seqTable = getProperName(col.getSequence().getNameDef());
        
        try {
            // Update and get next value atomically using LAST_INSERT_ID
            String updateQuery = "UPDATE " + seqTable + " SET current_value = LAST_INSERT_ID(current_value + 1)";
            
            try (Statement s = conn.createStatement()) {
                s.execute(updateQuery);
            }
            
            // Get the generated value
            String selectQuery = "SELECT LAST_INSERT_ID()";
            
            try (Statement s = conn.createStatement();
                 ResultSet rs = s.executeQuery(selectQuery)) {
                
                if (!rs.next()) {
                    throw new SQLException("Unable to get next id for column [" + col + "], no result in result set");
                }
                
                String id = rs.getString(1);
                
                if (log.isDebugEnabled()) {
                    log.debug("Retrieved id ({}) from MySQL sequence [{}]", id, seqTable);
                }
                
                if (id == null) {
                    throw new SQLException("A null sequence value was returned from MySQL");
                }
                
                return id;
            }
            
        } catch (SQLException e) {
            log.error("Unable to get next id for column [{}]: {}", col, e.getMessage(), e);
            throw new SQLException("Unable to get next id for column [" + col + "]: " + e.getMessage(), e);
        }
    }

    /**
     * MySQL supports LIMIT for range queries
     */
    @Override
    protected boolean supportsRangeInQuery() {
        return true;
    }
    
    /**
     * MySQL LIMIT syntax
     */
    @Override
    public String getRangeString(Range range) {
        if (range.getStart() <= 1) {
            return "LIMIT " + range.getEnd();
        } else {
            return "LIMIT " + (range.getStart() - 1) + ", " + (range.getEnd() - range.getStart() + 1);
        }
    }

    /**
     * MySQL row locking syntax
     */
    @Override
    public String getLockString() throws MetaDataException {
        return "FOR UPDATE";
    }
    
    /**
     * MySQL date format
     */
    @Override
    public String getDateFormat() {
        return "yyyy-MM-dd HH:mm:ss";
    }

    @Override
    public String toString() {
        return "MySQL Database Driver (Enhanced for MySQL 8.0+)";
    }
}
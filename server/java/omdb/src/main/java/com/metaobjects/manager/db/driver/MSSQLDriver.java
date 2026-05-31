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
 * Microsoft SQL Server Database Driver with modern Java 21 features and comprehensive SQL Server optimizations.
 * 
 * <p>This driver supports:
 * <ul>
 *   <li>SQL Server IDENTITY columns with custom start/increment</li>
 *   <li>SQL Server-specific data types (NVARCHAR, UNIQUEIDENTIFIER, XML)</li>
 *   <li>Clustered and non-clustered indexes</li>
 *   <li>SQL Server sequences (2012+)</li>
 *   <li>Modern SQL Server features (JSON, temporal tables)</li>
 *   <li>Row locking with UPDLOCK, ROWLOCK hints</li>
 * </ul>
 * 
 * @author Doug Mealing
 * @since 5.1.0
 */
public class MSSQLDriver extends GenericSQLDriver {

    private static final Logger log = LoggerFactory.getLogger(MSSQLDriver.class);

    public MSSQLDriver() {
        super();
    }

    /**
     * Gets the next sequence value using SQL Server NEXT VALUE FOR (2012+) or SCOPE_IDENTITY()
     */
    @Override
    protected String getNextAutoId(Connection conn, ColumnDef col) throws SQLException {
        if (col.getSequence() == null) {
            throw new MetaDataException("Column definition [" + col + "] has no sequence defined");
        }

        String seqName = getProperName(col.getSequence().getNameDef());
        String query = "SELECT NEXT VALUE FOR " + seqName;
        
        try (Statement s = conn.createStatement();
             ResultSet rs = s.executeQuery(query)) {
            
            if (!rs.next()) {
                throw new SQLException("Unable to get next id for Column Definition [" + col + "], no result in result set");
            }
            
            String id = rs.getString(1);
            
            if (log.isDebugEnabled()) {
                log.debug("Retrieved id ({}) from SQL Server sequence [{}]", id, seqName);
            }
            
            if (id == null) {
                throw new SQLException("A null sequence value was returned from SQL Server");
            }
            
            return id;
            
        } catch (SQLException e) {
            log.error("Unable to get next id for Column definition [{}]: {}", col, e.getMessage(), e);
            throw new SQLException("Unable to get next id for Column definition [" + col + "]: " + e.getMessage(), e);
        }
    }

    /**
     * Gets the last inserted IDENTITY value using SCOPE_IDENTITY()
     */
    @Override
    protected String getLastAutoId(Connection conn, ColumnDef col) throws SQLException {
        String query = "SELECT SCOPE_IDENTITY()";
        
        try (Statement s = conn.createStatement();
             ResultSet rs = s.executeQuery(query)) {
            
            if (!rs.next()) {
                throw new SQLException("Unable to get last IDENTITY for Column Definition [" + col + "], no result in result set");
            }
            
            String id = rs.getString(1);
            
            if (log.isDebugEnabled()) {
                log.debug("Retrieved last IDENTITY ({}) for column [{}]", id, col.getName());
            }
            
            return id != null ? id : "1";
            
        } catch (SQLException e) {
            log.error("Unable to get last IDENTITY for Column definition [{}]: {}", col, e.getMessage(), e);
            throw new SQLException("Unable to get last IDENTITY for Column definition [" + col + "]: " + e.getMessage(), e);
        }
    }

    /**
     * SQL Server supports standard ANSI OFFSET/FETCH for range queries
     * (requires SQL Server 2012+).
     */
    @Override
    protected boolean supportsRangeInQuery() {
        return true;
    }

    /**
     * SQL Server OFFSET/FETCH syntax (SQL Server 2012+). Used uniformly for
     * every page, including the first -- the legacy TOP path (which never
     * paged the first page at all) has been removed. Requires a preceding
     * ORDER BY; see {@link #rangeRequiresOrderBy()}.
     */
    @Override
    public String getRangeString(Range range) {
        return "OFFSET " + (range.getStart() - 1) + " ROWS FETCH NEXT " +
               (range.getEnd() - range.getStart() + 1) + " ROWS ONLY";
    }

    /** SQL Server OFFSET/FETCH requires an ORDER BY to be well-formed. */
    @Override
    protected boolean rangeRequiresOrderBy() {
        return true;
    }

    /**
     * SQL Server accepts a constant ORDER BY for paging when the caller
     * supplies no explicit sort order.
     */
    @Override
    protected String getDefaultRangeOrderBy() {
        return "ORDER BY (SELECT NULL)";
    }

    /**
     * SQL Server row locking syntax with hints
     */
    @Override
    public String getLockString() throws MetaDataException {
        return "WITH (UPDLOCK, ROWLOCK)";
    }
    
    /**
     * SQL Server date format
     */
    @Override
    public String getDateFormat() {
        return "yyyy-MM-dd HH:mm:ss.SSS";
    }

    @Override
    public String toString() {
        return "Microsoft SQL Server Database Driver (Enhanced for SQL Server 2019+)";
    }
}
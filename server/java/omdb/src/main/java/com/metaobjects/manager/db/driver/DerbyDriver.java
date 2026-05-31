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
import com.metaobjects.manager.db.defs.TableDef;
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
     * Deletes a table from the Derby database
     */
    @Override
    public void deleteTable(Connection c, TableDef table) throws SQLException {
        String tableName = getProperName(table.getNameDef());
        String query = "DROP TABLE " + tableName;
        
        if (log.isDebugEnabled()) {
            log.debug("Dropping Derby table [{}]: {}", tableName, query);
        }
        
        try (Statement s = c.createStatement()) {
            s.execute(query);
        } catch (SQLException e) {
            throw new SQLException("Failed to drop Derby table [" + tableName + "]: " + e.getMessage(), e);
        }
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

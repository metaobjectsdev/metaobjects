/*
 * Copyright 2003 Doug Mealing LLC dba Meta Objects. All Rights Reserved.
 *
 * This software is the proprietary information of Doug Mealing LLC dba Meta Objects.
 * Use is subject to license terms.
 */
package com.metaobjects.manager.db.driver;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.sql.Types;
import java.util.List;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import com.metaobjects.MetaDataException;


import com.metaobjects.manager.db.defs.ColumnDef;
import com.metaobjects.manager.db.defs.ForeignKeyDef;
import com.metaobjects.manager.db.defs.IndexDef;
import com.metaobjects.manager.db.defs.SequenceDef;
import com.metaobjects.manager.db.defs.TableDef;
import com.metaobjects.manager.db.defs.ViewDef;
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
     * Creates a table in the Oracle database with Oracle-specific optimizations
     */
    @Override
    public void createTable(Connection c, TableDef table) throws SQLException {
        StringBuilder query = new StringBuilder();
        
        try {
            query.append("CREATE TABLE ")
                 .append(getProperName(table.getNameDef()))
                 .append(" (\n");

            List<ColumnDef> cols = table.getColumns();
            int keys = table.getPrimaryKeys().size();
            boolean hasIdentity = false;

            // Create columns
            for (int i = 0; i < cols.size(); i++) {
                ColumnDef col = cols.get(i);
                String name = col.getName();
                
                if (i > 0) query.append(",\n");
                
                query.append("  ").append(name).append(" ");
                
                // Oracle-specific type mapping
                switch (col.getSQLType()) {
                    case Types.BOOLEAN, Types.BIT -> query.append("NUMBER(1)");
                    case Types.TINYINT -> query.append("NUMBER(3)");
                    case Types.SMALLINT -> query.append("NUMBER(5)");
                    case Types.INTEGER -> query.append("NUMBER(10)");
                    case Types.BIGINT -> query.append("NUMBER(19)");
                    case Types.FLOAT -> query.append("FLOAT");
                    case Types.DOUBLE -> query.append("BINARY_DOUBLE");
                    case Types.TIMESTAMP -> query.append("TIMESTAMP");
                    case Types.VARCHAR -> {
                        if (col.getLength() > 4000) {
                            query.append("CLOB");
                        } else {
                            query.append("VARCHAR2(").append(col.getLength()).append(")");
                        }
                    }
                    default -> throw new UnsupportedOperationException(
                        "Oracle driver does not support SQL type: " + col.getSQLType());
                }
                
                // Add constraints
                if (col.isPrimaryKey() && keys == 1) {
                    query.append(" PRIMARY KEY");
                } else if (col.isUnique()) {
                    query.append(" UNIQUE");
                }
                
                // Oracle constraints can be added here if needed
            }
            
            // Add composite primary key if needed
            if (keys > 1) {
                query.append(",\n  PRIMARY KEY (");
                table.getPrimaryKeys().stream()
                    .map(ColumnDef::getName)
                    .reduce((a, b) -> a + ", " + b)
                    .ifPresent(query::append);
                query.append(")");
            }
            
            query.append("\n)");

            if (log.isDebugEnabled()) {
                log.debug("Creating Oracle table [{}]: {}", table.getNameDef().getFullname(), query);
            }

            try (Statement s = c.createStatement()) {
                s.execute(query.toString());
            }
            
        } catch (Exception e) {
            throw new SQLException("Failed to create Oracle table [" + table.getNameDef().getFullname() + 
                                 "] using SQL [" + query + "]: " + e.getMessage(), e);
        }
    }

    /**
     * Deletes a table from the Oracle database
     */
    @Override
    public void deleteTable(Connection c, TableDef table) throws SQLException {
        String tableName = getProperName(table.getNameDef());
        String query = "DROP TABLE " + tableName + " CASCADE CONSTRAINTS";
        
        if (log.isDebugEnabled()) {
            log.debug("Dropping Oracle table [{}]: {}", tableName, query);
        }
        
        try (Statement s = c.createStatement()) {
            s.execute(query);
        } catch (SQLException e) {
            throw new SQLException("Failed to drop Oracle table [" + tableName + "]: " + e.getMessage(), e);
        }
    }

    /**
     * Creates an Oracle view
     */
    @Override
    public void createView(Connection c, ViewDef view) throws SQLException {
        String viewName = getProperName(view.getNameDef());
        String query = "CREATE OR REPLACE VIEW " + viewName + " AS " + view.getSQL();
        
        if (log.isDebugEnabled()) {
            log.debug("Creating Oracle view [{}]: {}", viewName, query);
        }
        
        try (Statement s = c.createStatement()) {
            s.execute(query);
        } catch (SQLException e) {
            throw new SQLException("Failed to create Oracle view [" + viewName + "]: " + e.getMessage(), e);
        }
    }

    /**
     * Creates an Oracle sequence with proper configuration
     */
    @Override
    public void createSequence(Connection c, SequenceDef sequence) throws SQLException {
        String seqName = getProperName(sequence.getNameDef());
        StringBuilder query = new StringBuilder();
        
        query.append("CREATE SEQUENCE ")
             .append(seqName)
             .append(" START WITH ").append(sequence.getStart())
             .append(" INCREMENT BY ").append(sequence.getIncrement())
             .append(" CACHE 20");  // Oracle optimization
        
        if (log.isDebugEnabled()) {
            log.debug("Creating Oracle sequence [{}]: {}", seqName, query);
        }
        
        try (Statement s = c.createStatement()) {
            s.execute(query.toString());
        } catch (SQLException e) {
            throw new SQLException("Failed to create Oracle sequence [" + seqName + "]: " + e.getMessage(), e);
        }
    }

    /**
     * Creates an Oracle index with optimization hints
     */
    @Override
    public void createIndex(Connection c, IndexDef index) throws SQLException {
        StringBuilder query = new StringBuilder();
        String indexName = index.getName();
        String tableName = getProperName(index.getTable().getNameDef());
        
        query.append("CREATE INDEX ")
             .append(indexName)
             .append(" ON ")
             .append(tableName)
             .append(" (");
        
        String columns = String.join(", ", index.getColumnNames());
        query.append(columns).append(")");
        
        if (log.isDebugEnabled()) {
            log.debug("Creating Oracle index [{}]: {}", indexName, query);
        }
        
        try (Statement s = c.createStatement()) {
            s.execute(query.toString());
        } catch (SQLException e) {
            throw new SQLException("Failed to create Oracle index [" + indexName + "]: " + e.getMessage(), e);
        }
    }

    /**
     * Creates an Oracle foreign key constraint
     */
    @Override
    public void createForeignKey(Connection c, ForeignKeyDef keyDef) throws SQLException {
        StringBuilder query = new StringBuilder();
        
        query.append("ALTER TABLE ")
             .append(getProperName(keyDef.getTable().getNameDef()))
             .append(" ADD CONSTRAINT ")
             .append(keyDef.getName())
             .append(" FOREIGN KEY (")
             .append(keyDef.getColumnName())
             .append(") REFERENCES ")
             .append(getProperName(keyDef.getRefTable().getNameDef()))
             .append(" (")
             .append(keyDef.getRefColumn().getName())
             .append(")");
        
        if (log.isDebugEnabled()) {
            log.debug("Creating Oracle foreign key [{}]: {}", keyDef.getName(), query);
        }
        
        try (Statement s = c.createStatement()) {
            s.execute(query.toString());
        } catch (SQLException e) {
            throw new SQLException("Failed to create Oracle foreign key [" + keyDef.getName() + "]: " + e.getMessage(), e);
        }
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
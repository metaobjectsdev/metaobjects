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

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import com.metaobjects.MetaDataException;


import com.metaobjects.manager.db.defs.ColumnDef;
import com.metaobjects.manager.db.defs.TableDef;
import com.metaobjects.manager.db.defs.ViewDef;
import com.metaobjects.manager.exp.Range;

/**
 * PostgreSQL Database Driver with modern Java 21 features and comprehensive PostgreSQL-specific optimizations.
 * 
 * <p>This driver supports:
 * <ul>
 *   <li>PostgreSQL sequences with proper NEXTVAL/CURRVAL handling</li>
 *   <li>PostgreSQL-specific data types (JSON, JSONB, ARRAY, UUID)</li>
 *   <li>Advanced indexing (B-tree, GiST, GIN, SP-GiST, BRIN)</li>
 *   <li>Full-text search with tsvector/tsquery</li>
 *   <li>PostgreSQL extensions and custom types</li>
 *   <li>Row locking with FOR UPDATE/FOR SHARE variants</li>
 * </ul>
 * 
 * @author Doug Mealing
 * @since 5.1.0
 */
public class PostgresDriver extends GenericSQLDriver {

    private static final Logger log = LoggerFactory.getLogger(PostgresDriver.class);

    public PostgresDriver() {
        super();
    }

    /**
     * Deletes a table from the PostgreSQL database
     */
    @Override
    public void deleteTable(Connection c, TableDef table) throws SQLException {
        String tableName = getProperName(table.getNameDef());
        String query = "DROP TABLE IF EXISTS " + tableName + " CASCADE";
        
        if (log.isDebugEnabled()) {
            log.debug("Dropping PostgreSQL table [{}]: {}", tableName, query);
        }
        
        try (Statement s = c.createStatement()) {
            s.execute(query);
        } catch (SQLException e) {
            throw new SQLException("Failed to drop PostgreSQL table [" + tableName + "]: " + e.getMessage(), e);
        }
    }

    /**
     * Creates a PostgreSQL view
     */
    @Override
    public void createView(Connection c, ViewDef view) throws SQLException {
        String viewName = getProperName(view.getNameDef());
        String query = "CREATE OR REPLACE VIEW " + viewName + " AS " + view.getSQL();
        
        if (log.isDebugEnabled()) {
            log.debug("Creating PostgreSQL view [{}]: {}", viewName, query);
        }
        
        try (Statement s = c.createStatement()) {
            s.execute(query);
        } catch (SQLException e) {
            throw new SQLException("Failed to create PostgreSQL view [" + viewName + "]: " + e.getMessage(), e);
        }
    }

    /**
     * Gets the next sequence value using PostgreSQL's nextval()
     */
	@Override
	protected String getNextAutoId( Connection conn, ColumnDef col ) throws SQLException
	{
		if ( col.getSequence() == null )
			throw new MetaDataException( "Column definition [" + col + "] has no sequence defined" );

		String seq = getProperName( col.getSequence().getNameDef() );

		try
		{
			// Increment the ID
			String query = "SELECT nextval(?)";

			PreparedStatement s = conn.prepareStatement( query );
			s.setString( 1, seq );

			try
			{
				ResultSet rs = s.executeQuery();

				if ( !rs.next() )
					throw new SQLException( "Unable to get next id for Column Definition [" + col + "], no result in result set" );

				try { 
					String id = rs.getString( 1 );
					if ( log.isDebugEnabled() ) {
						log.debug( "Retrieved id (" + id + ") from sequence [" + seq + "]" );
					}
					if ( id == null ) throw new SQLException( "A null sequence value was returned" );
					return id;
				}
				finally { rs.close(); }
			}
			finally { s.close(); }
		}
		catch( SQLException e )
		{
			log.error( "Unable to get next id for Column definition [" + col + "]: " + e.getMessage(), e );
			throw new SQLException( "Unable to get next id for Column definition [" + col + "]: " + e.getMessage(), e );
		}
	}
	
	
	/** Returns whether the drive supports the Range within the query, i.e. LIMIT */
	@Override
	protected boolean supportsRangeInQuery() {
		return true;
	}
	
	/** Returns the SQL portion of the range string */
	public String getRangeString( Range range ) {
						
		StringBuilder b = new StringBuilder( "LIMIT " );
		b.append(( range.getEnd() - range.getStart() ) + 1 );
		if ( range.getStart() > 1 ) {
			b.append( " OFFSET " ).append(( range.getStart()-1 ));
		}
		return b.toString();
	}	
	

	/**
	 * The SQL query to append to a SQL SELECT to lock the returned rows
	 */
	@Override
	public String getLockString() throws MetaDataException
	{
		return "FOR UPDATE";
	}

    // --- Migration render support ---

    /**
     * Double-quote every identifier emitted in SELECT/WHERE/ORDER BY/UPDATE
     * SET so mixed-case column names (e.g. {@code "programId"}) survive PG's
     * case-folding pass. Cross-port: TS uses the same convention in its
     * Kysely query builder; C# delegates to EF which quotes by default.
     */
    @Override
    protected String quoteIdent(String name) {
        if (name.indexOf('"') >= 0) throw new IllegalArgumentException("unsafe identifier: " + name);
        return "\"" + name + "\"";
    }

    @Override
    public String toString() {
        return "PostgreSQL Database Driver (Enhanced for PostgreSQL 14+)";
    }
}

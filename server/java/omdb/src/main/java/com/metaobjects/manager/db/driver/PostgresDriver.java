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
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import com.metaobjects.MetaDataException;


import com.metaobjects.manager.db.defs.ColumnDef;
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
	
	
	/**
	 * Gets the id of the row just inserted into a {@code GENERATED ... AS IDENTITY} (or
	 * {@code SERIAL}) column — the Postgres equivalent of Derby's {@code IDENTITY_VAL_LOCAL()} /
	 * MSSQL's {@code SCOPE_IDENTITY()}. Postgres has no such scalar; instead the value is the
	 * current value of the column's implicit identity sequence in THIS session, which our INSERT
	 * (on the same connection, immediately prior — see {@link GenericSQLDriver#create}) just
	 * generated. {@code pg_get_serial_sequence(table, column)} resolves that sequence for both
	 * SERIAL and IDENTITY columns; {@code currval} is session-local so it is unambiguous even
	 * under concurrency. Used for an {@code AUTO_LAST_ID} column (the canonical TPH {@code auths}
	 * identity PK) where no named sequence is pre-fetched via {@link #getNextAutoId}.
	 */
	@Override
	protected String getLastAutoId( Connection conn, ColumnDef col ) throws SQLException
	{
		String table = getProperName( col.getBaseTable().getNameDef() );
		String column = col.getName();
		String query = "SELECT currval(pg_get_serial_sequence(?, ?))";

		try ( PreparedStatement s = conn.prepareStatement( query ) ) {
			s.setString( 1, table );
			s.setString( 2, column );
			try ( ResultSet rs = s.executeQuery() ) {
				if ( !rs.next() )
					throw new SQLException( "Unable to get last id for Column Definition [" + col + "], no result in result set" );
				String id = rs.getString( 1 );
				if ( id == null )
					throw new SQLException( "A null last-id value was returned for Column Definition [" + col + "]" );
				if ( log.isDebugEnabled() )
					log.debug( "Retrieved last identity ({}) for column [{}]", id, col.getName() );
				return id;
			}
		}
		catch ( SQLException e ) {
			log.error( "Unable to get last id for Column definition [{}]: {}", col, e.getMessage(), e );
			throw new SQLException( "Unable to get last id for Column definition [" + col + "]: " + e.getMessage(), e );
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

    /**
     * Postgres has a native {@code jsonb} type: bind JSON text via
     * {@code setObject(.., Types.OTHER)} (pgjdbc routes {@code OTHER} + a String to the
     * jsonb column's input function). A bare {@code setString} draws "column is of type
     * jsonb but expression is of type character varying". The base-class default
     * ({@code setString}) is correct only for backends that store JSON as text (Derby).
     */
    @Override
    protected void bindJsonbParameter(PreparedStatement s, int index, String json) throws SQLException {
        s.setObject(index, json, java.sql.Types.OTHER);
    }

    /** NULL into a jsonb column on Postgres binds with {@code OTHER}, matching the value bind. */
    @Override
    protected int jsonbNullSqlType() {
        return java.sql.Types.OTHER;
    }

    @Override
    public String toString() {
        return "PostgreSQL Database Driver (Enhanced for PostgreSQL 14+)";
    }
}

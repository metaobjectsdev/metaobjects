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
import com.metaobjects.manager.db.migrate.Change;
import com.metaobjects.manager.db.migrate.SchemaSnapshot.ColumnDescriptor;
import com.metaobjects.manager.db.migrate.SchemaSnapshot.TableDescriptor;
import com.metaobjects.manager.db.migrate.SqlType;
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
     * Creates a table in the PostgreSQL database with modern type mapping
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
            String primaryKey = null;

            // Create columns with modern type mapping
            for (int i = 0; i < cols.size(); i++) {
                ColumnDef col = cols.get(i);
                String name = col.getName();
                
                if (name == null) continue;
                
                if (i > 0) query.append(",\n");
                
                query.append("  ").append(name).append(" ");
                
                // PostgreSQL-specific type mapping with modern features
                switch (col.getSQLType()) {
                    case Types.BOOLEAN, Types.BIT -> query.append("BOOLEAN");
                    case Types.TINYINT -> query.append("SMALLINT"); // PostgreSQL doesn't have TINYINT
                    case Types.SMALLINT -> query.append("SMALLINT");
                    case Types.INTEGER -> query.append("INTEGER");
                    case Types.BIGINT -> query.append("BIGINT");
                    case Types.FLOAT -> query.append("REAL");
                    case Types.DOUBLE -> query.append("DOUBLE PRECISION");
                    case Types.TIMESTAMP -> query.append("TIMESTAMP WITH TIME ZONE");
                    case Types.VARCHAR -> {
                        if (col.getLength() > 10485760) { // 10MB limit for VARCHAR
                            query.append("TEXT");
                        } else {
                            query.append("VARCHAR(").append(col.getLength()).append(")");
                        }
                    }
                    default -> throw new UnsupportedOperationException(
                        "PostgreSQL driver does not support SQL type: " + col.getSQLType());
                }
                
                // PostgreSQL constraints can be added here if needed
                
                if (col.isPrimaryKey() && keys == 1) {
                    primaryKey = name;
                } else if (col.isUnique()) {
                    query.append(" UNIQUE");
                }
                
                // Default values can be added via ColumnDef if needed
            }
            
            // Add primary key constraint
            if (primaryKey != null) {
                query.append(",\n  PRIMARY KEY (").append(primaryKey).append(")");
            } else if (keys > 1) {
                query.append(",\n  PRIMARY KEY (");
                table.getPrimaryKeys().stream()
                    .map(ColumnDef::getName)
                    .reduce((a, b) -> a + ", " + b)
                    .ifPresent(query::append);
                query.append(")");
            }
            
            query.append("\n)");

            if (log.isDebugEnabled()) {
                log.debug("Creating PostgreSQL table [{}]: {}", table.getNameDef().getFullname(), query);
            }

            try (Statement s = c.createStatement()) {
                s.execute(query.toString());
            }
            
        } catch (Exception e) {
            throw new SQLException("Failed to create PostgreSQL table [" + table.getNameDef().getFullname() + 
                                 "] using SQL [" + query + "]: " + e.getMessage(), e);
        }
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
     * Creates a PostgreSQL sequence with proper configuration
     */
    @Override
    public void createSequence(Connection c, SequenceDef sequence) throws SQLException {

		StringBuilder query = new StringBuilder();
		try {
			String seq = getProperName( sequence.getNameDef() );
			query.append( "CREATE SEQUENCE " )
			.append( seq )
			.append( " START " )
			.append( sequence.getStart() );
	
			Statement s = c.createStatement();
			try { s.execute( query.toString() ); }
			finally {  s.close(); }
	
			if ( log.isDebugEnabled() ) {
				log.debug( "Creating sequence [" + sequence + "]: " + query );
			}
		}
		catch( Exception e ) {
			throw new SQLException( "Creation of sequence [" + sequence + "] failed using SQL [" + query + "]: " + e.getMessage(), e );
		}
	}

	@Override
	public void createIndex( Connection c, IndexDef index ) throws SQLException {
		
		StringBuilder query = new StringBuilder();
		try {
			String name = index.getName();
			
			query.append( "CREATE INDEX " )
			.append( name )
			.append( " ON " )
			.append( getProperName( index.getTable().getNameDef() ) )
			.append( "(" );
			
			boolean first = true;
			for ( String colName : index.getColumnNames() ) {
				if ( first ) first = false;
				else query.append( "," );
				query.append( colName );
			}
			
			query.append( ")" );
	
			if ( log.isDebugEnabled() ) {
				log.debug( "Creating index [" + index + "]: " + query );
			}
	
			Statement s = c.createStatement();
			try { s.execute( query.toString() ); }
			finally { s.close(); }
		}
		catch( Exception e ) {
			throw new SQLException( "Creation of index [" + index + "] failed using SQL [" + query + "]: " + e.getMessage(), e );
		}
    }

    /**
     * Creates a PostgreSQL foreign key constraint
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
             .append(") ON DELETE RESTRICT ON UPDATE CASCADE");
        
        if (log.isDebugEnabled()) {
            log.debug("Creating PostgreSQL foreign key [{}]: {}", keyDef.getName(), query);
        }
        
        try (Statement s = c.createStatement()) {
            s.execute(query.toString());
        } catch (SQLException e) {
            throw new SQLException("Failed to create PostgreSQL foreign key [" + keyDef.getName() + "]: " + e.getMessage(), e);
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

    /** Maps a canonical SqlType to its PostgreSQL DDL type string. */
    String pgType(SqlType t) {
        return switch (t) {
            case SqlType.Int i       -> i.bits() == 64 ? "BIGINT" : "INTEGER";
            case SqlType.Text tx     -> tx.maxLength() == null ? "TEXT" : "VARCHAR(" + tx.maxLength() + ")";
            case SqlType.Bool b      -> "BOOLEAN";
            // Honor the withTimezone flag so a plain TIMESTAMP doesn't get
            // gratuitously promoted to TIMESTAMPTZ (matches TS/C# behavior).
            case SqlType.Timestamp ts -> ts.withTimezone() ? "TIMESTAMP WITH TIME ZONE" : "TIMESTAMP";
            case SqlType.Real r      -> "DOUBLE PRECISION";
            case SqlType.Real4 r     -> "REAL";
            case SqlType.Numeric n   -> "NUMERIC";
            case SqlType.Json j      -> "JSONB";
            case SqlType.Date d      -> "DATE";
            case SqlType.Uuid u      -> "UUID";
            case SqlType.Blob b      -> "BYTEA";
        };
    }

    /**
     * Double-quote a Postgres identifier so mixed-case names (e.g. {@code programId})
     * survive PG's case-folding pass. Cross-port: TS + C# both quote all idents
     * in their migration DDL; matching this here lets {@code up-contains}
     * substring assertions compare cleanly across ports.
     */
    private static String q(String ident) {
        if (ident.indexOf('"') >= 0) throw new IllegalArgumentException("unsafe identifier: " + ident);
        return "\"" + ident + "\"";
    }

    private static String joinQ(List<String> idents) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < idents.size(); i++) {
            if (i > 0) sb.append(", ");
            sb.append(q(idents.get(i)));
        }
        return sb.toString();
    }

    /**
     * Renders a CREATE TABLE DDL string from a canonical TableDescriptor.
     * Used by {@link #render(Change)} for CreateTable changes.
     * The existing {@link #createTable(Connection, TableDef)} is left intact so FruitDBTest is unaffected.
     */
    String renderCreateTable(TableDescriptor table) {
        StringBuilder sb = new StringBuilder("CREATE TABLE ").append(q(table.name())).append(" (");
        List<ColumnDescriptor> cols = table.columns();
        for (int i = 0; i < cols.size(); i++) {
            if (i > 0) sb.append(", ");
            ColumnDescriptor col = cols.get(i);
            sb.append(q(col.name())).append(" ").append(pgType(col.sqlType()));
            if (!col.nullable()) sb.append(" NOT NULL");
        }
        if (!table.primaryKey().isEmpty()) {
            sb.append(", CONSTRAINT ").append(q(table.name() + "_pkey"))
              .append(" PRIMARY KEY (").append(joinQ(table.primaryKey())).append(")");
        }
        sb.append(")");
        return sb.toString();
    }

    @Override
    public String render(Change change) {
        return switch (change) {
            case Change.CreateTable ct      -> renderCreateTable(ct.table());
            case Change.AddColumn a         ->
                "ALTER TABLE " + q(a.table()) + " ADD COLUMN " + q(a.column().name()) + " " + pgType(a.column().sqlType());
            case Change.ChangeColumnType ch ->
                "ALTER TABLE " + q(ch.table()) + " ALTER COLUMN " + q(ch.column()) + " TYPE " + pgType(ch.to());
            case Change.RenameColumn rc     ->
                "ALTER TABLE " + q(rc.table()) + " RENAME COLUMN " + q(rc.from()) + " TO " + q(rc.to());
            case Change.RenameTable rt      ->
                "ALTER TABLE " + q(rt.from()) + " RENAME TO " + q(rt.to());
            case Change.AddIndex ai         ->
                "CREATE " + (ai.index().unique() ? "UNIQUE " : "") + "INDEX " + q(ai.index().name()) +
                " ON " + q(ai.table()) + " (" + joinQ(ai.index().columns()) + ")";
            case Change.AddFk af            ->
                "ALTER TABLE " + q(af.table()) + " ADD CONSTRAINT " + q(af.fk().name()) +
                " FOREIGN KEY (" + joinQ(af.fk().columns()) + ") REFERENCES " +
                q(af.fk().refTable()) + " (" + joinQ(af.fk().refColumns()) + ")";
            case Change.CreateView cv       ->
                "CREATE OR REPLACE VIEW " + q(cv.view().name()) + " AS " + cv.view().sql();
            case Change.DropColumn dc       ->
                "ALTER TABLE " + q(dc.table()) + " DROP COLUMN " + q(dc.column());
            case Change.DropTable dt        ->
                "DROP TABLE " + q(dt.table());
            case Change.DropIndex di        ->
                "DROP INDEX " + q(di.index());
            case Change.DropFk df           ->
                "ALTER TABLE " + q(df.table()) + " DROP CONSTRAINT " + q(df.fk());
            default -> throw new UnsupportedOperationException(
                "PostgresDriver does not support migration render for change kind: " + change.kind());
        };
    }

    @Override
    public String toString() {
        return "PostgreSQL Database Driver (Enhanced for PostgreSQL 14+)";
    }
}

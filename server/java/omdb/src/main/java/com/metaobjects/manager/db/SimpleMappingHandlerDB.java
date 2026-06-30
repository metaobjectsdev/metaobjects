package com.metaobjects.manager.db;

import java.sql.Types;
import java.util.ArrayList;
import java.util.Collection;

import com.metaobjects.DataTypes;
import com.metaobjects.MetaDataNotFoundException;
import com.metaobjects.database.CoreDBMetaDataProvider;
import com.metaobjects.object.MetaObject;
import com.metaobjects.MetaData;
import com.metaobjects.MetaDataException;

import com.metaobjects.field.MetaField;
import com.metaobjects.identity.MetaIdentity;
import com.metaobjects.manager.db.codec.JdbcCodecs;
import com.metaobjects.manager.db.codec.JdbcFieldCodec;
import com.metaobjects.identity.PrimaryIdentity;
import com.metaobjects.manager.ObjectManager;
import com.metaobjects.manager.db.defs.BaseTableDef;
import com.metaobjects.manager.db.defs.ColumnDef;
import com.metaobjects.manager.db.defs.IndexDef;
import com.metaobjects.manager.db.defs.NameDef;
import com.metaobjects.manager.db.defs.SequenceDef;
import com.metaobjects.manager.db.defs.TableDef;
import com.metaobjects.manager.db.defs.ViewDef;

public class SimpleMappingHandlerDB implements MappingHandler {

	public final static String TRUE  = "true";
	public final static String FALSE = "false";
	
	public final static String ATTR_TABLE_DEF = "dbTableDef";
	public final static String ATTR_VIEW_DEF  = "dbViewDef";
	public final static String ATTR_COL_DEF   = "dbColDef";

	public final static String AUTO_ID  = "id";
	public final static String AUTO_LAST_ID  = "last";
	public final static String AUTO_UUID  = "uuid";

	public final static String IS_INDEX     = "isIndex";
	public final static String IS_UNIQUE 	  = "isUnique";
	public final static String IS_VIEWONLY  = "isViewOnly";

	// SP-G Unit 7: the legacy @dbForeignKey persistence-attribute key was removed —
	// FK direction is derived from identity.reference (the SSOT), and the only reader
	// was the long-dead-commented getForeignKeys() DDL path (schema is TS-owned, ADR-0015).
	// Source-v2 ADR-0007: table/view names come from source.rdb @table (via
	// MetaObject.getPrimaryRdbTableName() / .getPrimaryRdbViewName()), not
	// from object-level @dbTable / @dbView (dropped in Stage 2).
	public final static String COL_REF      = "column";
	public final static String SEQ_REF      = "dbSequence";
	public final static String SEQ_START_REF   = "dbSeqStart";

	@Override
	public ObjectMapping getCreateMapping( MetaObject mc ) {
		
		String name = getTableRef( mc );
		if ( name != null ) {
			return getTableMapping( mc );
		}
		return null;
	}

	@Override
	public ObjectMapping getReadMapping(MetaObject mc) {
		
		// Try to get a view first 
		String name = getViewRef( mc );
		if ( name != null ) {
			return getViewMapping( mc );
		}
		
		// If no view, then get a table
		name = getTableRef( mc );
		if ( name != null ) {
			return getTableMapping( mc );
		}	
		return null;
	}

	@Override
	public ObjectMapping getDeleteMapping(MetaObject mc) {
		return getCreateMapping(mc);
	}

	@Override
	public ObjectMapping getUpdateMapping(MetaObject mc) {
		return getCreateMapping(mc);
	}

	/** Get the table mapping */
	protected ObjectMappingDB getTableMapping( MetaObject mc ) {

		// Create the table definition
		TableDef t = new TableDef( NameDef.parseName( getTableRef( mc )));
		
		// Get all the possible metafields for this metaclass (own + inherited via
		// extends — TPH subtypes map their effective fields onto the base's single
		// table, resolved via getTableRef → getPrimaryRdbTableName's super-chain walk).
		Collection<MetaField> fields = mc.getMetaFields();

		// Create the mapping
		ObjectMappingDB mapping = new ObjectMappingDB( t );

		// Load columns
		loadColumns( fields, t, mapping );
		
		// Return the table mapping
		return mapping;
	}

	/** Get the table mapping */
	protected ObjectMapping getViewMapping( MetaObject mc ) {

		// Create the view definition. The view name comes from source.rdb @table
		// (@kind=view); OMDB reads from a view that already exists in the database
		// (created by the migrate toolchain) — it does not synthesize view DDL.
		ViewDef v = new ViewDef( NameDef.parseName( getViewRef( mc )));

		// Create the mapping
		ObjectMappingDB mapping = new ObjectMappingDB( v );
		
		// Load columns
		loadColumns( mc.getMetaFields(), v, mapping );
		
		return mapping;
	}
	
	/** Load the columns for the mapping */
	protected void loadColumns( Collection<MetaField> fields, BaseTableDef table, ObjectMappingDB mapping ) {

		// Iterate through the fields and load the columns
		for( MetaField mf : fields ) {
			
			// Get the column DB name 
			String col = getColumnRef( mf );
			if ( col == null ) continue;
			
			// Make sure it's not for view's only
			if ( table instanceof TableDef ) {
				if ( TRUE.equals( getPersistenceAttribute( mf, IS_VIEWONLY ))) continue;
			}
			
			// Create the column definition
			ColumnDef colDef = new ColumnDef( col, getSQLType( mf ));

			// R6 Plan 2a/2b: physical column-type hint (native uuid/jsonb).
			// Drives the driver's native-column emission; the SQLType above still
			// drives JDBC get/set so the field round-trips as its logical value.
			colDef.setDbColumnType( resolveDbColumnType( mf ));

			// Set the length of the varchar field
			// TODO:  Length should be an attribute
			colDef.setLength( getSQLLength( mf ));
			
			// Is it a primary key? Check using PrimaryIdentity metadata
			MetaObject metaObject = (MetaObject) mf.getParent();
			boolean isPrimaryKey = false;
			if (metaObject != null) {
				PrimaryIdentity primaryIdentity = metaObject.getPrimaryIdentity();
				if (primaryIdentity != null && primaryIdentity.getMetaFields().contains(mf)) {
					isPrimaryKey = true;
				}
			}

			if (isPrimaryKey) {
				colDef.setPrimaryKey( true );
			}

			// Load extra values if this is a Table Definition
			if ( table instanceof TableDef ) {
				
				// Is it an auto column?
				String auto = getAutoGenerated( mf );
				if ( auto != null ) {
					if ( AUTO_ID.equals( auto )) {
						colDef.setAutoType( ColumnDef.AUTO_ID );
					}
					else if ( AUTO_LAST_ID.equals( auto )) {
						colDef.setAutoType( ColumnDef.AUTO_LAST_ID );
					}
					else if ( AUTO_UUID.equals( auto )) {
						colDef.setAutoType( ColumnDef.AUTO_UUID );
					}
					else if ( ObjectManager.AUTO_CREATE.equals( auto )) {
						colDef.setAutoType( ColumnDef.AUTO_DATE_CREATE );
					}
					else if ( ObjectManager.AUTO_UPDATE.equals( auto )) {
						colDef.setAutoType( ColumnDef.AUTO_DATE_UPDATE );
					}
				}
				
				// Get the sequence if it is defined
				String seq = getSequenceRef( mf );
				if ( seq != null ) {
					int start = getSequenceStart( mf );
					SequenceDef seqDef = new SequenceDef( NameDef.parseName( seq ), start, 1 );
					colDef.setSequence( seqDef );
				}
				
				// Set if it is unique
				colDef.setUnique( isUnique( mf ));
			
				// Check if the column is an index
				if ( isIndex( mf )) {
					
					String name = table.getNameDef().getName() + "_" + col + "_index"; 
						
					IndexDef index = new IndexDef( name, col );
					
					((TableDef) table ).addIndex( index );
				}
			}
			
			// Add the column to the table
			table.addColumn( colDef );
			
			// Add the mapping entry for the column and MetaField
			mapping.addMap( colDef, mf );
		}		
	}
	
	/**
	 * Resolve a field's dialect-neutral physical column-type hint (R6 Plan 2a/2b),
	 * or {@code null} when the field uses its SQLType default.
	 *
	 * <p>Two sources, in precedence order:</p>
	 * <ol>
	 *   <li>{@code field.uuid} (logical subtype) → native {@code uuid} column.</li>
	 *   <li>{@code @dbColumnType} physical attr → the mapped hint
	 *       ({@code uuid} / {@code jsonb}). The loader has already validated the
	 *       (subtype × value) pairing, so no re-check here.</li>
	 * </ol>
	 *
	 * <p>Timestamp timezone-awareness is NOT a {@code @dbColumnType} hint anymore
	 * (ADR-0036 Wave 2): {@code field.timestamp} is an instant ({@code timestamptz})
	 * by default and {@code @localTime:true} is the naive opt-out — the
	 * {@link com.metaobjects.manager.db.codec.JdbcCodecs.TimestampCodec} reads that
	 * flag off the field directly.</p>
	 */
	protected String resolveDbColumnType(MetaField mf) {
		if (com.metaobjects.field.UuidField.SUBTYPE_UUID.equals(mf.getSubType())) {
			return ColumnDef.COLTYPE_UUID;
		}
		if (mf.hasMetaAttr(CoreDBMetaDataProvider.DB_COLUMN_TYPE)) {
			String value = mf.getMetaAttr(CoreDBMetaDataProvider.DB_COLUMN_TYPE).getValueAsString();
			if (CoreDBMetaDataProvider.DB_COLUMN_TYPE_UUID.equals(value)) return ColumnDef.COLTYPE_UUID;
			if (CoreDBMetaDataProvider.DB_COLUMN_TYPE_JSONB.equals(value)) return ColumnDef.COLTYPE_JSONB;
		}
		return null;
	}

	/** Returns true if the field is declared as a typed-owned-object jsonb column via {@code @storage="jsonb"}. */
	protected boolean isJsonbField(MetaField mf) {
		try {
			return mf.hasMetaAttr(com.metaobjects.field.ObjectField.ATTR_STORAGE)
				&& CoreDBMetaDataProvider.DB_COLUMN_TYPE_JSONB.equals(
					mf.getMetaAttr(com.metaobjects.field.ObjectField.ATTR_STORAGE).getValueAsString());
		} catch (Exception e) {
			return false;
		}
	}

	protected int getSQLType( MetaField mf ) {
		// jsonb fields are stored as text (VARCHAR/CLOB) — no native jsonb on Derby
		if (isJsonbField(mf)) return Types.VARCHAR;
		// Consult the codec first: CUSTOM-DataType fields (e.g. TimeField) declare
		// their own SQL type so no instanceof guard is needed here (OCP).
		int codecType = JdbcCodecs.forField(mf).sqlType();
		if (codecType != JdbcFieldCodec.NO_SQL_TYPE) return codecType;
		switch( mf.getDataType() )
		{
		case BOOLEAN: return Types.BIT;
		case BYTE: return Types.TINYINT;
		case SHORT: return Types.SMALLINT;
		case INT: return Types.INTEGER;
		case DATE:  return Types.TIMESTAMP;
		case LONG: return Types.BIGINT;
		case FLOAT: return Types.FLOAT;
		case DOUBLE: return Types.DOUBLE;
		case DECIMAL: return Types.DECIMAL;
		case STRING: return Types.VARCHAR;
		case OBJECT: return Types.BLOB;
		default: throw new IllegalArgumentException( "Unable to get SQL type for MetaField [" + mf + "] with type (" + mf.getDataType() + ")" );
		}
	}

	protected int getSQLLength( MetaField mf ) {
		// jsonb: store as CLOB (length > Derby's VARCHAR max of 32672 triggers CLOB in DerbyDriver)
		if (isJsonbField(mf)) return 65536;
		// Consult the codec first: CUSTOM-DataType fields (e.g. TimeField) declare
		// their own length so no instanceof guard is needed here (OCP).
		int codecLength = JdbcCodecs.forField(mf).sqlLength();
		if (codecLength >= 0) return codecLength;
		switch( mf.getDataType() )
		{
			case BOOLEAN: return 1;
			case BYTE: return 2;
			case SHORT: return 4;
			case INT:
			case DATE:
			case LONG:
			case FLOAT:
			case DECIMAL:
			case DOUBLE: return 8;
			case STRING: return readStringMaxLength(mf);
			case OBJECT: return 100;
			default: throw new IllegalArgumentException( "Unable to get SQL type for MetaField [" + mf + "] with type (" + mf.getDataType() + ")" );
		}
	}

	/**
	 * Read the @maxLength attribute on a string field. Cross-port DDL contract
	 * (dbColumnType slim-and-derive, Phase 1): with {@code @maxLength: N} → {@code varchar(N)};
	 * with NO {@code @maxLength} → unbounded {@code text} (matches the canonical TS-owned
	 * {@code schema.postgres.sql} and C# EF, which both emit {@code TEXT} for a no-length
	 * string). Previously Java hardcoded {@code 50} here, capping every unannotated string at
	 * VARCHAR(50) — a divergence from the canonical {@code text}.
	 *
	 * <p>This length feeds {@link com.metaobjects.manager.db.defs.ColumnDef} metadata only;
	 * OMDB is pure data-access (no DDL — schema is TypeScript-owned, ADR-0015), so the runtime
	 * string bind ({@code setString}) is unbounded regardless. {@link #UNBOUNDED_TEXT_LENGTH}
	 * (0) is the sentinel for "no length cap → text".</p>
	 */
	protected int readStringMaxLength(MetaField mf) {
		if (mf.hasMetaAttr(com.metaobjects.field.StringField.ATTR_MAX_LENGTH)) {
			try {
				return Integer.parseInt(
					mf.getMetaAttr(com.metaobjects.field.StringField.ATTR_MAX_LENGTH).getValueAsString());
			} catch (NumberFormatException ignored) { /* fall through */ }
		}
		return UNBOUNDED_TEXT_LENGTH;
	}

	/**
	 * Sentinel length for a no-{@code maxLength} {@code field.string} → unbounded {@code text}
	 * (the canonical cross-port default). OMDB does no DDL, so this is metadata-only.
	 */
	protected static final int UNBOUNDED_TEXT_LENGTH = 0;

	/**
	 * Returns whether the metafield is an auto id and is set prior to creation or update.
	 * ✅ MIGRATED: Now uses MetaIdentity approach instead of deprecated field attributes.
	 */
	protected String getAutoGenerated( MetaField mf ) {
		// First check for traditional "auto" attribute (backward compatibility)
		String autoAttribute = getPersistenceAttribute( mf, ObjectManager.AUTO );
		if (autoAttribute != null) {
			return autoAttribute;
		}

		// ✅ NEW: Check if this field is part of a primary identity with generation strategy
		MetaObject metaObject = (MetaObject) mf.getParent();
		if (metaObject != null) {
			MetaIdentity primaryIdentity = metaObject.getPrimaryIdentity();
			if (primaryIdentity != null && primaryIdentity.getMetaFields().contains(mf)) {
				String generation = primaryIdentity.getGeneration();
				if (generation != null) {
					// Map MetaIdentity generation strategies to database layer values
					switch (generation) {
						case MetaIdentity.GENERATION_INCREMENT:
							return AUTO_LAST_ID; // "last" -> database auto-increment (Derby IDENTITY, etc.)
						case MetaIdentity.GENERATION_UUID:
							return AUTO_UUID; // app-side UUID minted before INSERT (DB-portable)
						case MetaIdentity.GENERATION_ASSIGNED:
						default:
							return null; // No auto-increment
					}
				}
			}
		}

		return null; // No auto-increment configuration found
	}


	/**
	 * Retrieves the fields of a MetaClass which are persistable
	 */
	/*public Collection<MetaField> getTableFields( MetaClass mc )
    {
        final String KEY = "getTableFields()";

        ArrayList<MetaField> fields = (ArrayList<MetaField>) mc.getCacheValue( KEY );

        if ( fields == null )
        {
	        fields = new ArrayList<MetaField>();

	        for( Iterator i = mc.getMetaFields().iterator(); i.hasNext(); )
	        {
	            MetaField f = (MetaField) i.next();
	            if ( isReadableField( f ) && !isViewOnly( f )) fields.add( f );
	        }

	        mc.setCacheValue( KEY, fields );
        }

        return fields;
    }*/


    /**
     * Retrieves the foreign keys defined in the specified MetaClass
     */
  /*public Collection<ForeignKeyDef> getForeignKeys( MetaClass mc )
  {
    List<ForeignKeyDef> fKeys = new ArrayList<ForeignKeyDef>();

    for( MetaField mf : mc.getMetaFields() )
    {
      String fkey = getPersistenceAttribute( mf, FOREIGN_KEY_REF );
      if ( fkey != null )
      {
        int i = fkey.indexOf( "->" );
        if ( i <= 0 )
          throw new IllegalArgumentException( "Invalid Format for " + FOREIGN_KEY_REF + " parameter on MetaField [" + mf + "], no '->' found" );

        String packageName = mc.getPackage();
        String foreignClassStr = fkey.substring( 0, i );
        String foreignFieldStr = fkey.substring( i + 2 );
        MetaClass foreignClass = null;

          if ( foreignClassStr.length() > 0 )
          {
            // Try to find it with the name prepended if not fully qualified
            try {
              if ( foreignClassStr.indexOf( MetaClass.SEPARATOR ) < 0 && packageName.length() > 0 )
                foreignClass = MetaClass.forName( packageName + MetaClass.SEPARATOR + foreignClassStr );
            }
            catch( MetaClassNotFoundException e ) {
              log.debug( "Could not find ForeignKey MetaClass [" + packageName + MetaClass.SEPARATOR + foreignClassStr + "], assuming fully qualified" );
            }

            if ( foreignClass == null ) {
               foreignClass = MetaClass.forName( foreignClassStr );
            }
          }

          // REST HERE
          fKeys.add( new ForeignKeyDef( mf, foreignClass, foreignFieldStr ));
      }
    }

    return fKeys;
  }*/


    /*private boolean isViewOnly( MetaField mf )
    {
	    try {
	      if ( "true".equals( mf.getMetaAttr( IS_VIEWONLY ).getValue())) return true;
	    } catch( MetaDataNotFoundException e ) {}
	    return false;
    }*/

	/** Get the persistence attribute */
    private String getPersistenceAttribute( MetaData md, String ref ) {
    	if ( !md.hasMetaAttr( ref )) return null;
		Object r = md.getMetaAttr( ref ).getValue();
		if ( r != null ) return r.toString();
		return null;
	}
    
    /**
     * Retrieves the view name from the MetaObject — the {@code @table} of its
     * primary read-only {@code source.rdb} child (source-v2 ADR-0007).
     *
     * @return the view name, or {@code null} if no primary read-only source
     */
    protected String getViewRef( MetaObject mc )
    {
      return mc.getPrimaryRdbViewName();
    }

    /**
     * Retrieves the table name from the MetaObject — the {@code @table} of its
     * primary writable {@code source.rdb} child (source-v2 ADR-0007).
     *
     * @return the table name, or {@code null} if no primary writable source
     */
    protected String getTableRef( MetaObject mc )
    {
      return mc.getPrimaryRdbTableName();
    }

    /**
     * Retrieves the table column for the MetaField: the {@code @column}
     * override if present, else the field name (literal — matching the C#
     * port default + EF Core convention). Cross-port: TS defaults to
     * snake_case via its persistence-layer config, but the Java omdb path
     * doesn't carry a per-loader strategy knob yet, so literal is the safe
     * default that any team can override with {@code @column}.
     *
     * <p>Previously this returned {@code null} when {@code @column} was
     * absent, causing the field to be silently skipped in
     * {@link #loadColumns(java.util.Collection, com.metaobjects.manager.db.defs.BaseTableDef, ObjectMappingDB)}.
     * The new-metadata fixtures don't require an explicit
     * {@code @column} on every field (per the cross-port column-naming
     * contract), so the old behavior emitted empty CREATE TABLEs against
     * them.</p>
     */
    protected String getColumnRef( MetaField mf )
    {
      String col = getPersistenceAttribute( mf, COL_REF );
      return col != null ? col : mf.getName();
    }
    
    /**
     * Retrieves the sequence name for the MetaField
     *
     * @return Returns the sequence name
     * @throws MetaDataException An exception is thrown if the object is not persistable
     */
    public String getSequenceRef( MetaField mf )
    {
      return getPersistenceAttribute( mf, SEQ_REF );
    }

    /**
     * Retrieves the sequence name for the MetaField
     *
     * @return Returns the sequence name
     * @throws MetaDataException An exception is thrown if the object is not persistable
     */
    public int getSequenceStart( MetaField mf )
    {
      int start = 1;
      try {
        start = Integer.parseInt( getPersistenceAttribute( mf, SEQ_START_REF ));
      } catch( Exception e ) {}
      if ( start < 1 ) start = 1;
      return start;
    }

    
    /**
     * Determines whether the MetaField is a key
     */
    public boolean isIndex( MetaField mf )
    {
      try {
        if ( TRUE.equals( mf.getMetaAttr( IS_INDEX ).getValue())) return true;
      } catch( MetaDataNotFoundException e ) {}
      return false;
    }

    /**
     * Determines whether the MetaField is a key
     */
    public boolean isUnique( MetaField mf )
    {
      try {
        if ( TRUE.equals( mf.getMetaAttr( IS_UNIQUE ).getValue())) return true;
      } catch( MetaDataNotFoundException e ) {}
      return false;
    }
}

package com.metaobjects.manager.db.defs;

public class ColumnDef extends BaseArgDef {

	public final static int DEFAULT_LENGTH = -1;
	
	public final static int AUTO_NONE 		= 0;
	public final static int AUTO_ID   		= 1;
	public final static int AUTO_LAST_ID   		= 2;
	public final static int AUTO_DATE_CREATE 	= 3;
	public final static int AUTO_DATE_UPDATE 	= 4;
	/** App-side UUID PK: OMDB mints a java.util.UUID string before INSERT (DB-portable). */
	public final static int AUTO_UUID   		= 5;

	// R6 Plan 2a/2b: dialect-neutral physical column-type hints. When set, a
	// driver renders the native column type for this hint INSTEAD of the type
	// it would derive from the java.sql.Types code (which still drives JDBC
	// get/set). Null means "use the SQLType default". Each driver maps a hint
	// to its own SQL spelling (Postgres native UUID/JSONB/TIMESTAMPTZ; Derby a
	// portable fallback).
	//
	// CANONICAL SOURCE: the metamodel-layer CoreDBMetaDataProvider.DB_COLUMN_TYPE_*
	// constants are the canonical source of these string values. The omdb layer cannot
	// depend on the metadata-layer provider, hence these parallel constants + the
	// SimpleMappingHandlerDB.resolveDbColumnType() mapping from @dbColumnType → COLTYPE_*.
	/** Hint: native UUID column ({@code field.uuid} or {@code @dbColumnType: uuid}). */
	public final static String COLTYPE_UUID = "uuid";
	/** Hint: native JSONB column ({@code @dbColumnType: jsonb}, genuinely-open JSON). */
	public final static String COLTYPE_JSONB = "jsonb";
	// COLTYPE_TIMESTAMP_TZ retired (ADR-0036 Wave 2): timestamp timezone-awareness is
	// no longer a @dbColumnType hint — field.timestamp is timestamptz by default and
	// @localTime is the naive opt-out, read off the field by the timestamp codec.

	private int length = DEFAULT_LENGTH;
	private boolean isPrimaryKey = false;
	private boolean isUnique = false;
	private int autoType = AUTO_NONE;
	private String dbColumnType = null;

	private SequenceDef sequence = null;
	private BaseTableDef baseTable = null;
	//private boolean autoIncrementor = false; 
	
	public ColumnDef( String name, int type ) {
		super( name, type );
	}

	public int getLength() {
		return length;
	}

	public void setLength(int length) {
		this.length = length;
	}
	
	public boolean isAutoIncrementor() {
		return getAutoType() == AUTO_ID || getAutoType() == AUTO_LAST_ID;
	}
        
	//protected void setAutoIncrementor( boolean autoInc ) {
	//	this.autoIncrementor = autoInc;
	//}

	public SequenceDef getSequence() {
		return sequence;
	}

	public void setSequence(SequenceDef sequence) {
		this.sequence = sequence;
		// NOTE: This is not correct!
		//setAutoIncrementor( sequence != null );
		//setAutoType( AUTO_ID );
	}

	public BaseTableDef getBaseTable() {
		return baseTable;
	}

	public void setBaseTable(BaseTableDef table) {
		this.baseTable = table;
	}

	public boolean isPrimaryKey() {
		return isPrimaryKey;
	}

	public void setPrimaryKey( boolean isPrimaryKey ) {
		this.isPrimaryKey = isPrimaryKey;
	}

	public boolean isUnique() {
		return isUnique;
	}

	public void setUnique( boolean isUnique ) {
		this.isUnique = isUnique;
	}

	public int getAutoType() {
		return autoType;
	}

	public void setAutoType(int autoType) {
		this.autoType = autoType;
	}

	/**
	 * The dialect-neutral physical column-type hint (one of {@link #COLTYPE_UUID} /
	 * {@link #COLTYPE_JSONB}), or {@code null} to use the {@link #getSQLType() SQLType}
	 * default. R6 Plan 2a/2b.
	 */
	public String getDbColumnType() {
		return dbColumnType;
	}

	public void setDbColumnType(String dbColumnType) {
		this.dbColumnType = dbColumnType;
	}
}

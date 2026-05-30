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
import java.util.ArrayList;
import java.util.Collection;
import java.util.Date;
import java.util.Map;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import com.metaobjects.object.MetaObject;
import com.metaobjects.MetaDataException;
import com.metaobjects.MetaDataNotFoundException;
import com.metaobjects.io.object.gson.MetaObjectDeserializer;
import com.metaobjects.io.object.gson.MetaObjectGsonInitializer;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.registry.ObjectClassRegistry;
import com.metaobjects.util.MetaDataUtil;
import com.google.gson.Gson;
import com.google.gson.GsonBuilder;

import com.metaobjects.database.CoreDBMetaDataProvider;
import com.metaobjects.field.MetaField;
import com.metaobjects.manager.QueryOptions;
import com.metaobjects.manager.db.DatabaseDriver;
import com.metaobjects.manager.db.ObjectManagerDB;
import com.metaobjects.manager.db.ObjectMappingDB;
import com.metaobjects.manager.db.SubSelectValue;
import com.metaobjects.manager.db.defs.BaseDef;
import com.metaobjects.manager.db.defs.BaseTableDef;
import com.metaobjects.manager.db.defs.ColumnDef;
import com.metaobjects.manager.db.defs.ForeignKeyDef;
import com.metaobjects.manager.db.defs.IndexDef;
import com.metaobjects.manager.db.defs.InheritenceDef;
import com.metaobjects.manager.db.defs.NameDef;
import com.metaobjects.manager.db.defs.SequenceDef;
import com.metaobjects.manager.db.defs.TableDef;
import com.metaobjects.manager.db.defs.ViewDef;
import com.metaobjects.manager.exp.Expression;
import com.metaobjects.manager.exp.ExpressionGroup;
import com.metaobjects.manager.exp.ExpressionOperator;
import com.metaobjects.manager.exp.Range;
import com.metaobjects.manager.exp.SortOrder;

/**
 * The Object Manager Base is able to add, update, delete, and retrieve objects
 * of those types from a datastore.
 */
public class GenericSQLDriver implements DatabaseDriver {

    private static final Logger log = LoggerFactory.getLogger(GenericSQLDriver.class);
    private ObjectManagerDB mManager = null;
    /** Memoized Gson per loader — building Gson iterates all MetaObjects (O(N)); cache it. */
    private final java.util.Map<MetaDataLoader, Gson> gsonCache = new java.util.concurrent.ConcurrentHashMap<>();
    /**
     * Memoized fallback Gson per MetaObject — the fallback branch (no registry binding) was
     * previously building a fresh GsonBuilder on every call; cached here for consistency with the
     * primary {@link #gsonCache} path.  Keyed by MetaObject identity (one entry per distinct
     * referenced MetaObject).
     */
    private final java.util.Map<MetaObject, Gson> fallbackGsonCache = new java.util.concurrent.ConcurrentHashMap<>();

    /**
     * Returns true if the field is declared as a jsonb column via {@code @dbType="jsonb"}.
     * Uses the attr model so jsonb detection works even without a dedicated {@code JsonbField} class.
     */
    protected boolean isJsonbField(MetaField f) {
        try {
            return f.hasMetaAttr(CoreDBMetaDataProvider.DB_TYPE)
                && CoreDBMetaDataProvider.DB_TYPE_JSONB.equals(f.getMetaAttr(CoreDBMetaDataProvider.DB_TYPE).getValueAsString());
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * Returns a memoized {@link Gson} instance with the metaobjects metadata-driven adapters
     * registered for all MetaObjects known to the provided loader.  Building the Gson iterates
     * all MetaObjects in the loader (O(N)); the result is cached per loader instance so the
     * cost is paid only once per {@link MetaDataLoader}.
     */
    private Gson buildGson(MetaDataLoader loader) {
        return gsonCache.computeIfAbsent(loader,
                l -> MetaObjectGsonInitializer.getBuilderWithAdapters(l).create());
    }

    /**
     * Serializes a jsonb field value to a JSON string using the metaobjects
     * metadata-driven {@link Gson} (from {@link MetaObjectGsonInitializer}).
     * <ul>
     *   <li>A {@code ValueObject} value is serialized via the registered
     *       {@code MetaObjectSerializer} (writes {@code @type}).</li>
     *   <li>A registry-bound POJO (e.g. a hand-written class) is serialized
     *       via Gson's default reflection.</li>
     *   <li>A plain {@code Map} or other value falls through to Gson's default
     *       reflection serialization.</li>
     * </ul>
     *
     * @param f     the jsonb MetaField (provides the {@link MetaDataLoader})
     * @param value the object to serialize
     * @return JSON string
     */
    protected String serializeJsonb(MetaField f, Object value) {
        try {
            return buildGson(f.getLoader()).toJson(value);
        } catch (Exception e) {
            throw new IllegalStateException("jsonb serialize failed for field [" + f + "]: " + e, e);
        }
    }

    /**
     * Hook for per-dialect identifier quoting in generated SQL (SELECT,
     * WHERE, ORDER BY, UPDATE SET, etc.). Default: identity — the legacy
     * unquoted form keeps Derby + the existing object-mapping consumers
     * working unchanged. {@link com.metaobjects.manager.db.driver.PostgresDriver}
     * overrides to wrap in {@code "..."} so mixed-case columns (e.g.
     * {@code "programId"}) survive PG case-folding.
     */
    protected String quoteIdent(String name) {
        return name;
    }

    /**
     * Deserializes a jsonb JSON string to a typed object.
     * <p>
     * Resolution order for the target class:
     * <ol>
     *   <li>If the field has an {@code @objectRef} attribute and the
     *       {@link ObjectClassRegistry} has a binding for that name, deserialize
     *       using Gson's default reflection into the bound class (registry wins for
     *       explicit POJO bindings).</li>
     *   <li>Otherwise, deserialize via a {@link MetaObjectDeserializer} bound to the
     *       referenced {@link MetaObject}; this returns a {@code ValueObject} (or
     *       whichever class the MetaObject declares via its {@code @object} attribute).
     *       That variant does not require an {@code @type} field in the JSON, so plain
     *       JSON written by Gson's default reflection (e.g. a Map) round-trips cleanly.</li>
     * </ol>
     *
     * @param f    the jsonb MetaField (carries {@code @objectRef} and the loader)
     * @param json the JSON string read from the database column
     * @return deserialized object
     */
    protected Object deserializeJsonb(MetaField f, String json) {
        try {
            // Step 1: registry-bound typed POJO wins, deserialized via Gson reflection.
            if (MetaDataUtil.hasObjectRef(f)) {
                Class<?> bound = ObjectClassRegistry.global().resolve(resolveObjectRefFqn(f));
                if (bound != null) {
                    return buildGson(f.getLoader()).fromJson(json, bound);
                }
            }
            // Step 2: fall back to the MetaObject's declared class (e.g. ValueObject).
            // Resolve refClass before the lambda — getObjectClass() throws a checked exception
            // that cannot propagate from inside computeIfAbsent.
            MetaObject refMo = MetaDataUtil.getObjectRef(f);
            Class<?> refClass = refMo.getObjectClass();
            Gson fallbackGson = fallbackGsonCache.computeIfAbsent(refMo,
                    m -> new GsonBuilder()
                            .registerTypeAdapter(refClass, new MetaObjectDeserializer(m))
                            .create());
            return fallbackGson.fromJson(json, refClass);
        } catch (Exception e) {
            throw new IllegalStateException("jsonb deserialize failed for field [" + f + "]: " + e, e);
        }
    }

    /**
     * Returns the canonical FQN for the field's {@code @objectRef}, reusing the cached
     * {@link MetaDataUtil#getObjectRef} resolution rather than duplicating the expansion logic.
     */
    private String resolveObjectRefFqn(MetaField f) throws MetaDataNotFoundException {
        return MetaDataUtil.getObjectRef(f).getName();
    }

    /**
     * This is to handle arguments for the constructed SQL query to ensure
     * proper type conversion
     *
     * @author Doug
     */
    public class SQLArg {

        private MetaField metaField = null;
        private Object value = null;

        public SQLArg(MetaField f, Object value) {
            this.metaField = f;
            this.value = value;
        }

        public MetaField getMetaField() {
            return metaField;
        }

        public Object getValue() {
            return value;
        }
    }

    public GenericSQLDriver() {
    }

    public void setManager(ObjectManagerDB man) {
        mManager = man;
    }

    /**
     * Returns the Object Manager
     */
    public ObjectManagerDB getManager() {
        return mManager;
    }

    @Override
    public boolean checkTable(Connection c, TableDef table) throws SQLException {
        return checkBaseTable(c, table);
    }

    @Override
    public boolean checkView(Connection c, ViewDef view) throws SQLException {
        return checkBaseTable(c, view);
    }

    /**
     * Checks for the existence of the base table and optionally creates it if
     * it doesn't exist
     *
     * @param c Database connection to use
     * @param baseTable Base Table Definition (Table or View)
     * @param autoCreate Whether to auto create the table or view
     * @return Whether the table or view exists
     * @throws SQLException Exception if it exists in an invalid format
     */
    protected boolean checkBaseTable(Connection c, BaseTableDef baseTable)
            throws SQLException {
        String schema = baseTable.getNameDef().getSchema();
        String name = baseTable.getNameDef().getName().toUpperCase();

        // VALIDATE TABLE OR VIEW
        ResultSet rs = c.getMetaData().getTables(null, schema, name, null);
        try {
            boolean found = false;
            while (rs.next()) {
                if (name.equalsIgnoreCase(rs.getString(3))) {
                    found = true;
                    break;
                }
            }

            if (!found) {
                // throw new TableDoesNotExistException( "Table or View [" +
                // baseTable.getNameDef() + "] does not exist" );
                return false;
            }
        } finally {
            rs.close();
        }

        // VALIDATE THE COLUMNS
        for (ColumnDef col : baseTable.getColumns()) {
            rs = c.getMetaData().getColumns(null, schema, name, col.getName().toUpperCase());
            try {
                boolean found = false;
                while (rs.next()) {
                    if (col.getName().equalsIgnoreCase(rs.getString(4))) {
                        found = true;
                        break;
                    }
                }

                if (!found) {
                    throw new SQLException("Table or View ["
                            + baseTable.getNameDef()
                            + "] does not have a Column [" + col.getName()
                            + "]");
                }
            } finally {
                rs.close();
            }
        }

        return true;
    }

    protected String getLastAutoId(Connection conn, ColumnDef col) throws SQLException {
        throw new IllegalStateException("This should not get called");
    }

    /**
     * Generic {@code MAX(col) + 1} fallback for the next auto-id.
     *
     * <p><strong>Single-writer / test-only.</strong> This is the base-class fallback used
     * when a dialect provides no native sequence or identity column. It is <em>not</em>
     * concurrency-safe: two concurrent writers can read the same {@code MAX} and collide.
     * Real dialects override id generation with database sequences or identity/auto-increment
     * columns; this exists only for simple embedded/test scenarios with a single writer.</p>
     *
     * <p>The {@code MAX} result is parsed as a {@code long} so BIGINT / {@code LongField}
     * ids above {@link Integer#MAX_VALUE} are not truncated.</p>
     */
    protected String getNextAutoId(Connection conn, ColumnDef col) throws SQLException {
        // String table = getManager().getTableName( mc );
        // if ( table == null )
        // throw new MetaDataException( "MetaClass [" + mc + "] has no table
        // defined" );

        // String col = getManager().getColumnName( mf );
        // if ( col == null )
        // throw new MetaDataException( "MetaField [" + mf + "] has no column
        // defined" );

        StringBuilder query = new StringBuilder();
        try {
            // Get next next MAX() sequence
            Statement s = conn.createStatement();
            try {
                query.append("SELECT MAX( ").append(quoteIdent(col.getName())).append(" )")
                        .append("FROM ").append(
                        getProperName(col.getBaseTable().getNameDef()));

                ResultSet rs = s.executeQuery(query.toString());

                try {
                    if (!rs.next()) {
                        return "1";
                    }

                    String tmp = rs.getString(1);

                    if (tmp == null) {
                        return "1";
                    }

                    long i = Long.parseLong(tmp) + 1;

                    return Long.toString(i);
                } finally {
                    rs.close();
                }
            } finally {
                s.close();
            }
        } catch (SQLException e) {
            log.error("Unable to get next id for column [" + col
                    + "] with query [" + query + "]: " + e.getMessage(), e);
            throw new SQLException("Unable to get next id for column [" + col
                    + "]: " + e.getMessage(), e);
        }
    }

    /**
     * Creates a table in the database
     */
    @Override
    public void createTable(Connection c, TableDef tableDef)
            throws SQLException {
        throw new UnsupportedOperationException("CREATE TABLE NOT IMPLEMENTED!");
    }

    /**
     * Deletes a table from the database
     */
    @Override
    public void deleteTable(Connection c, TableDef tableDef)
            throws SQLException {
        throw new UnsupportedOperationException("DELETE TABLE NOT IMPLEMENTED!");
    }

/**
	 * Creates a view in the database
	 */
	@Override
	public void createView( Connection c, ViewDef view ) throws SQLException
	{
            StringBuilder query = new StringBuilder();
            try {
                String name = getProperName( view.getNameDef() );
                query.append( "CREATE VIEW " )
                    .append( name )
                    .append( " AS " )
                    .append( view.getSQL() );

                if ( log.isDebugEnabled() ) {
                    log.debug( "Creating view: " + query.toString() );
                }
                //ystem.out.println( ">>>> Creating View: " + query);

                Statement s = c.createStatement();
                try {
                     s.execute( query.toString() );
                } finally {
                     s.close();
                }
            }
            catch (Exception e) {
                    throw new SQLException( "Creation of view [" + view + "] failed using SQL [" + query + "]: " + e.getMessage(), e );
            }
    }


    /**
     * Creates the sequence in the database
     */
    public void createSequence(Connection c, SequenceDef sequenceDef)
            throws SQLException {
        throw new UnsupportedOperationException(
                "CREATE SEQUENCE NOT IMPLEMENTED!");
    }

    /**
     * Creates the index in the database
     */
    public void createIndex(Connection c, IndexDef indexDef)
            throws SQLException {
        // Do Nothing
    }

    /**
     * Creates the foreign keys for the table in the database
     */
    @Override
    public void createForeignKey(Connection c, ForeignKeyDef foreignKeyDef)
            throws SQLException {
        // DO Nothing
    }

    /**
     * Returns the proper name of the table or view
     *
     * @param nameDef
     * @return
     */
    public String getProperName(NameDef nameDef) {
        return nameDef.getFullname();
    }

    @Override
    public boolean create(Connection c, MetaObject mc, ObjectMappingDB omdb,
            Object o) throws SQLException {

        // Check if there is table inheritence going on, and if so create the super table first
        BaseDef base = omdb.getDBDef();
        if (base instanceof TableDef) {
            TableDef table = (TableDef) base;

            InheritenceDef inheritence = table.getInheritence();
            if (inheritence != null) {
                ObjectMappingDB smom = (ObjectMappingDB) omdb.getSuperMapping();

                // Set the discriminator values
                if (inheritence.getDiscriminatorName() != null) {
                    MetaField df = omdb.getField(inheritence.getDiscriminatorName());
                    df.setString(o, inheritence.getDiscriminatorValue());
                }

                // Create the super classes table entry
                if (!create(c, mc, smom, o)) {
                    throw new SQLException("Super table entry could not be created for mapping [" + smom + "]");
                }

                // Set the mapping field
                MetaField rf = omdb.getField(inheritence.getRefColumn());
                MetaField f = omdb.getField(inheritence.getColumnName());
                f.setObject(o, rf.getObject(o));
            }
        }

        // Now create the entry for this object
        PreparedStatement s = getInsertStatement(c, mc, omdb, o);

        try {
            s.execute();

            if (s.getUpdateCount() < 1) {
                return false;
            } else {

                setLastIds( c, mc, omdb, o);

                return true;
            }
        } finally {
            s.close();
        }
    }

    /** 
     * Sets any ids that were auto populated 
     */
    protected void setLastIds( Connection c, MetaObject mc, ObjectMappingDB omdb, Object o ) throws SQLException {
        
        for (MetaField f : omdb.getMetaFields() ) {

            ColumnDef colDef = (ColumnDef) omdb.getArgDef(f);        

            if ( colDef.getAutoType() == ColumnDef.AUTO_LAST_ID ) {
                f.setString( o, getLastAutoId(c, colDef));
            }
        }
    }
    
    @Override
    public boolean read(Connection c, MetaObject mc, ObjectMappingDB mapping,
            Object o, Expression exp) throws SQLException {

        // Get the fields to read
        Collection<MetaField> fields = mapping.getMetaFields();

        QueryOptions qo = new QueryOptions(exp);
        qo.setRange(1, 1);

        PreparedStatement s = getSelectStatementWhere(c, mc, mapping, fields, qo);

        try {
            ResultSet rs = s.executeQuery();

            try {
                if (rs.next()) {

                    // Parse the Object
                    parseObject(rs, fields, mc, o);

                    return true;
                }

                return false;
            } finally {
                rs.close();
            }
        } finally {
            s.close();
        }
    }

    @Override
    public boolean update(Connection c, MetaObject mc, ObjectMappingDB omdb,
            Object o, Collection<MetaField> fields, Collection<MetaField> keys,
            MetaField dirtyField, Object dirtyValue) throws SQLException {

        Expression exp = null;

        // Check if there is table inheritence going on, and if so delete the super table first
        BaseDef base = omdb.getDBDef();
        if (base instanceof TableDef) {
            TableDef table = (TableDef) base;

            InheritenceDef inheritence = table.getInheritence();
            if (inheritence != null) {

                ObjectMappingDB smom = (ObjectMappingDB) omdb.getSuperMapping();

                // Setup the key
                MetaField rf = omdb.getField(inheritence.getRefColumn());
                Collection<MetaField> pkeys = new ArrayList<MetaField>();
                pkeys.add(rf);

                // Create the super classes table entry
                if (!update(c, mc, smom, o, fields, pkeys, dirtyField, dirtyValue)) {
                    return false;
                    // throw new SQLException( "Super table entry could not be updated for mapping [" + smom + "]" );
                }

                // Set the mapping field
                MetaField f = omdb.getField(inheritence.getColumnName());

                // Set the expression to delete
                exp = new Expression(f.getName(), rf.getObject(o));

                // Can only have dirty fields on the highest level of inheritence
                dirtyField = null;
                dirtyValue = null;
            }
        }

        // If there wasn't inheritence, then generate the delete where clause
        if (exp == null) {
            // Generate the keys expression
            for (MetaField mf : keys) {
                //if ( omdb.isInThisMap( mf )) {
                Expression e = new Expression(mf.getName(), mf.getObject(o));
                if (exp == null) {
                    exp = e;
                } else {
                    exp = exp.and(e);
                }
                //}
            }
        }

        // Add the dirty field expression
        if (dirtyField != null) {

            Expression e = new Expression(dirtyField.getName(), dirtyValue);
            if (exp == null) {
                exp = e;
            } else {
                exp = exp.and(e);
            }
        }

        //setAutoFields( c, mc, omdb, fields, o, ObjectManager.UPDATE );

        Collection<MetaField> fieldsInMap = new ArrayList<MetaField>();
        for (MetaField mf : fields) {
            if (omdb.isInThisMap(mf)) {
                fieldsInMap.add(mf);
            }
        }

        if (fieldsInMap.size() == 0) {
            return true;
        }

        PreparedStatement s = getUpdateStatement(c, omdb, fieldsInMap, mc, o, exp);

        try {
            int rc = s.executeUpdate();
            if (rc > 0) {
                return true;
            } else {
                return false;
            }
        } finally {
            s.close();
        }
    }

    @Override
    public boolean delete(Connection c, MetaObject mc, ObjectMappingDB omdb,
            Object o, Collection<MetaField> keys)
            throws SQLException {

        // Check if there is table inheritence going on, and if so delete the super table first
        BaseDef base = omdb.getDBDef();
        if (base instanceof TableDef) {
            TableDef table = (TableDef) base;

            InheritenceDef inheritence = table.getInheritence();
            if (inheritence != null) {
                ObjectMappingDB smom = (ObjectMappingDB) omdb.getSuperMapping();

                MetaField rf = omdb.getField(inheritence.getRefColumn());
                Collection<MetaField> pkeys = new ArrayList<MetaField>();
                pkeys.add(rf);

                // Set the mapping field
                MetaField f = omdb.getField(inheritence.getColumnName());

                // Set the expression to delete
                Expression exp = new Expression(f.getName(), rf.getObject(o));

                // Delete the higher level table first
                boolean result = executeDelete(c, mc, omdb, exp);

                // Return a false if it was not deleteable
                if (result == false) {
                    return false;
                }

                // Delete the super classes table entry
                if (!delete(c, mc, smom, o, pkeys)) {
                    throw new SQLException("Super table entry could not be deleted for mapping [" + smom + "]");
                }

                return result;
            }
        }

        // If there wasn't inheritence, then generate the delete where clause

        // Generate the keys expression
        Expression exp = null;
        for (MetaField mf : keys) {
            Expression e = new Expression(mf.getName(), mf.getObject(o));
            if (exp == null) {
                exp = e;
            } else {
                exp = exp.and(e);
            }
        }

        //setAutoFields( c, mc, omdb, fields, o, ObjectManager.UPDATE );

        return executeDelete(c, mc, omdb, exp);
    }

    /**
     * Perform the actual delete call
     */
    protected boolean executeDelete(Connection c, MetaObject mc, ObjectMappingDB omdb, Expression exp) throws MetaDataException, SQLException {

        PreparedStatement s = getDeleteStatementWhere(c, mc, omdb, exp);

        try {
            int rc = s.executeUpdate();
            if (rc == 1) {
                return true;
            } else {
                return false;
            }
        } finally {
            s.close();
        }
    }

    @Override
    public long getCount(Connection c, MetaObject mc,
            ObjectMappingDB mapping, Expression exp) throws SQLException {

        PreparedStatement s = getCountStatementWhere(c, mc, mapping, exp);

        try {
            ResultSet rs = s.executeQuery();
            try {
                if (rs.next()) {
                    return rs.getLong(1);
                } else {
                    return 0;
                }
            } finally {
                rs.close();
            }
        } finally {
            s.close();
        }
    }

    @Override
    public Collection<Object> readMany(Connection c, MetaObject mc,
            ObjectMappingDB mapping, QueryOptions options) throws SQLException {

        if (options.withLock() && !(mapping.getDBDef() instanceof TableDef)) {
            throw new SQLException("Can only lock when reading from a Table, not a [" + mapping.getDBDef() + "]");
        }

        // Get the fields to read
        Collection<MetaField> fields = options.getFields();
        if (fields == null || fields.size() == 0) {
            fields = mapping.getMetaFields();
        }

        PreparedStatement s = getSelectStatementWhere(c, mc, mapping, fields, options);

        ArrayList<Object> objects = new ArrayList<Object>();

        try {
            ResultSet rs = s.executeQuery();

            // If the range is not supported in the query, then we need to do it manually
            Range range = (!supportsRangeInQuery()) ? options.getRange() : null;

            int index = 1;

            try {
                while (rs.next()) {
                    if (range == null
                            || (index >= range.getStart() && index <= range
                            .getEnd())) {
                        // Get a new Object
                        Object o = getManager().getNewObject(mc);

                        // Parse the Object
                        parseObject(rs, fields, mc, o);

                        // Add the object to the returned array
                        objects.add(o);
                    }

                    index++;
                }
            } finally {
                rs.close();
            }
        } finally {
            s.close();
        }

        return objects;
    }

    @Override
    public int updateMany(Connection c, MetaObject mc, ObjectMappingDB mapping,
            Map<MetaField, Object> values, Expression exp) throws SQLException {

        throw new UnsupportedOperationException("UpdateMany not supported by this Driver");
    }

    @Override
    public int deleteMany(Connection c, MetaObject mc, ObjectMappingDB mapping,
            Expression exp) throws SQLException {

        PreparedStatement s = getDeleteStatementWhere(c, mc, mapping, exp);

        try {
            return s.executeUpdate();
        } finally {
            s.close();
        }
    }

    /**
     * The SQL query to append to a SQL SELECT to lock the returned rows
     */
    public String getLockString() {
        throw new UnsupportedOperationException(
                "The GenericDriver cannot lock rows for updating");
    }

    public String getDateFormat() {
        return "yyyy-MM-dd HH:mm:ss";
    }

    /**
     * Returns whether the drive supports the Range within the query, i.e. LIMIT
     */
    protected boolean supportsRangeInQuery() {
        return false;
    }

    /**
     * Returns the SQL portion of the range string
     */
    public String getRangeString(Range range) {
        throw new UnsupportedOperationException(
                "The GenericDriver cannot perform a range during select");
    }

    /**
     * Whether this driver's range/paging clause requires an ORDER BY to be
     * well-formed. ANSI {@code OFFSET ? ROWS FETCH NEXT ? ROWS ONLY} (SQL Server
     * 2012+, Oracle 12c+) is only valid when preceded by an ORDER BY; LIMIT/OFFSET
     * (Postgres) and Derby's FETCH FIRST do not have this requirement. When true
     * and a paged query supplies no explicit sort, {@link #getDefaultRangeOrderBy()}
     * is appended before the range clause.
     */
    protected boolean rangeRequiresOrderBy() {
        return false;
    }

    /**
     * The fallback ORDER BY clause to append when a paged query supplies no
     * explicit sort order and {@link #rangeRequiresOrderBy()} is true. Drivers
     * that require ORDER BY for paging override this.
     */
    protected String getDefaultRangeOrderBy() {
        throw new UnsupportedOperationException(
                "Driver does not define a default range ORDER BY clause");
    }

    /**
     * Concatonates the list of field names together
     */
    protected String getFieldString(ObjectMappingDB omdb, Collection<MetaField> fields, String prefix) {
        return getFieldString(omdb, fields, true, prefix);
    }

    /**
     * Concatonates the list of field names together
     */
    protected String getFieldString(ObjectMappingDB omdb, Collection<MetaField> fields, boolean selectOnly, String prefix) {

        // Setup the select fields string
        StringBuilder buf = new StringBuilder();
        int j = 0;
        for (MetaField mf : fields) {

            ColumnDef colDef = (ColumnDef) omdb.getArgDef(mf);

            // Do not use the field if it's an auto-incrementor (both AUTO_ID and AUTO_LAST_ID)
            // This prevents attempts to insert values into identity/auto-increment columns
            if ( !selectOnly && colDef.isAutoIncrementor() ) continue;

            if (j > 0) {
                buf.append(",");
            }

            if (prefix != null) {
                buf.append(prefix).append(".");
            }
            buf.append(quoteIdent(colDef.getName()));

            j++;
        }

        return buf.toString();
    }

    /**
     * <p> Concatonates the list of ?'s for each field in the collection </p>
     */
    protected String getValueStringForFields(ObjectMappingDB omdb, Collection<MetaField> fields) {

        //return getQuestionCommaString(fields.size());
        
        int j = 0;
         for ( MetaField mf : fields ) {
			
            ColumnDef colDef = (ColumnDef) omdb.getArgDef(mf);

            // Only count fields that are not auto-incrementors (both AUTO_ID and AUTO_LAST_ID)
            // This ensures the parameter count matches the field count in INSERT statements
            if ( !colDef.isAutoIncrementor() ) j++;
         }

         return getQuestionCommaString(j);
    }

    /**
     * <p> Concatonates the list of ?'s for each field in the collection </p>
     */
    protected String getQuestionCommaString(int size) throws MetaDataException {
        // Setup the select fields string
        StringBuilder buf = new StringBuilder();
        for (int j = 0; j < size; j++) {
            if (j > 0) {
                buf.append(",");
            }
            buf.append('?');
        }

        return buf.toString();
    }

    /**
     * Gets the SQL SET clause for the fields of a class
     */
    protected String getSetString(ObjectMappingDB omdb, Collection<MetaField> fields) {

        StringBuilder set = new StringBuilder();

        // Setup the SET clause
        for (MetaField mf : fields) {

            ColumnDef colDef = (ColumnDef) omdb.getArgDef(mf);

            // Don't try to set the id field
            if (colDef.isAutoIncrementor()) {
                continue;
            }

            if (set.length() > 0) {
                set.append(", ");
            }
            set.append(quoteIdent(colDef.getName()));
            set.append("=?");
        }

        return set.toString();
    }

    /**
     * Gets the ORDER BY clause
     */
    protected String getOrderString(MetaObject mc, ObjectMappingDB omdb, SortOrder order) throws MetaDataException {

        StringBuilder b = new StringBuilder();

        boolean first = true;
        while (order != null) {

            if (first) {
                first = false;
            } else {
                b.append(", ");
            }

            MetaField mf = mc.getMetaField(order.getField());

            char prefix = 'A';
            ColumnDef colDef = (ColumnDef) omdb.getArgDef(mf);
            if (colDef == null) {
                throw new MetaDataException("MetaField [" + mf + "] has no column mapping for [" + omdb + "]");
            }

            if (mf instanceof com.metaobjects.field.StringField) {
                b.append("UPPER(");
                b.append(prefix).append(".");
                b.append(quoteIdent(colDef.getName()));
                b.append(')');
            } else {
                b.append(prefix).append(".");
                b.append(quoteIdent(colDef.getName()));
            }

            if (order.getOrder() == SortOrder.DESC) {
                b.append(" DESC");
            }

            order = order.getNext();
        }

        return b.toString();
    }

    /**
     * Gets the SQL WHERE clause for the fields of a class
     */
    protected String getExpressionString(MetaObject mc, ObjectMappingDB omdb, Expression exp,
            ArrayList<SQLArg> args, String prefix) throws MetaDataException {
        StringBuilder set = new StringBuilder();

        if (exp instanceof ExpressionGroup) {
            set.append("( ");
            set.append(getExpressionString(mc, omdb, ((ExpressionGroup) exp)
                    .getGroup(), args, prefix));
            set.append(" )");
        } else if (exp instanceof ExpressionOperator) {
            ExpressionOperator oper = (ExpressionOperator) exp;

            set.append(getExpressionString(mc, omdb, oper.getExpressionA(), args, prefix));

            if (oper.getOperator() == ExpressionOperator.AND) {
                set.append(" AND ");
            } else {
                set.append(" OR ");
            }

            set.append(getExpressionString(mc, omdb, oper.getExpressionB(), args, prefix));
        } else if (exp.isSpecial()) {
            throw new IllegalArgumentException(
                    "Unsupported Special Expression [" + exp + "]");
        } else {
            MetaField f = mc.getMetaField(exp.getField());

            ColumnDef colDef = (ColumnDef) omdb.getArgDef(f);
            if (colDef == null) {
                throw new MetaDataException("MetaField [" + f + "] has no column mapping defined for [" + omdb + "]");
            }

            int c = exp.getCondition();

            if (c == Expression.CONTAIN || c == Expression.NOT_CONTAIN
                    || c == Expression.START_WITH
                    || c == Expression.NOT_START_WITH
                    || c == Expression.END_WITH
                    || c == Expression.NOT_END_WITH
                    || c == Expression.EQUALS_IGNORE_CASE) {
                set.append("UPPER(");
                if (prefix != null) {
                    set.append(prefix).append(".");
                }
                set.append(quoteIdent(colDef.getName()));
                set.append(')');
            } else {
                if (prefix != null) {
                    set.append(prefix).append(".");
                }
                set.append(quoteIdent(colDef.getName()));
            }

            set.append(' ');

            if (exp.getValue() == null) {
                switch (c) {
                    case Expression.EQUAL:
                        set.append("IS NULL");
                        break;
                    case Expression.NOT_EQUAL:
                        set.append("IS NOT NULL");
                        break;
                    default:
                        throw new IllegalArgumentException(
                                "Null values not allowed for condition ["
                                + Expression.condStr(c) + "]");
                }
            } else if (exp.getValue() instanceof SubSelectValue) {

                if (c != Expression.EQUAL && c != Expression.NOT_EQUAL) {
                    throw new IllegalArgumentException("Can only have a value of type Collection for EQUAL or NOT_EQUAL comparisons");
                }

                if (c == Expression.NOT_EQUAL) {
                    set.append("NOT ");
                }
                set.append("IN (");
                set.append(((SubSelectValue) exp.getValue()).getSql());
                set.append(")");
            } else if (exp.getValue() instanceof Collection) {

                if (c != Expression.EQUAL && c != Expression.NOT_EQUAL) {
                    throw new IllegalArgumentException("Can only have a value of type Collection for EQUAL or NOT_EQUAL comparisons");
                }

                if (c == Expression.NOT_EQUAL) {
                    set.append("NOT ");
                }
                set.append("IN (");

                boolean first = true;
                for (Object o : ((Collection<?>) exp.getValue())) {
                    if (first) {
                        first = false;
                    } else {
                        set.append(",");
                    }
                    set.append("?");
                    args.add(new SQLArg(f, o));
                }

                set.append(")");
            } else {
                // Add these on as arguments
                switch (c) {
                    case Expression.EQUAL:
                        set.append("= ?");
                        break;
                    case Expression.NOT_EQUAL:
                        set.append("<> ?");
                        break;
                    case Expression.GREATER:
                        set.append("> ?");
                        break;
                    case Expression.LESSER:
                        set.append("< ?");
                        break;
                    case Expression.EQUAL_GREATER:
                        set.append(">= ?");
                        break;
                    case Expression.EQUAL_LESSER:
                        set.append("<= ?");
                        break;

                    case Expression.EQUALS_IGNORE_CASE:
                    case Expression.CONTAIN:
                    case Expression.START_WITH:
                    case Expression.END_WITH:
                        set.append("LIKE UPPER(?)");
                        break;

                    case Expression.NOT_CONTAIN:
                    case Expression.NOT_START_WITH:
                    case Expression.NOT_END_WITH:
                        set.append("NOT LIKE UPPER(?)");
                        break;

                    default:
                        throw new IllegalArgumentException(
                                "Unsupported Expression Conditional ("
                                + exp.getCondition() + ") for Expression ["
                                + exp + "]");
                }

                // Only add an argument if it's not null

                if (c == Expression.EQUAL || c == Expression.NOT_EQUAL
                        || c == Expression.GREATER || c == Expression.LESSER
                        || c == Expression.EQUAL_GREATER
                        || c == Expression.EQUAL_LESSER) {
                    args.add(new SQLArg(f, exp.getValue()));
                } else if (c == Expression.CONTAIN
                        || c == Expression.NOT_CONTAIN
                        || c == Expression.START_WITH
                        || c == Expression.NOT_START_WITH
                        || c == Expression.END_WITH
                        || c == Expression.NOT_END_WITH
                        || c == Expression.EQUALS_IGNORE_CASE) {
                    String val = (exp.getValue() == null) ? null : exp
                            .getValue().toString();

                    switch (c) {
                        case Expression.CONTAIN:
                        case Expression.NOT_CONTAIN:
                            val = "%" + val + "%";
                            break;

                        case Expression.END_WITH:
                        case Expression.NOT_END_WITH:
                            val = "%" + val;
                            break;

                        case Expression.START_WITH:
                        case Expression.NOT_START_WITH:
                            val = val + "%";
                            break;

                        case Expression.EQUALS_IGNORE_CASE:
                            // val = val;   
                            break;
                    }

                    args.add(new SQLArg(f, val));
                } else {
                    throw new IllegalStateException(
                            "Invalud Expression Condition ["
                            + Expression.condStr(c) + "]");
                }
            }

            // set.append( " ?" );
        }

        return set.toString();
    }

    /**
     * Gets the SQL WHERE clause for the keys of a class
     */
    protected String getWhereStringForKeys(ObjectMappingDB omdb, Collection<MetaField> keys)
            throws MetaDataException {
        StringBuilder where = new StringBuilder();

        // Setup the WHERE clause
        for (MetaField f : keys) {
            ColumnDef colDef = (ColumnDef) omdb.getArgDef(f);
            if (colDef == null) {
                throw new MetaDataException("MetaField [" + f
                        + "] has no column mapping defined for [" + omdb + "]");
            }

            if (where.length() > 0) {
                where.append(" AND ");
            }
            where.append(quoteIdent(colDef.getName()));
            where.append("=?");
        }

        return where.toString();
    }

    /**
     * Gets the id clause for a unique transaction
     */
    protected PreparedStatement getCountStatementWhere(Connection c, MetaObject mc,
            ObjectMappingDB omdb, Expression where)
            throws SQLException, MetaDataException {

        // Construct the SELECT query
        StringBuilder query = new StringBuilder();
        query.append("SELECT COUNT(*) FROM ");

        char prefix = 'A';
        BaseTableDef base = (BaseTableDef) omdb.getDBDef();
        while (base != null) {
            // Get the components of the SELECT query
            String tableStr = getProperName(base.getNameDef());
            query.append(tableStr).append(' ').append(prefix);

            if (base instanceof TableDef) {

                TableDef table = (TableDef) base;
                base = null;

                InheritenceDef idef = table.getInheritence();
                if (idef != null) {
                    base = idef.getRefTable();
                    prefix++;

                    query.append(" LEFT JOIN ");
                    tableStr = getProperName(base.getNameDef());
                    query.append(tableStr).append(' ').append(prefix);
                    query.append(" ON ");
                    query.append(prefix--).append(idef.getColumnName())
                            .append("=").append(prefix).append(quoteIdent(idef.getRefColumn().getName()));
                }
            } else {
                break;
            }
        }

        ArrayList<SQLArg> args = new ArrayList<SQLArg>();

        if (where != null) {
            query.append(" WHERE ").append(getExpressionString(mc, omdb, where, args, "A"));
        }

        PreparedStatement s = c.prepareStatement(query.toString());

        int index = 1;

        StringBuilder valStr = null;
        if (log.isDebugEnabled()) {
            valStr = new StringBuilder(" ");
        }

        if (where != null) {
            for (SQLArg arg : args) {

                MetaField f = arg.getMetaField();
                Object value = arg.getValue();

                if (log.isDebugEnabled() && index > 1) {
                    valStr.append(", ");
                }

                setStatementValue(s, f, index++, value);

                if (log.isDebugEnabled()) {
                    valStr.append("(" + value + ")");
                }
            }
        }

        if (log.isDebugEnabled()) {
            log.debug("SQL (" + c.hashCode()
                    + ") - getCountStatementWhere: [ " + query.toString()
                    + valStr.toString() + " ]");
        }

        // ystem.out.println( ">>> QUERY: " + query.toString() + " " +
        // valStr.toString() );

        return s;
    }

    /**
     * Gets the id clause for a unique transaction
     */
    protected PreparedStatement getSelectStatementWhere(Connection c, MetaObject mc,
            ObjectMappingDB omdb, Collection<MetaField> fields, QueryOptions options)
            throws SQLException, MetaDataException {

        Expression where = options.getExpression();
        SortOrder order = options.getSortOrder();

        // Construct the SELECT query
        StringBuilder query = new StringBuilder();
        query.append("SELECT ");
        if (options.isDistinct()) {
            query.append("DISTINCT ");
        }

        String fieldStr = getFieldString(omdb, fields, "A");

        query.append(fieldStr);

        query.append(" FROM ");

        char prefix = 'A';
        BaseTableDef base = (BaseTableDef) omdb.getDBDef();
        while (base != null) {
            // Get the components of the SELECT query
            String tableStr = getProperName(base.getNameDef());
            query.append(tableStr).append(' ').append(prefix);

            if (base instanceof TableDef) {

                TableDef table = (TableDef) base;
                base = null;

                InheritenceDef idef = table.getInheritence();
                if (idef != null) {
                    base = idef.getRefTable();
                    prefix++;

                    query.append(" LEFT JOIN ");
                    tableStr = getProperName(base.getNameDef());
                    query.append(tableStr).append(' ').append(prefix);
                    query.append(" ON ");
                    query.append(prefix--).append(idef.getColumnName())
                            .append("=").append(prefix).append(quoteIdent(idef.getRefColumn().getName()));
                }
            } else {
                break;
            }
        }

        ArrayList<SQLArg> args = new ArrayList<SQLArg>();

        if (where != null) {
            query.append(" WHERE ").append(getExpressionString(mc, omdb, where, args, "A"));
        }

        Range range = options.getRange();
        boolean applyRange = supportsRangeInQuery() && range != null
                && range.getStart() > 0 && range.getEnd() > 0;

        if (applyRange && range.getStart() > range.getEnd()) {
            throw new IllegalArgumentException("The range end (" + range.getEnd() + ") cannot be greater than the start value (" + range.getStart() + ")");
        }

        if (order != null) {
            query.append(" ORDER BY ").append(getOrderString(mc, omdb, order));
        } else if (applyRange && rangeRequiresOrderBy()) {
            // ANSI OFFSET/FETCH (SQL Server 2012+, Oracle 12c+) is only valid
            // when preceded by an ORDER BY. Supply a deterministic fallback when
            // the caller did not specify a sort order.
            query.append(" ").append(getDefaultRangeOrderBy());
        }

        // Add on the range (must follow ORDER BY for OFFSET/FETCH dialects)
        if (applyRange) {
            query.append(" ").append(getRangeString(range));
        }

        if (options.withLock()) {
            query.append(" ").append(getLockString());
        }

        PreparedStatement s = c.prepareStatement(query.toString());

        int index = 1;

        StringBuilder valStr = null;
        if (log.isDebugEnabled()) {
            valStr = new StringBuilder(" ");
        }

        if (where != null) {
            for (SQLArg arg : args) {

                MetaField f = arg.getMetaField();
                Object value = arg.getValue();

                if (log.isDebugEnabled() && index > 1) {
                    valStr.append(", ");
                }

                setStatementValue(s, f, index++, value);

                if (log.isDebugEnabled()) {
                    valStr.append("(" + value + ")");
                }
            }
        }

        if (log.isDebugEnabled()) {
            log.debug("SQL (" + c.hashCode()
                    + ") - getSelectStatementWhere: [ " + query.toString()
                    + valStr.toString() + " ]");
        }

        // ystem.out.println( ">>> QUERY: " + query.toString() + " " +
        // valStr.toString() );

        return s;
    }

    /**
     * Gets the id clause for a unique transaction
     */
    protected PreparedStatement getDeleteStatementWhere(Connection c,
            MetaObject mc, ObjectMappingDB omdb, Expression where) throws SQLException,
            MetaDataException {

        // Get the components of the SELECT query
        String tableStr = getProperName(omdb.getDBDef().getNameDef());

        // Construct the SELECT query
        StringBuilder query = new StringBuilder("DELETE FROM ");
        query.append(tableStr); //.append( " A");

        ArrayList<SQLArg> args = new ArrayList<SQLArg>();

        if (where != null) {
            query.append(" WHERE ");
            query.append(getExpressionString(mc, omdb, where, args, null));
        }

        PreparedStatement s = c.prepareStatement(query.toString());

        int index = 1;

        StringBuilder valStr = new StringBuilder(" ");

        if (where != null) {
            for (SQLArg arg : args) {

                MetaField f = arg.getMetaField();
                Object value = arg.getValue();

                if (index > 1) {
                    valStr.append(", ");
                }

                setStatementValue(s, f, index++, value);

                valStr.append("(" + value + ")");
            }
        }

        if (log.isDebugEnabled()) {
            log.debug("SQL (" + c.hashCode()
                    + ") - getDeleteStatementWhere: [ " + query.toString()
                    + valStr.toString() + " ]");
        }

        // ystem.out.println( ">>> QUERY: " + query.toString() + " " +
        // valStr.toString() );

        return s;
    }

    /**
     * Sets a specific value on a prepared statement
     */
    /**
     * Binds a value to a prepared-statement parameter via the
     * {@link com.metaobjects.manager.db.codec.JdbcCodecs} registry
     * (FR-003 Plan 4, Debt 1 — ADR-0002). The jsonb pre-check stays here
     * because jsonb serialization depends on driver-local state
     * ({@link #isJsonbField} and {@link #serializeJsonb}), not on field
     * subtype alone.
     *
     * <p>Ordering preservation: in the original ladder, jsonb was checked
     * AFTER explicit field-subtype branches (e.g. StringField) and BEFORE
     * the ObjectField/default branch. Gate the jsonb branch on
     * {@code codec == defaultCodec()} so explicit per-subtype codecs always
     * win, matching prior behavior.
     */
    protected void setStatementValue(PreparedStatement s, MetaField f, int index, Object value) throws SQLException {
        com.metaobjects.manager.db.codec.JdbcFieldCodec codec = com.metaobjects.manager.db.codec.JdbcCodecs.forField(f);
        if (codec == com.metaobjects.manager.db.codec.JdbcCodecs.defaultCodec() && isJsonbField(f)) {
            if (value == null) s.setNull(index, Types.VARCHAR);
            else s.setString(index, serializeJsonb(f, value));
            return;
        }
        codec.write(s, f, index, value);
    }

    /**
     * Gets the id clause for a unique transaction
     */
    protected PreparedStatement getInsertStatement(Connection c, MetaObject mc,
            ObjectMappingDB omdb, Object o) throws SQLException, MetaDataException {

        Collection<MetaField> fields = omdb.getMetaFields();

        // Get the components of the SELECT query
        String tableStr = getProperName(omdb.getDBDef().getNameDef());

        String fieldStr = getFieldString(omdb, fields, false, null);
        String valueStr = getValueStringForFields(omdb, fields);

        // Construct the SELECT query
        String query = "INSERT INTO " + tableStr + " (" + fieldStr + ")"
                + " VALUES (" + valueStr + ")";

        PreparedStatement s = null;

        // Tack on any needed queries to get the keys
        // if ( getDatabaseDriver().getAutoType() == AUTO_DURING )
        // {
        // String add = getDatabaseDriver().getInsertAppendString( mc );
        // if ( add != null && add.length() > 0 ) query += add;

        // s = c.prepareCall( query );
        // }
        // else
        // {
        s = c.prepareStatement(query);
        // }

        StringBuilder valStr = new StringBuilder(" ");

        try {
            int j = 1;
            for (MetaField f : fields) {

                ColumnDef colDef = (ColumnDef) omdb.getArgDef(f);

                // Do not use the field if it's an auto id that is set after
                // after creation/update -- only valid on some drivers (MSSQL)
                //if ( colDef.isAutoIncrementor() )
                //	continue;

                // Set the statement id value
                if (colDef.getAutoType() == ColumnDef.AUTO_ID) {
                    f.setString(o, getNextAutoId(c, colDef));
                }
                else if (colDef.getAutoType() == ColumnDef.AUTO_UUID) {
                    // App-side UUID PK: OMDB mints the value before INSERT (no DB
                    // identity / default). DB-portable as a string column.
                    if (f.getString(o) == null) {
                        f.setString(o, java.util.UUID.randomUUID().toString());
                    }
                }
                else if (colDef.isAutoIncrementor()) {
                    continue;
                }
                // Set the create date (if auto)
                //else if ( colDef.getAutoType() == ColumnDef.AUTO_DATE_CREATE ) {
                //	f.setDate( o, new Date() );
                //}

                setStatementValue(s, f, j, f.getObject(o));

                valStr.append("(" + f.getString(o) + ")");

                j++;
            }

            if (log.isDebugEnabled()) {
                log.debug("SQL (" + c.hashCode() + ") - getInsertStatement: ["
                        + query + valStr.toString() + "]");
            }

            // ystem.out.println( ">>> QUERY: [" + query + "] [" +
            // valStr.toString() + "]" );

            // Return the prepared statement
            return s;
        } catch (SQLException e) {
            s.close();
            throw e;
        }
    }

    /**
     * Gets the update statement for a unique object
     */
    protected PreparedStatement getUpdateStatement(Connection c, ObjectMappingDB omdb,
            Collection<MetaField> fields, MetaObject mc, Object o, Expression exp)
            throws SQLException {

        // WARNING: The query construction should be cached for each MetaClass &
        // field combo

        // validateMetaClass( c, mc );

        // String id = pmc.getId( o );
        //Collection<MetaField> keys = getPrimaryKeys(mc);

        // Get the components of the SELECT query
        String tableStr = getProperName(omdb.getDBDef().getNameDef());

        ArrayList<SQLArg> args = new ArrayList<SQLArg>();

        String setStr = getSetString(omdb, fields);
        String whereStr = getExpressionString(mc, omdb, exp, args, null);

        // Construct the SELECT query
        String query = "UPDATE " + tableStr + " SET " + setStr + " WHERE "
                + whereStr;

        // Used to prevent dirty writes
        //if (dirtyField != null) {
        //	query += " AND ( " + dirtyField.getMetaAttr(COL_REF).getValue() + "=? )";
        //}

        PreparedStatement s = c.prepareStatement(query);

        // ystem.out.println( ">>> QUERY: " + query );

        StringBuilder valStr = new StringBuilder(" ");

        try {
            // Set the update values
            int j = 1;
            for (MetaField f : fields) {

                ColumnDef colDef = (ColumnDef) omdb.getArgDef(f);

                if (colDef.isAutoIncrementor()) {
                    continue;
                }

                // Set the create date (if auto)
                //if ( colDef.getAutoType() == ColumnDef.AUTO_DATE_CREATE ||
                //		colDef.getAutoType() == ColumnDef.AUTO_DATE_UPDATE ) {
                //	f.setDate( o, new Date() );
                //}

                setStatementValue(s, f, j++, f.getObject(o));

                valStr.append("(" + f.getString(o) + ")");
            }

            // Set the WHERE clause arguments
            for (SQLArg arg : args) {

                MetaField f = arg.getMetaField();
                Object value = arg.getValue();

                if (j > 1) {
                    valStr.append(", ");
                }

                setStatementValue(s, f, j++, value);

                // If we're logging, then get the values to log
                if (log.isDebugEnabled()) {

                    String v = null;
                    if (value != null && value instanceof Date) {
                        v = "" + ((Date) value).getTime();
                    } else {
                        v = "" + value;
                    }
                    valStr.append("(" + v + ")");
                }
            }

            // Set the key values - replaced by WHERE clause
            //for (MetaField f : keys) {
            //	setStatementValue(s, f, j++, f.getObject(o));
            //	valStr.append("{" + f.getString(o) + "}");
            //}

            // Used to prevent dirty writes
            //if (dirtyField != null)
            //	setStatementValue(s, dirtyField, j, dirtyFieldValue);

            if (log.isDebugEnabled()) {
                log.debug("SQL (" + c.hashCode() + ") - getUpdateStatement: ["
                        + query + valStr + "]");
            }

            // Return the prepared statement
            return s;
        } catch (SQLException e) {
            s.close();
            throw e;
        }
    }

    /**
     * Parses an Object returned from the database
     */
    protected void parseObject(ResultSet rs, Collection<MetaField> fields,
            MetaObject mc, Object o) throws SQLException, MetaDataException {
        int j = 1;
        for (MetaField f : fields) {
            parseField(o, f, rs, j++);
        }

        // This should be done in the ObjectManager
        // Update the state of the object
		/*
         * if ( mc instanceof StatefulMetaClass ) { // It was pulled from the
         * database, so it doesn't need to be flagged as modified
         * ((StatefulMetaClass) mc ).setModified( o, false );
         *  // It is also no longer a new item ((StatefulMetaClass) mc ).setNew(
         * o, false ); }
         */
    }

    /**
     * Reads a single column from the ResultSet into the target object via the
     * {@link com.metaobjects.manager.db.codec.JdbcCodecs} registry — the same
     * single source of truth used by {@link #setStatementValue} on the write
     * side (FR-003 Plan 4, Debt 1 — ADR-0002). This replaces the former
     * {@code instanceof} ladder, which had drifted from the write-side codec
     * (e.g. TimeField).
     *
     * <p>The jsonb pre-check mirrors {@code setStatementValue}: jsonb
     * serialization depends on driver-local state ({@link #isJsonbField} /
     * {@link #deserializeJsonb}), not on field subtype alone, and is gated on
     * {@code codec == defaultCodec()} so explicit per-subtype codecs always win.
     */
    protected void parseField(Object o, MetaField f, ResultSet rs, int j) throws SQLException {
        com.metaobjects.manager.db.codec.JdbcFieldCodec codec =
                com.metaobjects.manager.db.codec.JdbcCodecs.forField(f);
        if (codec == com.metaobjects.manager.db.codec.JdbcCodecs.defaultCodec() && isJsonbField(f)) {
            // jsonb: read JSON text from the column, deserialize via deserializeJsonb().
            // Step 1 consults ObjectClassRegistry for a bound class (registry wins for
            // explicit POJO bindings); step 2 falls back to MetaObjectDeserializer which
            // returns the MetaObject's declared class (e.g. ValueObject) when no binding
            // is registered.
            String json = rs.getString(j);
            if (json == null || rs.wasNull()) {
                f.setObject(o, null);
            } else {
                f.setObject(o, deserializeJsonb(f, json));
            }
            return;
        }
        codec.readInto(o, f, rs, j);
    }

    // /////////////////////////////////////////////////////
    // TO STRING METHOD
    public String toString() {
        return getClass().getSimpleName();
    }

    // --- MigrationSqlRenderer default: subclasses override for supported dialects ---
    @Override
    public String render(com.metaobjects.manager.db.migrate.Change change) {
        throw new UnsupportedOperationException(
            getClass().getSimpleName() + " does not implement migration render for " + change.kind());
    }
}

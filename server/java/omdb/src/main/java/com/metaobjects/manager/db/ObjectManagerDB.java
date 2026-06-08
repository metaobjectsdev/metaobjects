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
package com.metaobjects.manager.db;

import com.metaobjects.field.MetaField;
import com.metaobjects.manager.StateAwareMetaObject;
import com.metaobjects.object.MetaObject;
import com.metaobjects.*;
import com.metaobjects.manager.*;
import com.metaobjects.manager.db.driver.*;
import com.metaobjects.manager.exp.Expression;
import com.metaobjects.util.MetaDataUtil;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.Collection;
import java.util.Date;
import java.util.LinkedList;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;

import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.sql.Timestamp;
import javax.sql.DataSource;

/**
 * The Object Manager Base is able to add, update, delete, and retrieve objects
 * of those types from a datastore.
 */
public class ObjectManagerDB extends ObjectManager implements DBOperations {

    private static final Logger log = LoggerFactory.getLogger(ObjectManagerDB.class);
    public final static String ALLOW_DIRTY_WRITE = "dbAllowDirtyWrite";
    public final static String DIRTY_WRITE_CHECK_FIELD = "dbDirtyWriteCheckField";
    public final static String POPULATE_FILE = "dbPopulateFile";

    // FR-003 Plan 4 (Debt 2): per-manager atomic mapping caches.
    // Mapping state must NOT live on the shared MetaObject metamodel instance:
    // the loaded metamodel is shared across requests, so a check-then-act on
    // MetaData.cacheValue races under concurrency. computeIfAbsent forbids null
    // values, so we wrap with Optional to represent the legitimate "no mapping"
    // outcome (formerly the has*Map=false case).
    private final ConcurrentHashMap<MetaObject, Optional<ObjectMapping>> createMappings = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<MetaObject, Optional<ObjectMapping>> readMappings = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<MetaObject, Optional<ObjectMapping>> updateMappings = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<MetaObject, Optional<ObjectMapping>> deleteMappings = new ConcurrentHashMap<>();

    private MappingHandler mMappingHandler = null;
    private volatile DatabaseDriver mDriver = null;
    /** Guards lazy initialization of {@link #mDriver} in {@link #getDatabaseDriver()}. */
    private final Object driverInitLock = new Object();
    private DataSource mSource = null;
    private boolean enforceTransaction = false;

    public ObjectManagerDB() {
    }

    /**
     * Handles enforcing transactions on SQL queries
     */
    @Override
    public void setEnforceTransaction(boolean enforce) {
        enforceTransaction = enforce;
    }

    /**
     * Returns whether to enforce transactions
     */
    @Override
    public boolean enforceTransaction() {
        return enforceTransaction;
    }

    /**
     * Checks to see if a transaction exists or not
     */
    protected void checkTransaction(Connection c, boolean throwEx) throws MetaDataException {
        try {
            if (enforceTransaction() && c.getAutoCommit()) {
                MetaDataException me = new MetaDataException("The connection retrieved is not operating under a transaction and transactions are being enforced");
                if (throwEx) {
                    throw me;
                } else {
                    log.warn(me.getMessage(), me);
                }
            }
        } catch (SQLException e) {
            throw new MetaDataException("Error checking connection for transaction enforcement: " + e.getMessage(), e);
        }
    }

    ///////////////////////////////////////////////////////
    // CONNECTION HANDLING METHODS
    //
    /**
     * Retrieves a connection object representing the datastore with enhanced error handling
     */
    @Override
    public ObjectConnection getConnection() throws MetaDataException {
        DataSource ds = getDataSource();
        if (ds == null) {
            throw new IllegalArgumentException("No DataSource was specified for this ObjectManager, cannot request connection");
        }

        try {
            Connection c = ds.getConnection();
            if (c == null) {
                throw new MetaDataException("DataSource returned null connection");
            }
            
            // Verify connection is valid
            if (!c.isValid(5)) { // 5 second timeout
                c.close();
                throw new MetaDataException("Connection is not valid");
            }
            
            return new ObjectConnectionDB(c);
        } catch (SQLException e) {
            throw new MetaDataException("Could not retrieve a connection from the datasource: " + e.getMessage(), e);
        }
    }

    /**
     * Release the Database Connection with improved error handling
     */
    @Override
    public void releaseConnection(ObjectConnection oc) throws MetaDataException {
        if (oc == null) {
            log.warn("Attempting to release null connection");
            return;
        }
        
        try {
            oc.close();
        } catch (Exception e) {
            log.error("Error releasing database connection", e);
            throw new MetaDataException("Failed to release connection properly", e);
        }
    }

    /**
     * Sets the Data Source to use for database connections
     */
    @Override
    public void setDataSource(DataSource ds) {
        mSource = ds;
    }

    /**
     * Retrieves the data source
     */
    @Override
    public DataSource getDataSource() {
        return mSource;
    }

    /**
     * Initializes the ObjectManager
     */
    public void init() throws Exception {
        super.init();

        if (getDataSource() == null) {
            throw new IllegalStateException("No DataSource was specified");
        }
    }

    ///////////////////////////////////////////////////////
    // DATABASE DRIVER METHODS
    //
    @Override
    public void setDriverClass(String className) throws ReflectiveOperationException {
        Class<?> c = Class.forName(className);
        setDatabaseDriver((DatabaseDriver) c.getDeclaredConstructor().newInstance());
    }

    @Override
    public void setDatabaseDriver(Object dd) {
        mDriver = (DatabaseDriver) dd;
        mDriver.setManager(this);
    }

    @Override
    public Object getDatabaseDriver() {
        // Double-checked locking on a volatile field: the common (already-initialized)
        // case is a lock-free volatile read, avoiding contention on this hot CRUD path.
        DatabaseDriver d = mDriver;
        if (d == null) {
            synchronized (driverInitLock) {
                d = mDriver;
                if (d == null) {
                    d = new GenericSQLDriver();
                    d.setManager(this);
                    mDriver = d;
                }
            }
        }
        return d;
    }

    /**
     * Internal method to get the typed database driver
     */
    protected DatabaseDriver getTypedDatabaseDriver() {
        return (DatabaseDriver) getDatabaseDriver();
    }

    ///////////////////////////////////////////////////////
    // PERSISTENCE METHODS
    //
    @Override
    public MappingHandler getDefaultMappingHandler() {
        return new SimpleMappingHandlerDB();
    }

    @Override
    public void setMappingHandler(MappingHandler handler) {
        mMappingHandler = handler;
    }

    @Override
    public MappingHandler getMappingHandler() {
        if (mMappingHandler == null) {
            mMappingHandler = getDefaultMappingHandler();
        }
        return mMappingHandler;
    }

    /**
     * Gets the create mapping
     */
    protected ObjectMapping getCreateMapping(MetaObject mc) {
        return createMappings.computeIfAbsent(mc,
            k -> Optional.ofNullable(getMappingHandler().getCreateMapping(k))).orElse(null);
    }

    /**
     * Gets the read mapping
     */
    protected ObjectMapping getReadMapping(MetaObject mc) {
        return readMappings.computeIfAbsent(mc,
            k -> Optional.ofNullable(getMappingHandler().getReadMapping(k))).orElse(null);
    }

    /**
     * Gets the update mapping
     */
    protected ObjectMapping getUpdateMapping(MetaObject mc) {
        return updateMappings.computeIfAbsent(mc,
            k -> Optional.ofNullable(getMappingHandler().getUpdateMapping(k))).orElse(null);
    }

    /**
     * Gets the delete mapping. The legacy handler reuses the update mapping for
     * deletes — preserved here to keep behavior identical.
     */
    protected ObjectMapping getDeleteMapping(MetaObject mc) {
        return deleteMappings.computeIfAbsent(mc,
            k -> Optional.ofNullable(getMappingHandler().getUpdateMapping(k))).orElse(null);
    }

    /**
     * Is this a createable class
     */
    public boolean isCreateableClass(MetaObject mc) {
        return getCreateMapping(mc) != null;
    }

    /**
     * Is this a readable class
     */
    public boolean isReadableClass(MetaObject mc) {
        return getReadMapping(mc) != null;
    }

    /**
     * Is this an updateable class
     */
    public boolean isUpdateableClass(MetaObject mc) {
        return getUpdateMapping(mc) != null;
    }

    /**
     * Is this a deleteable class
     */
    public boolean isDeleteableClass(MetaObject mc) {
        return getDeleteMapping(mc) != null;
    }

    /**
     * Parses an Object returned from the database
     */
    protected void parseObject(ResultSet rs, Collection<MetaField> fields, MetaObject mc, Object o) throws SQLException, MetaDataException {
        if (!isReadableClass(mc)) {
            throw new MetaDataException("MetaClass [" + mc + "] is not readable");
        }

        int j = 1;
        for (MetaField f : fields) {
            parseField(o, f, rs, j++);
        }

        if (mc instanceof StateAwareMetaObject) {
            // It was pulled from the database, so it doesn't need to be flagged as modified
            ((StateAwareMetaObject) mc).setModified(o, false);

            // It is also no longer a new item
            ((StateAwareMetaObject) mc).setNew(o, false);
        }
    }

    /**
     * Reads a column into a field on the target object via the
     * {@link com.metaobjects.manager.db.codec.JdbcCodecs} registry
     * (FR-003 Plan 4, Debt 1 — ADR-0002).
     */
    protected void parseField(Object o, MetaField f, ResultSet rs, int j) throws SQLException {
        com.metaobjects.manager.db.codec.JdbcCodecs.forField(f).readInto(o, f, rs, j);
    }

    /**
     * Reset the objects to not be new or modified
     */
    protected void resetObjects(MetaObject mc, Collection<Object> objects) {

        if (!(mc instanceof StateAwareMetaObject)) {
            return;
        }

        // Reset all the objects
        for (Object o : objects) {
            resetObject(mc, o);
        }
    }

    /**
     * Reset the object to not be new or modified
     */
    protected void resetObject(MetaObject mc, Object o) {

        if (mc instanceof StateAwareMetaObject) {

            // It was pulled from the database, so it doesn't need to be flagged as modified
            ((StateAwareMetaObject) mc).setModified(o, false);

            // It is also no longer a new item
            ((StateAwareMetaObject) mc).setNew(o, false);
        }
    }

    /**
     * Gets the object by the id; throws exception if it did not exist
     */
    @Override
    public Object getObjectByRef(ObjectConnection c, String refStr) {
        ObjectRef ref = getObjectRef(refStr);
        MetaObject mc = ref.getMetaClass();

        if (!isReadableClass(mc)) {
            throw new PersistenceException("MetaClass [" + mc + "] is not readable");
        }

        ObjectMappingDB readMap = (ObjectMappingDB) getReadMapping(mc);

        Connection conn = (Connection) c.getDatastoreConnection();

        // Check for a valid transaction if enforced
        checkTransaction(conn, false);

        if (log.isDebugEnabled()) {
            log.debug("Loading object [" + mc + "] with reference [" + ref + "]");
        }

        try {

            // Create the Expression for the Primary Keys
            Expression exp = buildPrimaryKeyExpressionFromRef(mc, ref);

            // Create the QueryOptions and limit to the first 1
            QueryOptions qo = new QueryOptions();
            qo.setRange(1, 1);

            // Read the objects from the database driver
            Collection<Object> objects = getTypedDatabaseDriver().readMany(conn, mc, readMap, qo);

            // Reset the object persistence states
            resetObjects(mc, objects);

            // Return the object if found
            if (objects.size() > 0) {
                return objects.iterator().next();
            } else {
                throw new ObjectNotFoundException(refStr);
            }
        } catch (SQLException e) {
            //log.error( "Unable to load object [" + mc + "] with reference [" + ref + "]: " + e.getMessage(), e );
            throw new PersistenceException("Unable to load object [" + mc + "] with reference [" + ref + "]: " + e.getMessage(), e);
        }
    }

    /**
     * FR-017 TPH: AND the discriminator predicate into a query expression when {@code mc}
     * is a TPH subtype, so the read/count/delete is scoped to the subtype (a row of a
     * different subtype is invisible — the runtime's cross-subtype guard, mirroring the
     * generated per-subtype route's 404). Non-TPH classes return {@code exp} unchanged.
     */
    private Expression scopeToSubtype(MetaObject mc, Expression exp) {
        TphHelper.TphSubtype tph = TphHelper.tphSubtypeOf(mc);
        if (tph == null) return exp;
        Expression disc = new Expression(tph.field(), tph.value());
        return exp == null ? disc : exp.and(disc);
    }

    /**
     * Delete the objects from the datastore where the field has the specified
     * value
     */
    @Override
    public int deleteObjects(ObjectConnection c, MetaObject mc, Expression exp) {

        if (!isDeleteableClass(mc)) {
            throw new PersistenceException("MetaClass [" + mc + "] is not deletable");
        }

        exp = scopeToSubtype(mc, exp); // FR-017 TPH: a subtype delete is discriminator-scoped

        ObjectMappingDB mapping = (ObjectMappingDB) getDeleteMapping(mc);

        Connection conn = (Connection) c.getDatastoreConnection();

        // Check for a valid transaction if enforced
        checkTransaction(conn, true);

        if (log.isDebugEnabled()) {
            log.debug("Deleting Objects of Class [" + mc + "] where [" + exp + "]");
        }

        //int failures = 0;
        //while( true )
        //{
        try {
            return getTypedDatabaseDriver().deleteMany(conn, mc, mapping, exp);
        } catch (SQLException e) {
            //log.error( "Unable to delete objects of class [" + mc.getName() + "] with expression [" + exp + "]: " + e.getMessage() );
            //if ( ++failures > 5 )
            throw new PersistenceException("Unable to delete objects of class [" + mc.getName() + "] with expression [" + exp + "]: " + e.getMessage(), e);
        }

        // Sleep on a delete failure
        //try { Thread.sleep( 200 * failures ); }
        //catch (InterruptedException e) {}
        //}
    }

    /**
     * Gets the total count of objects with the specified search criteria
     */
    @Override
    public long getObjectsCount(ObjectConnection c, MetaObject mc, Expression exp) throws MetaDataException {
        if (!isReadableClass(mc)) {
            throw new PersistenceException("MetaClass [" + mc + "] is not persistable");
        }

        Connection conn = (Connection) c.getDatastoreConnection();

        ObjectMappingDB mapping = (ObjectMappingDB) getReadMapping(mc);

        // Check for a valid transaction if enforced
        checkTransaction(conn, false);

        exp = scopeToSubtype(mc, exp); // FR-017 TPH: a subtype count is discriminator-scoped

        try {
            // Read the objects
            return getTypedDatabaseDriver().getCount(conn, mc, mapping, exp);
        } catch (SQLException e) {
            throw new PersistenceException("Unable to get objects count of class [" + mc.getName() + "] with expression [" + exp + "]: " + e.getMessage(), e);
        }
    }

    /**
     * Gets the objects by the field with the specified search criteria
     */
    @Override
    public Collection<?> getObjects(ObjectConnection c, MetaObject mc, QueryOptions options) throws MetaDataException {
        if (!isReadableClass(mc)) {
            throw new PersistenceException("MetaClass [" + mc + "] is not persistable");
        }

        Connection conn = (Connection) c.getDatastoreConnection();

        ObjectMappingDB mapping = (ObjectMappingDB) getReadMapping(mc);

        // Check for a valid transaction if enforced
        checkTransaction(conn, false);

        // FR-017 TPH: a subtype read is discriminator-scoped (a row of a different subtype
        // is invisible); the base entity (no @discriminatorValue) reads the whole table.
        Expression scoped = scopeToSubtype(mc, options.getExpression());
        if (scoped != options.getExpression()) options.setExpression(scoped);

        //int failures = 0;
        //while( true )
        //{
        try {
            // Read the objects
            Collection<Object> objects = getTypedDatabaseDriver().readMany(conn, mc, mapping, options);

            // Reset the object persistence states
            resetObjects(mc, objects);

            // Return the objects
            return objects;
        } catch (SQLException e) {
            //log.error( "Unable to load objects of class [" + mc.getName() + "]: " + e.getMessage() );

            //if ( ++failures > 5 )
            throw new PersistenceException("Unable to get objects of class [" + mc.getName() + "] with options [" + options + "]: " + e.getMessage(), e);
        }

        // Sleep on a read failure
        //try { Thread.sleep( 200 * failures ); }
        //catch (InterruptedException e) {}
        //}
    }

    /**
     * Load the specified object from the database
     */
    public void loadObject(ObjectConnection c, Object o) throws MetaDataException {
        // Verify this object was loaded by the same object manager
        //verifyObjectManager( o );

        // Get the MetaClass for the object
        MetaObject mc = getMetaObjectFor(o);

        // If it's not a readable class throw an exception
        if (!isReadableClass(mc)) {
            throw new PersistenceException("MetaClass [" + mc + "] is not persistable");
        }

        // Get the read mapping
        ObjectMappingDB mapping = (ObjectMappingDB) getReadMapping(mc);

        // Get the connection
        Connection conn = (Connection) c.getDatastoreConnection();

        // Check for a valid transaction if enforced
        checkTransaction(conn, false);

        if (log.isDebugEnabled()) {
            log.debug("Loading object [" + o + "] of class [" + mc + "]");
        }

        // Create the Expression for the Primary Keys
        Expression exp = buildPrimaryKeyExpressionFromObject(mc, o);

        // Try to read the object
        try {
            // Read the object from the mapping
            boolean found = getTypedDatabaseDriver().read(conn, mc, mapping, o, exp);

            // If not found throw an exception
            if (!found) {
                throw new ObjectNotFoundException(o);
            }

            // Reset the object after it's loaded
            resetObject(mc, o);
        } catch (SQLException e) {
            //log.error( "Unable to load object [" + o + "]: " + e.getMessage(), e );
            throw new PersistenceException("Unable to load object [" + o + "]: " + e.getMessage(), e);
        }
    }

    /**
     * Add the specified object to the datastore
     */
    @Override
    public void createObject(ObjectConnection c, Object obj) throws PersistenceException {
        Connection conn = (Connection) c.getDatastoreConnection();

        // Check for a valid transaction if enforced
        checkTransaction(conn, true);

        MetaObject mc = getMetaObjectFor(obj);

        if (!isCreateableClass(mc)) {
            throw new PersistenceException("Object of class [" + mc + "] is not createable");
        }

        // FR-017 TPH: a subtype create injects its discriminator value (the entity names
        // the subtype; the caller never sets `type`) BEFORE the write so it persists.
        TphHelper.TphSubtype tph = TphHelper.tphSubtypeOf(mc);
        if (tph != null) {
            mc.getMetaField(tph.field()).setString(obj, tph.value());
        }

        // Get the create mapping
        ObjectMappingDB mapping = (ObjectMappingDB) getCreateMapping(mc);

        //verifyObjectManager( obj );

        prePersistence(c, mc, obj, CREATE);

        if (log.isDebugEnabled()) {
            log.debug("Adding object [" + obj + "] of class [" + mc + "]");
        }

        try {
            if (!getTypedDatabaseDriver().create(conn, mc, mapping, obj)) {
                throw new PersistenceException("Now rows created for object [" + obj + "] of class [" + mc + "]");
            }

            postPersistence(c, mc, obj, CREATE);
        } catch (SQLException e) {
            //log.error( "Unable to add object of class [" + mc + "]: " + e.getMessage() );
            throw new PersistenceException("Unable to add object of class [" + mc + "]:" + e.getMessage(), e);
        }
    }

    /**
     * Update the specified object in the datastore
     */
    public void updateObject(ObjectConnection c, Object obj) throws PersistenceException {
        Connection conn = (Connection) c.getDatastoreConnection();

        // Check for a valid transaction if enforced
        checkTransaction(conn, true);

        // Get the metaclass and make sure it is updateable
        MetaObject mc = getMetaObjectFor(obj);
        if (!isUpdateableClass(mc)) {
            throw new PersistenceException("Object of class [" + mc + "] is not writeable");
        }

        // check the object manager
        //verifyObjectManager( obj );

        // Get the update mapping
        ObjectMappingDB mapping = (ObjectMappingDB) getUpdateMapping(mc);

        // Check whether there are dirty writes
        boolean allowsDirtyWrites = allowsDirtyWrites(mc);

        MetaField dirtyField = null;
        Object dirtyFieldValue = null;

        // If we don't allow dirty writes then get the field we're filtering from
        if (!allowsDirtyWrites) {
            dirtyField = getDirtyField(mc);
            dirtyFieldValue = dirtyField.getObject(obj);
        }

        if (log.isDebugEnabled()) {
            log.debug("Updating object [" + obj + "] of class [" + mc + "]");
        }

        // Run the pre-peristence methods
        prePersistence(c, mc, obj, UPDATE);

        // Get the modified fields
        Collection<MetaField> fields = mc.getMetaFields(); //mapping.getMetaFields();
        if (mc instanceof StateAwareMetaObject) {
            fields = getModifiedPersistableFields((StateAwareMetaObject) mc, fields, obj);
        }

        // If nothing needs to be persisted, then don't bother
        if (fields.size() == 0) {
            if (log.isDebugEnabled()) {
                log.debug("No need to update object of class [" + mc + "]");
            }
            return;
        }

        try {
            // Update the object
            if (!getTypedDatabaseDriver().update(conn, mc, mapping, obj, fields, getPrimaryKeys(mc), dirtyField, dirtyFieldValue)) {

                // If no dirty writes, see if that was the issue
                if (!allowsDirtyWrites) {

                    mapping = (ObjectMappingDB) getReadMapping(mc);

                    // Create the Expression for the Primary Keys
                    Expression exp = buildPrimaryKeyExpressionFromObject(mc, obj);

                    Collection<Object> results = getTypedDatabaseDriver().readMany(conn, mc, mapping, new QueryOptions(exp));
                    if (results.size() > 0) {
                        throw new DirtyWriteException(obj);
                    }
                }

                throw new ObjectNotFoundException(obj);
            }

            postPersistence(c, mc, obj, UPDATE);
        } catch (SQLException e) {
            //log.error( "Unable to update object of class [" + mc + "]: " + e.getMessage() );
            throw new PersistenceException("Unable to update object [" + obj + "] of class [" + mc + "]: " + e.getMessage(), e);
        }
    }

    /**
     * Delete the specified object from the datastore
     */
    public void deleteObject(ObjectConnection c, Object obj) throws PersistenceException {
        Connection conn = (Connection) c.getDatastoreConnection();

        // Check for a valid transaction if enforced
        checkTransaction(conn, true);

        MetaObject mc = getMetaObjectFor(obj);

        if (!isDeleteableClass(mc)) {
            throw new PersistenceException("Object [" + obj + "] of class [" + mc + "] is not deleteable");
        }

        //verifyObjectManager( obj );

        // Get the update mapping
        ObjectMappingDB mapping = (ObjectMappingDB) getDeleteMapping(mc);

        // Check whether there are dirty writes
        boolean allowsDirtyWrites = allowsDirtyWrites(mc);

        //MetaField dirtyField = null;
        //Object dirtyFieldValue = null;

        // If we don't allow dirty writes then get the field we're filtering from
        //if ( !allowsDirtyWrites ) {
        //dirtyField = getDirtyField( mc );
        //dirtyFieldValue = dirtyField.getObject( obj );
        //}

        prePersistence(c, mc, obj, DELETE);

        if (log.isDebugEnabled()) {
            log.debug("Deleting object [" + obj + "] of class [" + mc + "]");
        }

        try {
            boolean success = getTypedDatabaseDriver().delete(conn, mc, mapping, obj, getPrimaryKeys(mc));

            if (!success) {

                // If no dirty writes, see if that was the issue
                if (!allowsDirtyWrites) {

                    // Create the Expression for the Primary Keys
                    Expression exp = buildPrimaryKeyExpressionFromObject(mc, obj);

                    Collection<Object> results = getTypedDatabaseDriver().readMany(conn, mc, mapping, new QueryOptions(exp));
                    if (results.size() > 0) {
                        throw new DirtyWriteException(obj);
                    }
                }

                throw new ObjectNotFoundException(obj);
            }

            postPersistence(c, mc, obj, DELETE);
        } catch (SQLException e) {
            //log.error( "Unable to delete object of class [" + mc + "]: " + e.getMessage() );
            throw new PersistenceException("Unable to delete object [" + obj + "] of class [" + mc + "]: " + e.getMessage(), e);
        }
    }

    /**
     * Returns whether a MetaClass allows dirty writes
     */
    @Override
    public boolean allowsDirtyWrites(MetaObject mc) {
        if (!mc.hasMetaAttr(ALLOW_DIRTY_WRITE)
                || !("false".equals(mc.getMetaAttr(ALLOW_DIRTY_WRITE).getValue()))) {
            return true;
        } else {
            return false;
        }
    }

    /**
     * Gets the name of the dirty field of a metaclass
     */
    protected MetaField getDirtyField(MetaObject mc) {
        final String KEY = "getDirtyField()";

        MetaField field = (MetaField) mc.getCacheValue(KEY);

        if (field == null) {
            if (mc.hasMetaAttr(DIRTY_WRITE_CHECK_FIELD)) {
                field = mc.getMetaField(mc.getMetaAttr(DIRTY_WRITE_CHECK_FIELD).getValue().toString());
            } else {
                for (MetaField f : getAutoFields(mc)) {
                    if (AUTO_UPDATE.equals(f.getMetaAttr(AUTO).getValue())) {
                        field = f;
                        break;
                    }
                }
            }

            if (field == null) {
                throw new MetaDataException("No MetaField that is useable to prevent dirty writes was found");
            }

            mc.setCacheValue(KEY, field);
        }

        return field;
    }

    ///**
    // * Retrieves the value of the dirty field for an object
    // */
    //protected Object getDirtyFieldValue( MetaClass mc, Object obj ) {
    //	return getDirtyField( mc ).getObject( obj );
    //}
    //private Cache<String,String> mOQLCache = new Cache<String,String>( true, 900, 3600 );
    protected PreparedStatement getPreparedStatement(Connection c, String query, Collection<?> args) throws MetaDataException, SQLException {
        String sql = query; // (String) mOQLCache.get( query );

        // If it's not in the cache, then parse it and put it there
        //if ( sql == null )
        //{
        //Map<String,MetaClass> m = getMetaClassMap( query );

        //if ( m.size() > 0 ) {
        //	sql = convertToSQL( query, m );
        //}
        //else sql = query;

        //mOQLCache.put( query, sql );
        //}

        PreparedStatement s = c.prepareStatement(sql);

        if (args != null) {
            int i = 1;
            for (Object o : args) {
                if (o instanceof Boolean) {
                    s.setBoolean(i, (Boolean) o);
                } else if (o instanceof Byte) {
                    s.setByte(i, (Byte) o);
                } else if (o instanceof Short) {
                    s.setShort(i, (Short) o);
                } else if (o instanceof Integer) {
                    s.setInt(i, (Integer) o);
                } else if (o instanceof Long) {
                    s.setLong(i, (Long) o);
                } else if (o instanceof Float) {
                    s.setFloat(i, (Float) o);
                } else if (o instanceof Double) {
                    s.setDouble(i, (Double) o);
                } else if (o instanceof Date) {
                    s.setTimestamp(i, new Timestamp(((Date) o).getTime()));
                } else if (o == null) {
                    s.setString(i, null);
                } else {
                    s.setString(i, o.toString());
                }

                // Increment the i
                i++;
            }
        }

        return s;
    }

    @Override
    public int execute(ObjectConnection c, String query, Collection<?> arguments) throws MetaDataException {
        Connection conn = (Connection) c.getDatastoreConnection();

        // Check for a valid transaction if enforced
        checkTransaction(conn, true);

        try {
            PreparedStatement s = getPreparedStatement(conn, query, arguments);

            try {
                if (log.isDebugEnabled()) {
                    log.debug("SQL (" + conn.hashCode() + ") - execute: [" + query + " " + arguments + "]");
                }

                return s.executeUpdate();
            } finally {
                s.close();
            }
        } catch (SQLException e) {
            log.error("Unable to execute object query [" + query + "]: " + e.getMessage());
            throw new MetaDataException("Unable to execute object query [" + query + "]", e);
        }
    }

    protected MetaField getFieldForColumn(MetaObject resultClass, ObjectMapping mapping, String col) throws MetaDataException {

        MetaField rc = null;

        // First check against the read mapping
        if (mapping != null) {
            rc = mapping.getField(col);
        }

        // Next try to match by the metafield name
        if (rc == null) {
            try {
                rc = resultClass.getMetaField(col);
            } catch (MetaDataNotFoundException e) {
            }
        }

        return rc;
    }

    /**
     * Executes the specified query and maps it to the given object.
     *
     * String oql = "[" + Product.CLASSNAME + "]" + " SELECT {P.*}, {M.name} AS
     * manuName" + " FROM [" + Product.CLASSNAME + "=P]," + " [" +
     * Manufacturer.CLASSNAME + "=M]" + " WHERE {M.id}={P.manuId} AND {M.id} >
     * ?";
     *
     * String oql = "[{min:int,max:int,num:int}]" + " SELECT MIN({extra2}) AS
     * min, MAX({extra2}) AS max, COUNT(1) AS num" + " FROM [" +
     * Product.CLASSNAME + "]";
     */
    @Override
    public Collection<?> executeQuery(ObjectConnection c, String query, Collection<?> arguments) throws MetaDataException {
        Connection conn = (Connection) c.getDatastoreConnection();

        // Check for a valid transaction if enforced
        checkTransaction(conn, false);


        try {
            MetaObject resultClass = null;

            query = query.trim();
            if (query.startsWith("[")) {
                int i = query.indexOf("]");
                if (i <= 0) {
                    throw new MetaDataException("OQL does not contain a closing ']': [" + query + "]");
                }

                String className = query.substring(1, i).trim();
                query = query.substring(i + 1).trim();

                resultClass = MetaDataUtil.findMetaObjectByName(className, this);
            } else {
                throw new MetaDataException("OQL does not contain a result set definition using []'s or {}'s: [" + query + "]");
            }

            PreparedStatement s = getPreparedStatement(conn, query, arguments);

            try {
                if (log.isDebugEnabled()) {
                    log.debug("SQL (" + conn.hashCode() + ") - executeQuery: [" + query + " " + arguments + "]");
                }

                ResultSet rs = s.executeQuery();

                LinkedList<Object> data = new LinkedList<Object>();
                try {
                    ObjectMappingDB mapping = (ObjectMappingDB) getReadMapping(resultClass);

                    while (rs.next()) {
                        Object o = resultClass.newInstance();

                        for (int i = 1; i <= rs.getMetaData().getColumnCount(); i++) {
                            String col = rs.getMetaData().getColumnName(i);

                            MetaField mf = getFieldForColumn(resultClass, mapping, col);

                            if (mf != null) {
                                parseField(o, mf, rs, i);
                            }
                        }

                        data.add(o);
                    }

                    return data;
                } finally {
                    rs.close();
                }
            } finally {
                s.close();
            }
        } catch (SQLException e) {
            log.error("Unable to execute object query [" + query + " (" + arguments + ")]: " + e.getMessage());
            throw new MetaDataException("Unable to execute object query [" + query + " (" + arguments + ")]: " + e.getMessage(), e);
        }
    }

    ///////////////////////////////////////////////////////
    // BULK OPERATIONS OPTIMIZATION
    //
    
    /**
     * Enhanced bulk object creation using database-specific batch operations
     */
    @Override
    public void createObjectsBulk(ObjectConnection c, MetaObject mc, Collection<Object> objects) throws MetaDataException {
        if (!isCreateableClass(mc)) {
            throw new PersistenceException("Object of class [" + mc + "] is not createable");
        }
        
        Connection conn = (Connection) c.getDatastoreConnection();
        checkTransaction(conn, true);
        
        ObjectMappingDB mapping = (ObjectMappingDB) getCreateMapping(mc);
        
        try {
            // Use database driver for bulk creation if supported
            if (getDatabaseDriver() instanceof BulkOperationSupport bulkDriver) {
                bulkDriver.createBulk(conn, mc, mapping, objects);
            } else {
                // Fallback to individual creates inside a single transaction
                createObjectsBatchFallback(c, mc, mapping, objects);
            }
        } catch (SQLException e) {
            throw new PersistenceException("Unable to bulk create objects of class [" + mc + "]: " + e.getMessage(), e);
        }
    }
    
    /**
     * Enhanced bulk object updates using database-specific batch operations
     */
    @Override
    public void updateObjectsBulk(ObjectConnection c, MetaObject mc, Collection<Object> objects) throws MetaDataException {
        if (!isUpdateableClass(mc)) {
            throw new PersistenceException("Object of class [" + mc + "] is not updateable");
        }
        
        Connection conn = (Connection) c.getDatastoreConnection();
        checkTransaction(conn, true);
        
        ObjectMappingDB mapping = (ObjectMappingDB) getUpdateMapping(mc);
        
        try {
            // Use database driver for bulk updates if supported
            if (getDatabaseDriver() instanceof BulkOperationSupport bulkDriver) {
                bulkDriver.updateBulk(conn, mc, mapping, objects);
            } else {
                // Fallback to individual updates
                for (Object obj : objects) {
                    updateObject(c, obj);
                }
            }
        } catch (SQLException e) {
            throw new PersistenceException("Unable to bulk update objects of class [" + mc + "]: " + e.getMessage(), e);
        }
    }
    
    /**
     * Batch fallback for create operations when the driver provides no native
     * bulk support. Runs the whole batch as a single all-or-nothing
     * transaction: any failure rolls back every row, so the datastore is never
     * left with a partially-applied batch. The live {@link ObjectConnection} is
     * passed to the pre/post-persistence hooks (previously {@code null}), so
     * auto-field handlers and event listeners see the same connection a single
     * {@link #createObject} would give them.
     *
     * <p>The per-1000-row mid-commit of the prior implementation was removed:
     * intermediate commits made earlier chunks unextractable on a later
     * failure, defeating atomicity.
     *
     * <p><strong>Transaction ownership.</strong> Commit / rollback / auto-commit
     * restore are performed ONLY when this method opened the transaction (the
     * connection arrived with auto-commit on). When the caller already owns the
     * transaction — e.g. inside an {@code ObjectManager.inTransaction(...)} lambda
     * which sets auto-commit off — this method commits nothing, rolls back nothing,
     * and lets exceptions propagate so the caller's transaction boundary stays
     * authoritative (no premature commit, no double rollback). This mirrors single
     * {@link #createObject}, which never manages a commit of its own.
     */
    private void createObjectsBatchFallback(ObjectConnection c, MetaObject mc, ObjectMappingDB mapping, Collection<Object> objects) throws SQLException {
        Connection conn = (Connection) c.getDatastoreConnection();

        boolean originalAutoCommit = conn.getAutoCommit();
        if (originalAutoCommit) {
            conn.setAutoCommit(false);
        }

        try {
            for (Object obj : objects) {
                prePersistence(c, mc, obj, CREATE);

                if (!getTypedDatabaseDriver().create(conn, mc, mapping, obj)) {
                    throw new PersistenceException("No rows created for object [" + obj + "] of class [" + mc + "]");
                }

                postPersistence(c, mc, obj, CREATE);
            }

            // Only commit when THIS method opened the transaction. If the caller
            // arrived already non-autocommit (e.g. inside an inTransaction lambda),
            // the boundary is theirs to manage — committing here would prematurely
            // commit the outer unit of work.
            if (originalAutoCommit) {
                conn.commit();
            }
        } catch (SQLException | RuntimeException e) {
            // All-or-nothing: undo every row inserted in this batch — but only when
            // we own the transaction. When the caller owns it, let the exception
            // propagate untouched (the caller rolls back); rolling back here would
            // double-rollback the outer transaction.
            if (originalAutoCommit) {
                try {
                    conn.rollback();
                } catch (SQLException rollbackEx) {
                    e.addSuppressed(rollbackEx);
                }
            }
            throw e;
        } finally {
            // Restore original auto-commit
            if (originalAutoCommit) {
                conn.setAutoCommit(true);
            }
        }
    }

    ///////////////////////////////////////////////////////
    // UTILITY METHODS FOR EXPRESSION BUILDING

    /**
     * Build an Expression chain for primary keys with values from an object reference
     * @param mc MetaObject to get primary keys from
     * @param ref ObjectRef containing the key values
     * @return Expression chain combining all primary key conditions
     * @throws PersistenceException if MetaObject has no primary keys
     */
    protected Expression buildPrimaryKeyExpressionFromRef(MetaObject mc, ObjectRef ref) throws PersistenceException {
        Expression exp = null;
        int i = 0;
        
        for (MetaField mf : getPrimaryKeys(mc)) {
            Expression e = new Expression(mf.getName(), ref.getIds()[i]);
            if (exp == null) {
                exp = e;
            } else {
                exp = exp.and(e);
            }
            i++;
        }
        
        if (exp == null) {
            throw new PersistenceException("MetaObject [" + mc + "] has no primary keys");
        }
        
        return exp;
    }

    /**
     * Build an Expression chain for primary keys with values from an object
     * @param mc MetaClass to get primary keys from
     * @param obj Object containing the key values
     * @return Expression chain combining all primary key conditions
     * @throws PersistenceException if MetaObject has no primary keys
     */
    protected Expression buildPrimaryKeyExpressionFromObject(MetaObject mc, Object obj) throws PersistenceException {
        Expression exp = null;
        
        for (MetaField mf : getPrimaryKeys(mc)) {
            Expression e = new Expression(mf.getName(), mf.getObject(obj));
            if (exp == null) {
                exp = e;
            } else {
                exp = exp.and(e);
            }
        }
        
        if (exp == null) {
            throw new PersistenceException("MetaObject [" + mc + "] has no primary keys");
        }
        
        return exp;
    }

    ///////////////////////////////////////////////////////
    // TO STRING METHOD
    @Override
    public String toString() {
        StringBuilder sb = new StringBuilder();
        sb.append(getClass().getSimpleName())
                .append("[")
                .append(getMappingHandler().getClass().getSimpleName())
                .append("][")
                .append(getDatabaseDriver().getClass().getSimpleName())
                .append("]");
        return sb.toString();
    }
}

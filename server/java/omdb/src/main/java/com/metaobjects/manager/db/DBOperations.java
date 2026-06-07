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

import com.metaobjects.MetaDataException;
import com.metaobjects.manager.ObjectConnection;
import com.metaobjects.object.MetaObject;

import javax.sql.DataSource;
import java.util.Collection;

/**
 * Interface defining database-specific public operations for ObjectManager implementations.
 * This interface exposes only the public API methods from ObjectManagerDB.
 */
public interface DBOperations {
    
    ///////////////////////////////////////////////////////
    // CONNECTION HANDLING METHODS
    //
    
    /**
     * Sets the Data Source to use for database connections
     */
    void setDataSource(DataSource ds);
    
    /**
     * Retrieves the data source
     */
    DataSource getDataSource();
    
    ///////////////////////////////////////////////////////
    // DATABASE DRIVER METHODS
    //
    
    /**
     * Sets the database driver by class name
     */
    void setDriverClass(String className) throws ReflectiveOperationException;
    
    /**
     * Sets the database driver instance
     */
    void setDatabaseDriver(Object dd);
    
    /**
     * Gets the current database driver
     */
    Object getDatabaseDriver();
    
    ///////////////////////////////////////////////////////
    // TRANSACTION METHODS
    //
    
    /**
     * Sets whether to enforce transactions on SQL queries
     */
    void setEnforceTransaction(boolean enforce);
    
    /**
     * Returns whether to enforce transactions
     */
    boolean enforceTransaction();
    
    ///////////////////////////////////////////////////////
    // MAPPING HANDLER METHODS
    //
    
    /**
     * Sets the mapping handler for database operations
     */
    void setMappingHandler(MappingHandler handler);
    
    /**
     * Gets the current mapping handler
     */
    MappingHandler getMappingHandler();
    
    /**
     * Gets the default mapping handler implementation
     */
    MappingHandler getDefaultMappingHandler();
    
    ///////////////////////////////////////////////////////
    // SQL EXECUTION METHODS
    //
    
    /**
     * Executes a SQL statement and returns the number of affected rows
     */
    int execute(ObjectConnection c, String query, Collection<?> arguments) throws MetaDataException;
    
    /**
     * Executes a SQL query and returns the results mapped to objects
     */
    Collection<?> executeQuery(ObjectConnection c, String query, Collection<?> arguments) throws MetaDataException;
    
    ///////////////////////////////////////////////////////
    // CONFIGURATION METHODS
    //
    
    /**
     * Returns whether a MetaObject allows dirty writes
     */
    boolean allowsDirtyWrites(MetaObject mc);
    
    ///////////////////////////////////////////////////////
    // BULK OPERATIONS METHODS
    //
    
    /**
     * Enhanced bulk object creation using database-specific batch operations
     */
    void createObjectsBulk(ObjectConnection c, MetaObject mc, Collection<Object> objects) throws MetaDataException;
    
    /**
     * Enhanced bulk object updates using database-specific batch operations
     */
    void updateObjectsBulk(ObjectConnection c, MetaObject mc, Collection<Object> objects) throws MetaDataException;
}
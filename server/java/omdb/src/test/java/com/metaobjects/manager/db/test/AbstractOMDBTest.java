/*
 * Copyright 2012 Doug Mealing LLC dba Meta Objects
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
/*
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the Eclipse Public License v1.0
 * which accompanies this distribution, and is available at
 * http://www.eclipse.org/legal/epl-v10.html
 * Contributors:
 *    Doug Mealing LLC - initial API and implementation and/or initial documentation
 */
package com.metaobjects.manager.db.test;

import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.manager.ObjectConnection;
import com.metaobjects.manager.db.ObjectManagerDB;
import com.metaobjects.manager.db.driver.DerbyDriver;
import com.metaobjects.registry.MetaDataLoaderRegistry;
import com.metaobjects.registry.ServiceRegistryFactory;
import org.junit.After;
import org.junit.AfterClass;
import org.junit.Before;
import org.junit.BeforeClass;

import javax.sql.DataSource;
import java.io.PrintWriter;
import java.sql.*;
import java.util.logging.Logger;

/**
 *
 * @author dmealing
 */
public class AbstractOMDBTest {
    
    protected static ObjectManagerDB omdb = null;
    protected static String dbFile = null;
    protected static MetaDataLoader loader = null;
    protected static MetaDataLoaderRegistry registry = null;

    protected ObjectConnection oc = null;
    
    @BeforeClass
    public static void setupDB() throws Exception {
                
        if ( dbFile == null ) {

            // Initialize OSGi-compatible loader registry
            registry = new MetaDataLoaderRegistry(ServiceRegistryFactory.getDefault());

            // Initialize the loader using the unified MetaDataLoader.fromResources factory
            MetaDataLoader xl = MetaDataLoader.fromResources(
                "test-db", java.util.List.of("meta.fruit.json"));

            // Register with the new loader registry (fromResources already invoked
            // the loader's own register() during construction)
            registry.registerLoader(xl);

            loader = xl;
            
            dbFile = "omb-testing-"+System.currentTimeMillis();
            
            Class.forName("org.apache.derby.jdbc.EmbeddedDriver");
            getConnection().close();     

            /** Create a simple DataSource for testing */
            DataSource ds = new DataSource() {

                @Override
                public Connection getConnection() throws SQLException {
                    return AbstractOMDBTest.getConnection();
                }

                @Override
                public Connection getConnection(String username, String password) throws SQLException {
                    return getConnection();
                }

                @Override
                public PrintWriter getLogWriter() throws SQLException {
                    return new PrintWriter( System.out );
                }

                @Override
                public void setLogWriter(PrintWriter out) throws SQLException {                    
                }

                @Override
                public void setLoginTimeout(int seconds) throws SQLException {
                }

                @Override
                public int getLoginTimeout() throws SQLException {
                    return 100;
                }

                @Override
                public Logger getParentLogger() throws SQLFeatureNotSupportedException {
                    throw new UnsupportedOperationException("Not supported yet.");
                }

                @Override
                public <T> T unwrap(Class<T> iface) throws SQLException {
                    throw new UnsupportedOperationException("Not supported yet.");
                }

                @Override
                public boolean isWrapperFor(Class<?> iface) throws SQLException {
                    throw new UnsupportedOperationException("Not supported yet.");
                }
            };
            
            // Initialize the object manager
            omdb = new ObjectManagerDB();
            omdb.setDatabaseDriver( new DerbyDriver() );
            omdb.setDataSource( ds );
            omdb.init();

            // Schema is external/explicit now (no runtime auto-create): create the
            // BASKET table + the FULL_BASKET_VIEW projection from meta.fruit.json
            // via literal Derby DDL. The PK uses Derby's GENERATED ALWAYS AS IDENTITY
            // to mirror the @generation:"increment" identity the metadata declares.
            createSchema(
                "CREATE TABLE BASKET (\n"
                    + "  id BIGINT GENERATED ALWAYS AS IDENTITY CONSTRAINT BASKET_id_PK PRIMARY KEY,\n"
                    + "  apples INTEGER NOT NULL,\n"
                    + "  oranges INTEGER NOT NULL\n"
                    + ")",
                "CREATE VIEW FULL_BASKET_VIEW AS "
                    + "SELECT B.* FROM BASKET B WHERE b.apples+b.oranges > 10");
        }
    }

    /**
     * Executes one or more literal DDL statements against the test database to
     * stand up the schema a test needs. Schema is external/explicit (ADR-0015):
     * OMDB is pure data-access and no longer auto-creates tables from metadata,
     * so each test bootstraps its own schema with verbatim {@code CREATE} SQL.
     */
    protected static void createSchema( String... ddl ) throws SQLException {
        for ( String stmt : ddl ) {
            executeSql( stmt );
        }
    }
    
    /** Returns a new database Connection for the Derby test database */
    protected static Connection getConnection() throws SQLException {
        if (dbFile == null) {
            throw new SQLException("Database not initialized - dbFile is null");
        }
        return DriverManager.getConnection("jdbc:derby:memory:"+dbFile+";create=true");
    }
    
    /** Creates a view with the specified name */
    protected static boolean createView( String viewName, String sql ) throws SQLException {        
        try {
            return executeSql( "CREATE VIEW " + viewName + " AS " + sql );
        } catch( SQLException e ) {
            if ( e.getMessage().contains( "already exists" )) return true;
            throw e;
        }
    }
    
    /** Executes the specified SQL */
    protected static boolean executeSql( String sql ) throws SQLException {
        Connection c = getConnection();
        try { 
            Statement s = c.createStatement();
            try {
                return s.execute( sql );
            } finally {
                s.close();
            }
        } finally {
            c.close();
        }
    }
    
    @AfterClass
    public static synchronized void destroyEntityManager() throws Exception {

        if (dbFile != null) {
            try {
                DriverManager.getConnection("jdbc:derby:memory:"+dbFile+";drop=true");
            } catch( SQLNonTransientConnectionException ex ) {}
            System.out.println( "DB Destroyed!" );
        }

        if (loader != null) {
            loader.destroy();
        }
    }

    @Before
    public void startTx() throws SQLException {     
        oc = omdb.getConnection();
    }

    @After
    public void endTx() {
        omdb.releaseConnection(oc);
    }
}

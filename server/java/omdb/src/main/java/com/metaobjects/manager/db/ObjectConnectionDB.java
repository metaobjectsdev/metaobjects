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


import com.metaobjects.manager.ObjectConnection;
import com.metaobjects.MetaDataException;

import java.sql.Connection;
import java.sql.SQLException;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public class ObjectConnectionDB implements ObjectConnection
{
    private static final Logger log = LoggerFactory.getLogger(ObjectConnectionDB.class);

    private Connection mConn;

    public ObjectConnectionDB( Connection c ) {
        if ( c == null ) throw new IllegalArgumentException("Connection cannot be null");
        mConn = c;
    }

    public Object getDatastoreConnection() {
        return mConn;
    }

    public void setReadOnly(boolean state)
            throws MetaDataException {
        try {
            mConn.setReadOnly(state);
        }
        catch (Exception e) {
            throw new MetaDataException("Could not set JDBC Connection to read-only", e);
        }
    }

    public boolean isReadOnly()
            throws MetaDataException {
        try {
            return mConn.isReadOnly();
        }
        catch (Exception e) {
            throw new MetaDataException("Could not determine if JDBC was read-only", e);
        }
    }

    public void setAutoCommit(boolean state)
            throws MetaDataException {
        try {
            mConn.setAutoCommit(state);
        }
        catch (Exception e) {
            throw new MetaDataException("Could not set JDBC connection to auto commit", e);
        }
    }

    public boolean getAutoCommit()
            throws MetaDataException {
        try {
            return mConn.getAutoCommit();
        }
        catch (Exception e) {
            throw new MetaDataException("Could not get JDBC auto commit status", e);
        }
    }

    public void commit()
            throws MetaDataException {
        try {
            mConn.commit();
        }
        catch (Exception e) {
            throw new MetaDataException("Could not commit on JDBC connection", e);
        }
    }

    public void rollback()
            throws MetaDataException {
        try {
            mConn.rollback();
        }
        catch (Exception e) {
            throw new MetaDataException("Could not rollback on JDBC Connection", e);
        }
    }

    public void close() {
    	
    	try {
			mConn.close();
		} catch (SQLException e) {
			log.warn( "(close) Problem commiting when closing connection", e );
		}
    }

    public boolean isClosed()
            throws MetaDataException {
        try {
            return mConn.isClosed();
        }
        catch (Exception e) {
            throw new MetaDataException("Could not determine if JDBC connection is closed", e);
        }
    }
}

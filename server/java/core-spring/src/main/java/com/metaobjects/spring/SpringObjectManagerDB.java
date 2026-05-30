package com.metaobjects.spring;

import com.metaobjects.MetaDataException;
import com.metaobjects.manager.ObjectConnection;
import com.metaobjects.manager.db.ObjectManagerDB;
import org.springframework.jdbc.datasource.DataSourceUtils;

import java.sql.Connection;

/**
 * An {@link ObjectManagerDB} whose connections join the active Spring-managed
 * transaction. {@link #getConnection()} returns the connection Spring has bound to the
 * current {@code @Transactional} scope (via {@link SpringObjectConnections}); when no
 * transaction is active a fresh pooled connection is used. {@link #releaseConnection}
 * hands the physical connection back to Spring, which releases it only when it is not
 * transaction-bound.
 */
public class SpringObjectManagerDB extends ObjectManagerDB {

    @Override
    public ObjectConnection getConnection() throws MetaDataException {
        return SpringObjectConnections.current(getDataSource());
    }

    @Override
    public void releaseConnection(ObjectConnection oc) throws MetaDataException {
        if (oc == null) {
            return;
        }
        DataSourceUtils.releaseConnection((Connection) oc.getDatastoreConnection(), getDataSource());
    }
}

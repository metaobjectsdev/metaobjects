package com.metaobjects.spring;

import com.metaobjects.manager.ObjectConnection;
import com.metaobjects.manager.db.ObjectConnectionDB;
import org.springframework.jdbc.datasource.DataSourceUtils;

import javax.sql.DataSource;
import java.sql.Connection;

/**
 * Bridges OMDB to Spring-managed transactions.
 *
 * <p>{@link #current(DataSource)} returns an {@link ObjectConnection} backed by the SAME
 * physical {@link Connection} that Spring has bound to the current {@code @Transactional}
 * scope (via {@link DataSourceUtils#getConnection}).  The wrapper's {@link ObjectConnection#close()}
 * is a no-op: Spring's transaction manager owns the connection lifecycle and will close it
 * when the transaction completes.</p>
 *
 * <p>If no transaction is active, {@link DataSourceUtils#getConnection} obtains a fresh
 * connection from the pool; callers are responsible for releasing it via
 * {@link DataSourceUtils#releaseConnection} in that case.</p>
 */
public final class SpringObjectConnections {

    private SpringObjectConnections() {}

    /**
     * Returns an {@link ObjectConnection} over the current Spring-bound connection for
     * {@code dataSource}.  When a transaction is active the returned connection is the
     * tx-bound connection; otherwise a fresh connection is obtained from the pool.
     *
     * @param dataSource the {@link DataSource} whose Spring-bound connection to use
     * @return an {@link ObjectConnection} whose {@code close()} is a no-op
     */
    public static ObjectConnection current(DataSource dataSource) {
        Connection c = DataSourceUtils.getConnection(dataSource);
        return new NonClosingObjectConnectionDB(c);
    }

    /**
     * An {@link ObjectConnectionDB} whose {@code close()} is a no-op.
     * Spring's transaction manager closes the underlying connection at transaction end.
     */
    static final class NonClosingObjectConnectionDB extends ObjectConnectionDB {

        NonClosingObjectConnectionDB(Connection c) {
            super(c);
        }

        /**
         * No-op — Spring owns the connection lifecycle.
         * The underlying connection will be closed by the transaction manager.
         */
        @Override
        public void close() {
            // intentional no-op: Spring closes the connection at transaction end
        }
    }
}

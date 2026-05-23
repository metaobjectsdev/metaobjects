package com.metaobjects.omdb.ktx

import com.metaobjects.manager.db.ObjectManagerDB
import com.metaobjects.spring.SpringObjectConnections
import javax.sql.DataSource

/**
 * Runs [block] inside a transaction on a fresh connection.
 * Commits on normal return; rolls back and rethrows on any exception. Always releases the connection.
 */
fun <T> ObjectManagerDB.transaction(block: (OmdbSession) -> T): T {
    val conn = getConnection()
    try {
        conn.autoCommit = false
        val result = block(OmdbSession(this, conn))
        conn.commit()
        return result
    } catch (t: Throwable) {
        runCatching { conn.rollback() }
        throw t
    } finally {
        releaseConnection(conn)
    }
}

/**
 * Runs [block] against the Spring-managed (DataSourceUtils-bound) connection.
 * Does NOT commit or close — the surrounding @Transactional owns the lifecycle.
 * Without an active Spring transaction a fresh connection is obtained from the pool;
 * in that case callers are responsible for transaction management.
 */
fun <T> ObjectManagerDB.withSpringConnection(dataSource: DataSource, block: (OmdbSession) -> T): T {
    val conn = SpringObjectConnections.current(dataSource) // close() is a no-op
    return block(OmdbSession(this, conn))
}

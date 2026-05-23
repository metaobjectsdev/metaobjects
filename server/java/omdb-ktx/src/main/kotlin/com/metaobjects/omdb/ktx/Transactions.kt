package com.metaobjects.omdb.ktx

import com.metaobjects.manager.db.ObjectManagerDB

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

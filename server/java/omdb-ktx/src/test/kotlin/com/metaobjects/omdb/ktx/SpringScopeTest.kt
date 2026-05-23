package com.metaobjects.omdb.ktx

import java.sql.Connection
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse

class SpringScopeTest {

    companion object {
        private val db: TestDb by lazy {
            TestDb.build(dbName = "omdb-ktx-spring-${System.currentTimeMillis()}")
        }
    }

    @Test
    fun `withSpringConnection runs block and returns its value`() {
        val result = db.omdb.withSpringConnection(db.dataSource) { session ->
            // The block received a valid, non-closed connection.
            assertFalse(session.connection.isClosed, "session connection should not be closed inside the block")
            42
        }
        assertEquals(42, result)
    }

    @Test
    fun `withSpringConnection uses the same in-memory database`() {
        // Verify the session's connection is usable against the DB that TestDb set up
        // (i.e. the Widget table exists and can be queried via the native JDBC connection).
        db.omdb.withSpringConnection(db.dataSource) { session ->
            val jdbcConn = session.connection.datastoreConnection as Connection
            jdbcConn.createStatement().use { stmt ->
                val rs = stmt.executeQuery("SELECT COUNT(*) FROM WIDGET")
                rs.next()
                val count = rs.getInt(1)
                // Just assert the query succeeds (table exists); count may be 0.
                assertFalse(count < 0, "row count should be non-negative")
            }
        }
    }
}

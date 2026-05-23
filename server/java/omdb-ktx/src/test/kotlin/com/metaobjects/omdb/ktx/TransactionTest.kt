package com.metaobjects.omdb.ktx

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse

class TransactionTest {

    companion object {
        private val db: TestDb by lazy {
            TestDb.build(dbName = "omdb-ktx-txn-${System.currentTimeMillis()}")
        }
    }

    @Test
    fun `transaction commits on success and exposes a session`() {
        val result = db.omdb.transaction { session ->
            assertFalse(session.connection.autoCommit)
            42
        }
        assertEquals(42, result)
    }

    @Test
    fun `transaction rolls back and rethrows on exception`() {
        assertFailsWith<IllegalStateException> {
            db.omdb.transaction { error("boom") }
        }

        // Connection was released — a subsequent transaction must succeed (not throw).
        val ok = db.omdb.transaction { session ->
            assertFalse(session.connection.isClosed)
            true
        }
        assertEquals(true, ok)
    }
}

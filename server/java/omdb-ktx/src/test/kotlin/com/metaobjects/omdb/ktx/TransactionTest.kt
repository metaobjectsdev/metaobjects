package com.metaobjects.omdb.ktx

import com.metaobjects.`object`.value.ValueObject
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.BeforeAll
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse

class TransactionTest {

    companion object {
        private lateinit var db: TestDb

        @JvmStatic
        @BeforeAll
        fun setup() {
            db = TestDb.build(dbName = "omdb-ktx-txn-${System.currentTimeMillis()}")
        }

        @JvmStatic
        @AfterAll
        fun teardown() {
            db.destroy()
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

    @Test
    fun `transaction rolls back writes when block throws`() {
        val mo = db.registry.findMetaObjectByName("ktx::Widget")

        // Count widgets before the failing transaction.
        val countBefore = db.omdb.transaction { session ->
            session.find(mo).size
        }

        // A transaction that writes then throws: the write must NOT be committed.
        assertFailsWith<IllegalStateException> {
            db.omdb.transaction { session ->
                val widget = mo.newInstance() as ValueObject
                widget.setString("name", "RollbackWidget")
                widget.setInt("quantity", 1)
                session.create(widget)
                error("boom after write")
            }
        }

        // Count after: must equal count before (the insert was rolled back).
        val countAfter = db.omdb.transaction { session ->
            session.find(mo).size
        }

        assertEquals(countBefore, countAfter, "rolled-back insert must not persist")
    }
}

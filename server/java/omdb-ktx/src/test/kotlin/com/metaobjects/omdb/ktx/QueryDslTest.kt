package com.metaobjects.omdb.ktx

import com.metaobjects.manager.exp.Expression
import com.metaobjects.`object`.value.ValueObject
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull

class QueryDslTest {

    companion object {
        private lateinit var db: TestDb

        @JvmStatic
        @BeforeAll
        fun setup() {
            db = TestDb.build(dbName = "omdb-ktx-query-${System.currentTimeMillis()}")
        }

        @JvmStatic
        @AfterAll
        fun teardown() {
            db.destroy()
        }
    }

    // ── Unit tests ─────────────────────────────────────────────────────────

    @Test
    fun `field eq produces Expression with EQUAL condition`() {
        val exp = field("status") eq "active"
        assertEquals("status", exp.field)
        assertEquals(Expression.EQUAL, exp.condition)
        assertEquals("active", exp.value)
    }

    @Test
    fun `field ne produces Expression with NOT_EQUAL condition`() {
        val exp = field("status") ne "inactive"
        assertEquals("status", exp.field)
        assertEquals(Expression.NOT_EQUAL, exp.condition)
        assertEquals("inactive", exp.value)
    }

    @Test
    fun `field gt produces Expression with GREATER condition`() {
        val exp = field("quantity") gt 5
        assertEquals("quantity", exp.field)
        assertEquals(Expression.GREATER, exp.condition)
        assertEquals(5, exp.value)
    }

    @Test
    fun `field lt produces Expression with LESSER condition`() {
        val exp = field("quantity") lt 100
        assertEquals("quantity", exp.field)
        assertEquals(Expression.LESSER, exp.condition)
        assertEquals(100, exp.value)
    }

    @Test
    fun `field gte produces Expression with EQUAL_GREATER condition`() {
        val exp = field("quantity") gte 10
        assertEquals("quantity", exp.field)
        assertEquals(Expression.EQUAL_GREATER, exp.condition)
        assertEquals(10, exp.value)
    }

    @Test
    fun `field lte produces Expression with EQUAL_LESSER condition`() {
        val exp = field("quantity") lte 50
        assertEquals("quantity", exp.field)
        assertEquals(Expression.EQUAL_LESSER, exp.condition)
        assertEquals(50, exp.value)
    }

    // ── Integration test — read-your-writes via session connection ──────────

    @Test
    fun `find with filter and sort returns only matching rows from the session connection`() {
        // Note on connection semantics: Derby in-memory with TRANSACTION_READ_COMMITTED does NOT
        // show uncommitted rows to a second connection. Therefore read-your-writes (seeing just-
        // created, not-yet-committed rows) requires find() to execute on the SAME connection used
        // by create(). The session-level find() is designed exactly for this: it calls
        // manager.getObjects(connection, metaObject, options) on the session's own connection
        // rather than opening a new one via QueryBuilder.execute(). This test validates that
        // contract by creating widgets and querying within the same transaction — if find() used a
        // separate connection it would return 0 rows and the assertions below would fail.
        val widgetMeta = db.registry.findMetaObjectByName("ktx::Widget")
        assertNotNull(widgetMeta, "MetaObject for ktx::Widget must be registered")

        val foundNames = db.omdb.transaction { session ->
            // Create three Widgets with distinct quantities.
            listOf(
                "Alpha" to 5,    // below threshold — should be excluded
                "Beta"  to 10,   // at threshold — should be included
                "Gamma" to 20,   // above threshold — should be included
            ).forEach { (name, qty) ->
                val w = widgetMeta.newInstance() as ValueObject
                w.setString("name", name)
                w.setInt("quantity", qty)
                session.create(w)
            }

            // Query within the same transaction, on the same session connection.
            // gte 10 should return Beta and Gamma, ordered ascending by name → [Beta, Gamma].
            val results = session.find(widgetMeta) {
                where(field("quantity") gte 10)
                orderByAsc("name")
            }

            results.map { obj -> (obj as ValueObject).getString("name") }
        }

        assertEquals(2, foundNames.size, "Expected exactly 2 widgets with quantity >= 10")
        assertEquals("Beta",  foundNames[0], "First result should be Beta (alphabetically first)")
        assertEquals("Gamma", foundNames[1], "Second result should be Gamma")
    }
}

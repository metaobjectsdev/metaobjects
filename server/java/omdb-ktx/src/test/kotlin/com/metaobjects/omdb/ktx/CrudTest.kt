package com.metaobjects.omdb.ktx

import com.metaobjects.manager.exp.Expression
import com.metaobjects.manager.QueryOptions
import com.metaobjects.`object`.value.ValueObject
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull

class CrudTest {

    companion object {
        private lateinit var db: TestDb

        @JvmStatic
        @BeforeAll
        fun setup() {
            db = TestDb.build(dbName = "omdb-ktx-crud-${System.currentTimeMillis()}")
        }

        @JvmStatic
        @AfterAll
        fun teardown() {
            db.destroy()
        }
    }

    @Test
    fun `findByRef returns null for a missing ref`() {
        // Build a ref string for a Widget that was never persisted (id = 99999).
        // ObjectRef format: objectref://<fqn>/<id>
        val missingRef = "objectref://ktx::Widget/99999"

        val result = db.omdb.transaction { session ->
            session.findByRef<ValueObject>(missingRef)
        }

        assertNull(result, "findByRef should return null for a non-existent object")
    }

    @Test
    fun `round-trip create findByRef update delete`() {
        val mo = db.registry.findMetaObjectByName("ktx::Widget")
        assertNotNull(mo, "MetaObject for ktx::Widget must be registered")

        db.omdb.transaction { session ->

            // --- CREATE ---
            val widget = mo.newInstance() as ValueObject
            widget.setString("name", "Gizmo")
            widget.setInt("quantity", 10)
            session.create(widget)

            // Build the ref string using the engine's own getObjectRef helper.
            // After createObject the auto-increment id is populated on the instance.
            val refStr = db.omdb.getObjectRef(widget).toString()

            // --- FIND (read-back after create) ---
            val loaded = session.findByRef<ValueObject>(refStr)
            assertNotNull(loaded, "findByRef must return the created Widget")
            assertEquals("Gizmo", loaded.getString("name"))
            assertEquals(10, loaded.getInt("quantity"))

            // --- UPDATE ---
            loaded.setString("name", "Gizmo-Pro")
            loaded.setInt("quantity", 42)
            session.update(loaded)

            // Verify the update by querying with an Expression on the name field,
            // mirroring the FruitDBTest.testBasket / testApple pattern.
            val exp = Expression("name", "Gizmo-Pro", Expression.EQUAL)
            val results = db.omdb.getObjects(session.connection, mo, QueryOptions(exp))
            assertNotNull(results, "query after update must not return null")
            val updated = results.iterator().next() as ValueObject
            assertEquals("Gizmo-Pro", updated.getString("name"))
            assertEquals(42, updated.getInt("quantity"))

            // --- DELETE ---
            session.delete(updated)

            // Confirm the Widget is gone: findByRef should return null.
            val afterDelete = session.findByRef<ValueObject>(refStr)
            assertNull(afterDelete, "findByRef must return null after delete")
        }
    }
}

package com.metaobjects.omdb.ktx

import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Test
import kotlin.test.assertNotNull

class CoroutinesTest {

    companion object {
        private lateinit var db: TestDb

        @JvmStatic
        @BeforeAll
        fun setup() {
            db = TestDb.build(dbName = "omdb-ktx-coroutines-${System.currentTimeMillis()}")
        }

        @JvmStatic
        @AfterAll
        fun teardown() {
            db.destroy()
        }
    }

    @Test
    fun `awaitGetObjects returns a collection (possibly empty) via suspend wrapper`() {
        val widgetMeta = db.registry.findMetaObjectByName("ktx::Widget")
        assertNotNull(widgetMeta, "MetaObject for ktx::Widget must be registered")

        val result = runBlocking { db.omdb.awaitGetObjects(widgetMeta) }

        assertNotNull(result, "awaitGetObjects must return a non-null collection")
    }

    @Test
    fun `awaitExecute returns a collection via suspend wrapper over QueryBuilder`() {
        val widgetMeta = db.registry.findMetaObjectByName("ktx::Widget")
        assertNotNull(widgetMeta, "MetaObject for ktx::Widget must be registered")

        val result = runBlocking { db.omdb.query(widgetMeta).awaitExecute() }

        assertNotNull(result, "awaitExecute must return a non-null collection")
    }
}

package com.metaobjects.omdb.ktx

import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Test
import kotlin.test.assertFalse
import kotlin.test.assertNotNull

class TestDbTest {

    companion object {
        private lateinit var db: TestDb

        @JvmStatic
        @BeforeAll
        fun setup() {
            db = TestDb.build()
        }

        @JvmStatic
        @AfterAll
        fun teardown() {
            db.destroy()
        }
    }

    @Test
    fun `fixture yields an open connection`() {
        db.connection().use { conn ->
            assertFalse(conn.isClosed, "connection should be open")
        }
    }

    @Test
    fun `omdb is initialised`() {
        assertNotNull(db.omdb)
    }

    @Test
    fun `registry has loader for Widget`() {
        val mo = db.registry.findMetaObjectByName("ktx::Widget")
        assertNotNull(mo, "Widget MetaObject should be registered")
    }
}

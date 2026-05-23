package com.metaobjects.omdb.ktx

import com.metaobjects.manager.db.ObjectManagerDB
import kotlin.test.Test
import kotlin.test.assertNotNull

class SmokeTest {
    @Test
    fun `can instantiate ObjectManagerDB from Kotlin`() {
        val om = ObjectManagerDB()
        assertNotNull(om)
    }
}

package com.metaobjects.metadata.ktx

import com.metaobjects.loader.MetaDataSource
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull

class LoaderTest {

    private val tinyJson = """{ "metadata.root": { "package": "acme", "children": [] } }"""

    @Test fun `loadString returns a populated MetaDataLoader`() {
        val loader = loadString("test", tinyJson)
        assertNotNull(loader.root)
        assertEquals("test", loader.name)
    }

    @Test fun `loadString accepts YAML format`() {
        val yaml = "metadata.root:\n  package: acme\n  children: []\n"
        val loader = loadString("y", yaml, MetaDataSource.MetaDataFormat.YAML)
        assertNotNull(loader.root)
    }
}

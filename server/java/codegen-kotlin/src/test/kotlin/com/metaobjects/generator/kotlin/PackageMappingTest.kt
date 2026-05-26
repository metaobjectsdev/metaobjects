package com.metaobjects.generator.kotlin

import kotlin.test.Test
import kotlin.test.assertEquals

class PackageMappingTest {

    @Test fun `single segment`() {
        assertEquals("acme", PackageMapping.toKotlin("acme"))
    }

    @Test fun `two segments`() {
        assertEquals("acme.demo", PackageMapping.toKotlin("acme::demo"))
    }

    @Test fun `three segments`() {
        assertEquals("acme.demo.commerce", PackageMapping.toKotlin("acme::demo::commerce"))
    }

    @Test fun `empty stays empty`() {
        assertEquals("", PackageMapping.toKotlin(""))
    }

    @Test fun `splitFqn returns package + shortName`() {
        assertEquals("acme.demo" to "Author",
            PackageMapping.splitFqn("acme::demo::Author"))
    }

    @Test fun `splitFqn with no package`() {
        assertEquals("" to "Author",
            PackageMapping.splitFqn("Author"))
    }
}

package com.metaobjects.generator.kotlin

import com.metaobjects.`object`.MetaObject
import com.metaobjects.metadata.ktx.loadString
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Unit test for [KotlinGenUtil.isAbstractEntity] — the shared own-only abstract check
 * promoted out of [KotlinEntityGenerator] so all five instance/write generators reuse
 * one definition (own attribute, not inherited).
 */
class KotlinGenUtilAbstractTest {

    private val fixture = """{
      "metadata.root": { "package": "acme::demo", "children": [
        { "object.entity": { "name": "AbstractBase", "abstract": true, "children": [
            { "field.long": { "name": "id" } }
        ] } },
        { "object.entity": { "name": "Concrete", "extends": "acme::demo::AbstractBase", "children": [
            { "field.string": { "name": "label" } }
        ] } }
      ] }
    }""".trimIndent()

    @Test fun `isAbstractEntity is true for abstract and false for concrete`() {
        val loader = loadString("abstractUtilFixture", fixture)

        val base = loader.metaObjects.first { it.name.substringAfterLast("::") == "AbstractBase" } as MetaObject
        val concrete = loader.metaObjects.first { it.name.substringAfterLast("::") == "Concrete" } as MetaObject

        assertTrue(KotlinGenUtil.isAbstractEntity(base),
            "AbstractBase has own @isAbstract=true → isAbstractEntity should be true")
        assertFalse(KotlinGenUtil.isAbstractEntity(concrete),
            "Concrete extends an abstract base but has no own @isAbstract → should be false")
    }
}

package com.metaobjects.generator.kotlin

import com.metaobjects.loader.InMemoryStringSource
import com.metaobjects.loader.LoaderOptions
import com.metaobjects.loader.MetaDataLoader
import com.metaobjects.registry.ObjectClassRegistry
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * `@collectionName`, shared vocabulary every port implements (the Kotlin REST segment reads it),
 * loads under the strict loader the Kotlin generators read; a wrong value type, the
 * never-released `@dbSetName` and an attribute the registry does not carry still fail.
 */
class PortScopedAttrKtTest {
    private fun model(attr: String) = """
        { "metadata.root": { "package": "acme", "children": [
          { "object.entity": { "name": "Diagnosis", $attr "children": [
            { "source.rdb": { "@table": "diagnoses" } },
            { "field.long": { "name": "id" } },
            { "identity.primary": { "@fields": "id" } }
          ] } }
        ] } }
    """.trimIndent()

    private fun errors(attr: String): List<String> = try {
        val loader = MetaDataLoader(LoaderOptions.create(false, false, true), MetaDataLoader.SUBTYPE_MANUAL, "port-scoped-kt")
        loader.init()
        loader.load(listOf(InMemoryStringSource(model(attr), "port-scoped-kt/meta.json")))
        (loader.getErrors() ?: emptyList()).map { it.message ?: "" }
    } catch (e: RuntimeException) {
        listOf(e.message ?: "refused")
    } finally {
        ObjectClassRegistry.resetGlobal()
    }

    @Test fun `a collection name loads`() = assertEquals(emptyList(), errors("\"@collectionName\": \"Diagnoses\","))

    @Test fun `it is type-checked`() = assertTrue(errors("\"@collectionName\": [\"Diagnoses\"],").isNotEmpty())

    @Test fun `the never-released dbSetName is not vocabulary`() = assertTrue(errors("\"@dbSetName\": \"Diagnoses\",").isNotEmpty())

    @Test fun `an unregistered attribute still fails`() = assertTrue(errors("\"@collectionNameX\": \"Diagnoses\",").isNotEmpty())
}

package com.metaobjects.generator.kotlin

import com.metaobjects.loader.InMemoryStringSource
import com.metaobjects.loader.LoaderOptions
import com.metaobjects.loader.MetaDataLoader
import com.metaobjects.registry.ObjectClassRegistry
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Ruling R40, the Kotlin half: `@dbSetName` (C#-only, `ports: ["csharp"]`) loads under the strict
 * loader the Kotlin generators read, and Kotlin does nothing with it; a wrong value type and an attribute the
 * registry does not carry still fail.
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

    @Test fun `a csharp-only attribute loads`() = assertEquals(emptyList(), errors("\"@dbSetName\": \"Diagnosis\","))

    @Test fun `it is type-checked`() = assertTrue(errors("\"@dbSetName\": [\"Diagnosis\"],").isNotEmpty())

    @Test fun `an unregistered attribute still fails`() = assertTrue(errors("\"@dbSetNameX\": \"Diagnosis\",").isNotEmpty())
}

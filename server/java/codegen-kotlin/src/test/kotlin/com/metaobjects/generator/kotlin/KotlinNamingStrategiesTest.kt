package com.metaobjects.generator.kotlin

import com.metaobjects.MetaDataException
import com.metaobjects.config.NeutralConfig
import com.metaobjects.database.NamingStrategies
import com.metaobjects.metadata.ktx.loadString
import kotlin.io.path.readText
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/**
 * ADR-0058 Amendment 1, from Kotlin: the corpus's application-registered strategies resolve
 * through [KotlinGenUtil] — the door the Exposed and names generators call — and a name
 * nothing registers is refused when the config is read.
 */
class KotlinNamingStrategiesTest {

    @Test fun `an application strategy names every corpus column through KotlinGenUtil`() {
        NamingCorpus.registerStrategies()
        val c = NamingCorpus.cases.get("cases").single { it.get("name").asText() == "app-registered column and table strategies" }
        val naming = NeutralConfig.parse("""{ "schema_version": 1, "naming": ${c.get("naming")} }""", "kotlin-test").physicalNaming
        val loader = loadString("kotlin-naming-strategies", NamingCorpus.dir.resolve("meta.naming.json").readText())
        loader.root.physicalNaming = naming
        for ((key, expected) in c.get("columns").fields()) {
            val parts = key.split(".")
            if (parts.size != 2) continue
            val obj = loader.metaObjects.single { it.shortName == parts[0] }
            assertEquals(expected.asText(), KotlinGenUtil.resolveColumnName(obj.getMetaField(parts[1])), key)
        }
    }

    @Test fun `a Kotlin lambda wrapping a built-in is one line`() {
        NamingStrategies.registerColumns("kotlin-test-acronyms") { n -> if (n == "npi") "NPI" else NamingStrategies.column("pascal").apply(n) }
        assertEquals("NPI", KotlinGenUtil.applyColumnNamingStrategy("npi", "kotlin-test-acronyms"))
        assertEquals("CreatedAt", KotlinGenUtil.applyColumnNamingStrategy("createdAt", KotlinGenUtil.COLUMN_NAMING_PASCAL))
    }

    @Test fun `an unregistered name is refused when the config is read`() {
        val ex = assertFailsWith<MetaDataException> {
            NeutralConfig.parse("""{ "schema_version": 1, "naming": { "columns": "kotlin-nope" } }""", "kotlin-test")
        }
        assertTrue("\"naming.columns\" names \"kotlin-nope\"" in ex.message!!, ex.message)
    }
}

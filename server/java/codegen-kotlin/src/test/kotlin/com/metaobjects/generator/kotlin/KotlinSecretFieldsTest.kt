package com.metaobjects.generator.kotlin

import com.metaobjects.metadata.ktx.loadString
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * #484 — the generated HTTP boundary never returns a credential (`view.password`) and ignores a
 * `@formExclude` or credential field on writes. The wire and storage behaviour of both marks is gated
 * behaviourally by the api-contract `secret-fields/` corpus in the integration-tests-kotlin generated lane
 * (responses, and the stored rows after every write). These tests pin the generator's design: the entity
 * keeps its declared types and the controller redacts at the boundary.
 */
class KotlinSecretFieldsTest {

    private fun model(marked: Boolean, requiredCredential: Boolean = false) = """{
      "metadata.root": { "package": "acme::secrets", "children": [
        { "object.entity": { "name": "Account", "children": [
            { "source.rdb":   { "@table": "accounts" } },
            { "field.long":   { "name": "id" } },
            { "field.string": { "name": "name", "@required": true, "@maxLength": 100 } },
            { "field.string": { "name": "tokenHash", "@maxLength": 100${if (marked) """, "@formExclude": true""" else ""} } },
            { "field.string": { "name": "pinHash", "@maxLength": 100${if (requiredCredential) """, "@required": true""" else ""}${if (marked) """, "children": [ { "view.password": {} } ]""" else ""} } },
            { "identity.primary": { "@fields": "id", "@generation": "increment" } }
        ] } }
      ] }
    }""".trimIndent()

    private fun controllerAndEntity(marked: Boolean, requiredCredential: Boolean = false): Pair<String, String> {
        val out = Files.createTempDirectory("ksecret-")
        try {
            val loader = loadString("secret-fields-$marked-$requiredCredential", model(marked, requiredCredential))
            KotlinEntityGenerator().apply { setArgs(mapOf("outputDir" to out.toString())) }.execute(loader)
            KotlinSpringControllerGenerator().apply { setArgs(mapOf("outputDir" to out.toString())) }.execute(loader)
            val dir = out.resolve("acme/secrets")
            return Files.readString(dir.resolve("AccountController.kt")) to Files.readString(dir.resolve("Account.kt"))
        } finally {
            out.toFile().deleteRecursively()
        }
    }

    @Test
    fun `only the credential is redacted on read and the entity keeps its types`() {
        val (controller, entity) = controllerAndEntity(marked = true)
        assertTrue("remove(listOf(\"pinHash\"))" in controller, controller)
        assertFalse("tokenHash\"" in controller.substringAfter("private fun redactAccount").substringBefore("\n\n"), controller)
        assertTrue("redactAccount(objectMapper, rowToAccount(it))" in controller, controller)
        assertTrue("tokenHash = row[AccountTable.tokenHash]," in controller, controller)
        assertTrue("pinHash = row[AccountTable.pinHash]," in controller, controller)
        assertFalse("JsonInclude" in entity, entity)
    }

    @Test
    fun `a required credential stays a non-null property with no JsonInclude`() {
        val (controller, entity) = controllerAndEntity(marked = true, requiredCredential = true)
        assertTrue(Regex("val pinHash: String[,\\s)]").containsMatchIn(entity), entity)
        assertFalse("val pinHash: String?" in entity, entity)
        assertFalse("JsonInclude" in entity, entity)
        assertTrue("remove(listOf(\"pinHash\"))" in controller, controller)
    }

    @Test
    fun `a model with neither mark generates the plain write and read paths`() {
        val (controller, entity) = controllerAndEntity(marked = false)
        for (f in listOf("tokenHash", "pinHash")) {
            assertTrue("it[$f] = dto.$f" in controller, controller)
            assertTrue("$f = row[AccountTable.$f]," in controller, controller)
        }
        assertTrue("listOf(\"name\", \"tokenHash\", \"pinHash\").any { body.has(it) }" in controller, controller)
        assertFalse("redactAccount" in controller, controller)
        assertFalse("JsonInclude" in entity, entity)
    }
}

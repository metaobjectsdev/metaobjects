package com.metaobjects.generator.kotlin

import com.metaobjects.metadata.ktx.loadString
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * #484 — the generated HTTP boundary ignores a `@formExclude` or credential (`view.password`) field on
 * create / PATCH / PUT and never returns a credential. A credential's write path is not observable over
 * HTTP (it is never read back), so the generated source is pinned here; the wire behaviour of both marks is
 * gated by the api-contract `secret-fields/` corpus in the integration-tests-kotlin generated lane.
 */
class KotlinSecretFieldsTest {

    private fun model(marked: Boolean) = """{
      "metadata.root": { "package": "acme::secrets", "children": [
        { "object.entity": { "name": "Account", "children": [
            { "source.rdb":   { "@table": "accounts" } },
            { "field.long":   { "name": "id" } },
            { "field.string": { "name": "name", "@required": true, "@maxLength": 100 } },
            { "field.string": { "name": "tokenHash", "@maxLength": 100${if (marked) """, "@formExclude": true""" else ""} } },
            { "field.string": { "name": "pinHash", "@maxLength": 100${if (marked) """, "children": [ { "view.password": {} } ]""" else ""} } },
            { "identity.primary": { "@fields": "id", "@generation": "increment" } }
        ] } }
      ] }
    }""".trimIndent()

    private fun controllerAndEntity(marked: Boolean): Pair<String, String> {
        val out = Files.createTempDirectory("ksecret-")
        try {
            val loader = loadString("secret-fields-$marked", model(marked))
            KotlinEntityGenerator().apply { setArgs(mapOf("outputDir" to out.toString())) }.execute(loader)
            KotlinSpringControllerGenerator().apply { setArgs(mapOf("outputDir" to out.toString())) }.execute(loader)
            val dir = out.resolve("acme/secrets")
            return Files.readString(dir.resolve("AccountController.kt")) to Files.readString(dir.resolve("Account.kt"))
        } finally {
            out.toFile().deleteRecursively()
        }
    }

    @Test
    fun `create and update paths skip both the formExclude field and the credential`() {
        val (controller, _) = controllerAndEntity(marked = true)
        // The ordinary field is still written on create and settable on PATCH / PUT ...
        assertTrue("it[name] = dto.name" in controller, controller)
        assertTrue("listOf(\"name\").any { body.has(it) }" in controller, controller)
        // ... and neither denied field reaches a write, on create or on update.
        for (f in listOf("tokenHash", "pinHash")) {
            assertFalse("it[$f] = dto.$f" in controller, "create writes $f:\n$controller")
            assertFalse("val has${f.replaceFirstChar { it.uppercase() }}" in controller, "update binds $f:\n$controller")
            assertFalse("AccountTable.$f]" in controller && "it[AccountTable.$f]" in controller, "update sets $f")
        }
    }

    @Test
    fun `only the credential is hidden on read`() {
        val (controller, entity) = controllerAndEntity(marked = true)
        assertTrue("pinHash = null," in controller, controller)
        assertTrue("tokenHash = row[AccountTable.tokenHash]," in controller, controller)
        assertTrue("JsonInclude" in entity && "pinHash" in entity, entity)
    }

    @Test
    fun `a model with neither mark generates the plain write and read paths`() {
        val (controller, entity) = controllerAndEntity(marked = false)
        for (f in listOf("tokenHash", "pinHash")) {
            assertTrue("it[$f] = dto.$f" in controller, controller)
            assertTrue("$f = row[AccountTable.$f]," in controller, controller)
        }
        assertTrue("listOf(\"name\", \"tokenHash\", \"pinHash\").any { body.has(it) }" in controller, controller)
        assertFalse("JsonInclude" in entity, entity)
    }
}

package com.metaobjects.generator.kotlin

import com.metaobjects.metadata.ktx.loadString
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * A generated create route writes only what a client may set: a server-generated key, a `readOnly`
 * column and (TPH) the discriminator and a sibling subtype's column are never bound from the body,
 * and the request type ignores an undeclared key itself. Behaviour is gated by the api-contract
 * `input-server-owned-dropped` scenarios; this pins the generated source.
 */
class KotlinServerOwnedInputTest {

    private val plain = """{
      "metadata.root": { "package": "acme::own", "children": [
        { "object.entity": { "name": "Doc", "children": [
            { "source.rdb":   { "@table": "docs" } },
            { "field.long":   { "name": "id" } },
            { "field.string": { "name": "title", "@maxLength": 100 } },
            { "field.string": { "name": "role", "@maxLength": 20, "@mutability": "readOnly" } },
            { "identity.primary": { "@fields": "id", "@generation": "increment" } }
        ] } }
      ] }
    }""".trimIndent()

    private val tph = """{
      "metadata.root": { "package": "acme::own", "children": [
        { "object.entity": { "name": "Auth", "@discriminator": "type", "children": [
            { "source.rdb": { "@table": "auths" } },
            { "field.long": { "name": "id" } },
            { "field.enum": { "name": "type", "@values": ["Bridge", "Prior"] } },
            { "field.string": { "name": "reference", "@maxLength": 80 } },
            { "field.string": { "name": "grade", "@maxLength": 20, "@mutability": "readOnly" } },
            { "identity.primary": { "@fields": "id", "@generation": "increment" } }
        ] } },
        { "object.entity": { "name": "BridgeAuth", "extends": "Auth", "@discriminatorValue": "Bridge", "children": [
            { "field.int": { "name": "quantity" } }
        ] } },
        { "object.entity": { "name": "PriorAuth", "extends": "Auth", "@discriminatorValue": "Prior", "children": [
            { "field.string": { "name": "approver", "@maxLength": 80 } }
        ] } }
      ] }
    }""".trimIndent()

    private fun gen(name: String, json: String): java.nio.file.Path {
        val out = Files.createTempDirectory("kowned-")
        val loader = loadString(name, json)
        KotlinEntityGenerator().apply { setArgs(mapOf("outputDir" to out.toString())) }.execute(loader)
        KotlinSpringControllerGenerator().apply { setArgs(mapOf("outputDir" to out.toString())) }.execute(loader)
        return out
    }

    @Test
    fun `plain create writes neither the generated key nor a readOnly column and ignores unknown keys`() {
        val out = gen("owned-plain", plain)
        try {
            val controller = Files.readString(out.resolve("acme/own/DocController.kt"))
            val create = controller.substringAfter("fun create(").substringBefore("fun update(")
            assertTrue("it[title] = dto.title" in create, create)
            assertFalse("it[role]" in create, create)
            assertFalse("it[id] = dto.id" in create, create)
            val entity = Files.readString(out.resolve("acme/own/Doc.kt"))
            assertTrue("@JsonIgnoreProperties(ignoreUnknown = true)" in entity, entity)
        } finally {
            out.toFile().deleteRecursively()
        }
    }

    @Test
    fun `TPH create writes only the route subtype's own settable columns`() {
        val out = gen("owned-tph", tph)
        try {
            val controller = Files.readString(out.resolve("acme/own/AuthController.kt"))
            val bridge = controller.substringAfter("fun createBridge(").substringBefore("@RequestMapping")
            val prior = controller.substringAfter("fun createPrior(").substringBefore("@RequestMapping")
            assertTrue("it[reference] = dto.reference" in bridge, bridge)
            assertTrue("it[quantity] = dto.quantity" in bridge, bridge)
            assertFalse("it[approver]" in bridge, bridge)
            assertFalse("it[grade]" in bridge, bridge)
            assertFalse("it[type] = dto.type" in bridge, bridge)
            assertTrue("it[approver] = dto.approver" in prior, prior)
            assertFalse("it[quantity]" in prior, prior)
            assertFalse("it[grade]" in prior, prior)
        } finally {
            out.toFile().deleteRecursively()
        }
    }
}

package com.metaobjects.generator.kotlin

import com.metaobjects.metadata.ktx.loadString
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class KotlinEntityGeneratorTest {

    private val fixture = """{
      "metadata.root": { "package": "acme::demo", "children": [
        { "object.entity": { "name": "Author", "children": [
            { "field.long":   { "name": "id" } },
            { "field.string": { "name": "name" } },
            { "field.string": { "name": "bio" } }
        ] } }
      ] }
    }""".trimIndent()

    @Test fun `emits data class with Serializable annotation`() {
        val outDir = Files.createTempDirectory("kgen-")
        try {
            val gen = KotlinEntityGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("test", fixture))

            val emitted = outDir.resolve("acme/demo/Author.kt")
            assertTrue(Files.exists(emitted),
                "expected $emitted to exist; files=${Files.walk(outDir).toList()}")

            val src = Files.readString(emitted)
            assertTrue("@Serializable" in src, "expected @Serializable in:\n$src")
            assertTrue("data class Author" in src, "expected data class in:\n$src")
            assertTrue("val id: Long" in src, "expected id: Long in:\n$src")
            assertTrue("val name: String" in src, "expected name: String in:\n$src")
            assertTrue("kotlinx.serialization.Serializable" in src,
                "expected kotlinx.serialization import in:\n$src")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    @Test fun fieldObjectEmitsTypedNestedReference() {
        // User has a field.object → Address; Address is an object.value with three fields.
        // Expected: User.kt has `val address: Address?` AND Address.kt is also emitted
        // as a @Serializable data class.
        val fx = """{
          "metadata.root": { "package": "acme::demo", "children": [
            { "object.value": { "name": "Address", "children": [
                { "field.string": { "name": "street", "@required": true } },
                { "field.string": { "name": "city",   "@required": true } },
                { "field.string": { "name": "zip",    "@required": true } }
            ] } },
            { "object.entity": { "name": "User", "children": [
                { "field.long":   { "name": "id" } },
                { "field.object": { "name": "address",
                    "@objectRef": "Address", "@storage": "flattened" } }
            ] } }
          ] }
        }""".trimIndent()

        val outDir = Files.createTempDirectory("kgen-fo-")
        try {
            val gen = KotlinEntityGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("fo", fx))

            val userKt = outDir.resolve("acme/demo/User.kt")
            val addrKt = outDir.resolve("acme/demo/Address.kt")
            assertTrue(Files.exists(userKt),
                "expected $userKt; files=${Files.walk(outDir).toList()}")
            assertTrue(Files.exists(addrKt),
                "expected $addrKt (object.value should be emitted); files=${Files.walk(outDir).toList()}")

            val userSrc = Files.readString(userKt)
            assertTrue("val address: Address?" in userSrc,
                "expected typed nested ref `val address: Address?` in:\n$userSrc")

            val addrSrc = Files.readString(addrKt)
            assertTrue("data class Address" in addrSrc, addrSrc)
            assertTrue("val street: String" in addrSrc, addrSrc)
            assertTrue("val city: String" in addrSrc, addrSrc)
            assertTrue("val zip: String" in addrSrc, addrSrc)
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    @Test fun isArrayFieldsEmitAsList() {
        // @isArray on field.object → List<T>; on a scalar field → List<String>.
        // Nullable handling applies to the List itself (List<T>? when not required;
        // List<T> when required) — not to the elements.
        val fx = """{
          "metadata.root": { "package": "acme::demo", "children": [
            { "object.value": { "name": "Tag", "children": [
                { "field.string": { "name": "label", "@required": true } }
            ] } },
            { "object.value": { "name": "Post", "children": [
                { "field.object": { "name": "tags",
                    "@objectRef": "Tag", "isArray": true } },
                { "field.string": { "name": "aliases", "isArray": true, "@required": true } }
            ] } }
          ] }
        }""".trimIndent()

        val outDir = Files.createTempDirectory("kgen-arr-")
        try {
            val gen = KotlinEntityGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("arr", fx))

            val postSrc = Files.readString(outDir.resolve("acme/demo/Post.kt"))
            // object array, not required → List<Tag>? = null
            assertTrue("val tags: List<Tag>? = null" in postSrc,
                "expected `val tags: List<Tag>? = null` in:\n$postSrc")
            // scalar array, required → List<String> (non-null)
            assertTrue("val aliases: List<String>" in postSrc,
                "expected `val aliases: List<String>` in:\n$postSrc")
            // must NOT collapse an array to a single element
            assertFalse("val tags: Tag" in postSrc,
                "array field must not emit a single element type:\n$postSrc")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    @Test fun jsonbOpenBagEntityPropertyIsParsedJsonValue() {
        // Issue #98: the `field.string @dbColumnType=jsonb` open bag is a PARSED JSON value
        // (kotlinx `JsonElement`) on the entity data class too — not a (double-encoded) raw-JSON
        // `String`. The entity data class is REUSED as the derived entity-CRUD request/response DTO,
        // so this is the entity-CRUD REST contract reaching full parity with the payload surface
        // (and with TS/Python/Java/C#). A sibling plain `field.string` stays `String`.
        val fx = """{
          "metadata.root": { "package": "acme::demo", "children": [
            { "object.entity": { "name": "Rubric", "children": [
                { "field.long":   { "name": "id" } },
                { "field.string": { "name": "weights", "@dbColumnType": "jsonb" } },
                { "field.string": { "name": "label" } }
            ] } }
          ] }
        }""".trimIndent()

        val outDir = Files.createTempDirectory("kgen-jsonb-")
        try {
            val gen = KotlinEntityGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("jsonb", fx))

            val src = Files.readString(outDir.resolve("acme/demo/Rubric.kt"))
            // jsonb open bag → parsed JSON value, imported.
            assertTrue("val weights: JsonElement" in src, "expected `val weights: JsonElement` in:\n$src")
            assertTrue("import kotlinx.serialization.json.JsonElement" in src,
                "expected JsonElement import in:\n$src")
            // plain string stays String (no double-encoding concern).
            assertTrue("val label: String" in src, "expected `val label: String` in:\n$src")
            // must NOT regress to a raw-JSON String holder for the bag.
            assertFalse("val weights: String" in src, "jsonb open bag must not be String:\n$src")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    // === field.enum coverage ===============================================

    private val enumFixture = """{
      "metadata.root": { "package": "acme::demo", "children": [
        { "object.entity": { "name": "Player", "children": [
            { "field.long": { "name": "id" } },
            { "field.enum": { "name": "status", "@required": true,
                "@values": ["ACTIVE", "INACTIVE", "BANNED"] } }
        ] } }
      ] }
    }""".trimIndent()

    @Test fun enumFieldEmitsTypedEnumClass() {
        val outDir = Files.createTempDirectory("kgen-enum-")
        try {
            val gen = KotlinEntityGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("enum-class", enumFixture))

            // Separate file for the enum class, in the same package as the entity.
            val enumKt = outDir.resolve("acme/demo/PlayerStatus.kt")
            assertTrue(Files.exists(enumKt),
                "expected $enumKt; files=${Files.walk(outDir).toList()}")
            val enumSrc = Files.readString(enumKt)
            assertTrue("@Serializable" in enumSrc, "expected @Serializable on enum:\n$enumSrc")
            assertTrue("enum class PlayerStatus" in enumSrc, "expected enum class declaration:\n$enumSrc")
            // Members emitted verbatim, preserving case.
            assertTrue("ACTIVE" in enumSrc, "expected ACTIVE member:\n$enumSrc")
            assertTrue("INACTIVE" in enumSrc, "expected INACTIVE member:\n$enumSrc")
            assertTrue("BANNED" in enumSrc, "expected BANNED member:\n$enumSrc")
            assertTrue("kotlinx.serialization.Serializable" in enumSrc,
                "expected kotlinx.serialization import:\n$enumSrc")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    @Test fun `abstract entities are skipped by KotlinEntityGenerator`() {
        // AbstractBase has @isAbstract=true (reserved "abstract" JSON key) — must NOT emit.
        // Concrete extends AbstractBase and must emit normally; the abstract check is
        // local-only (own attribute, not inherited from supers).
        val fx = """{
          "metadata.root": { "package": "acme::demo", "children": [
            { "object.entity": { "name": "AbstractBase", "abstract": true, "children": [
                { "field.string": { "name": "id" } }
            ] } },
            { "object.entity": { "name": "Concrete", "extends": "acme::demo::AbstractBase", "children": [
                { "field.string": { "name": "label" } }
            ] } }
          ] }
        }""".trimIndent()

        val outDir = Files.createTempDirectory("kgen-abstract-")
        try {
            val gen = KotlinEntityGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("abstract-skip", fx))

            val generatedFiles = outDir.toFile().walkTopDown()
                .filter { it.extension == "kt" }
                .map { it.name }
                .toList()
                .sorted()

            assertEquals(
                listOf("Concrete.kt"),
                generatedFiles,
                "Expected only Concrete.kt — AbstractBase.kt should be skipped because " +
                    "the entity is marked @isAbstract=true. Got: $generatedFiles",
            )

            val concreteKt = outDir.resolve("acme/demo/Concrete.kt")
            assertTrue(Files.exists(concreteKt), "Concrete.kt should exist at $concreteKt")
            val absentKt = outDir.resolve("acme/demo/AbstractBase.kt")
            assertFalse(Files.exists(absentKt), "AbstractBase.kt MUST NOT exist at $absentKt")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    @Test fun entityPropertyUsesEnumType() {
        val outDir = Files.createTempDirectory("kgen-enum-prop-")
        try {
            val gen = KotlinEntityGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("enum-prop", enumFixture))

            val playerKt = outDir.resolve("acme/demo/Player.kt")
            assertTrue(Files.exists(playerKt))
            val src = Files.readString(playerKt)
            // status is @required → non-nullable typed enum, NOT String.
            assertTrue("val status: PlayerStatus" in src,
                "expected typed enum property `val status: PlayerStatus`; saw:\n$src")
            assertTrue("val status: String" !in src,
                "expected the property to NOT be String anymore; saw:\n$src")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }
}

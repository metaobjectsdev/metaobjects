package com.metaobjects.generator.kotlin

import com.metaobjects.metadata.ktx.loadString
import java.nio.file.Files
import kotlin.test.Test
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

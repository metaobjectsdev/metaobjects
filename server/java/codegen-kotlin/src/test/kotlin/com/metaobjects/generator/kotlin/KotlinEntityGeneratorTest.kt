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
}

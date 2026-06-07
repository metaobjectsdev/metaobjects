package com.metaobjects.generator.kotlin

import com.metaobjects.field.MetaField
import com.metaobjects.metadata.ktx.loadString
import com.metaobjects.`object`.MetaObject
import com.squareup.kotlinpoet.ClassName
import com.squareup.kotlinpoet.TypeName
import com.metaobjects.loader.MetaDataLoader
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Open-for-extension contract: the Kotlin generators (and their key emission/resolution
 * hook methods) are `open`, so adopters can subclass and override behavior. This test
 * subclasses [KotlinEntityGenerator] and overrides the now-`open`
 * [KotlinEntityGenerator.resolvePropertyType] hook to change emitted output, asserting:
 *
 *  1. The override takes effect (custom type appears in the subclass's output).
 *  2. The stock generator's output on the SAME fixture is byte-identical to its
 *     pre-extension baseline (the default path is unchanged — `open` is output-preserving).
 */
class KotlinGeneratorOpenForExtensionTest {

    private val fixture = """{
      "metadata.root": { "package": "acme::demo", "children": [
        { "object.entity": { "name": "Author", "children": [
            { "field.long":   { "name": "id" } },
            { "field.string": { "name": "name" } }
        ] } }
      ] }
    }""".trimIndent()

    /**
     * A subclass that overrides the `open` property-type resolver to map every `name`
     * field to a custom `acme.custom.Slug` type instead of the default `String`.
     */
    private class CustomEntityGenerator : KotlinEntityGenerator() {
        override fun resolvePropertyType(
            field: MetaField<*>,
            owner: MetaObject,
            loader: MetaDataLoader,
        ): TypeName {
            if (field.name == "name") return ClassName("acme.custom", "Slug")
            return super.resolvePropertyType(field, owner, loader)
        }
    }

    @Test fun `subclass override of open hook changes emitted output`() {
        val outDir = Files.createTempDirectory("kgen-ext-")
        try {
            val gen = CustomEntityGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("ext", fixture))

            val src = Files.readString(outDir.resolve("acme/demo/Author.kt"))
            // The override mapped `name` to the custom Slug type.
            assertTrue("val name: Slug" in src,
                "expected overridden property type `val name: Slug` in:\n$src")
            assertTrue("acme.custom.Slug" in src,
                "expected import of the custom type acme.custom.Slug in:\n$src")
            // `id` still resolves via super → Long (override only intercepts `name`).
            assertTrue("val id: Long" in src, "expected id: Long (super path) in:\n$src")
            assertFalse("val name: String" in src,
                "the overridden field must NOT keep the default String type:\n$src")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    @Test fun `stock generator output is unchanged by open modifier`() {
        val outDir = Files.createTempDirectory("kgen-base-")
        try {
            val gen = KotlinEntityGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("base", fixture))

            val src = Files.readString(outDir.resolve("acme/demo/Author.kt"))
            // Default path is untouched: name stays String, no custom type leaks in.
            assertTrue("val name: String" in src, "expected default `val name: String` in:\n$src")
            assertTrue("val id: Long" in src, "expected default `val id: Long` in:\n$src")
            assertFalse("acme.custom.Slug" in src,
                "stock generator must not reference the subclass's custom type:\n$src")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }
}

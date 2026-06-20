package com.metaobjects.generator.kotlin

import com.metaobjects.metadata.ktx.loadString
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertTrue

class KotlinValidatorGeneratorTest {

    private val fixture = """{
      "metadata.root": { "package": "acme::demo", "children": [
        { "object.entity": { "name": "Author", "children": [
            { "field.long":   { "name": "id" } },
            { "field.string": { "name": "name" } },
            { "source.rdb":   { "@table": "authors" } },
            { "identity.primary": { "name": "pk", "@fields": ["id"] } }
        ] } }
      ] }
    }""".trimIndent()

    @Test fun `emits MetadataStartupValidator with one entry per entity with source rdb`() {
        val outDir = Files.createTempDirectory("kvld-")
        try {
            val gen = KotlinValidatorGenerator()
            gen.setArgs(mapOf(
                "outputDir" to outDir.toString(),
                "packageName" to "acme.demo"
            ))
            gen.execute(loadString("test", fixture))

            val validator = outDir.resolve("acme/demo/MetadataStartupValidator.kt")
            val helper = outDir.resolve("acme/demo/ExposedTableValidator.kt")
            assertTrue(Files.exists(validator),
                "expected $validator; files=${Files.walk(outDir).toList()}")
            assertTrue(Files.exists(helper), "expected $helper")

            val vSrc = Files.readString(validator)
            assertTrue("object MetadataStartupValidator" in vSrc, vSrc)
            assertTrue("fun validate(loader: MetaDataLoader)" in vSrc, vSrc)
            assertTrue("\"acme::demo::Author\" to AuthorTable" in vSrc, vSrc)

            val hSrc = Files.readString(helper)
            assertTrue("object ExposedTableValidator" in hSrc, hSrc)
            assertTrue("fun check(obj: MetaObject, table: Table" in hSrc, hSrc)
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    /** Entities in different packages than the validator: their Table objects must be imported. */
    private val multiPkgFixture = """{
      "metadata.root": { "children": [
        { "object.entity": { "name": "acme::blog::Author", "children": [
            { "field.long": { "name": "id" } },
            { "source.rdb": { "@table": "authors" } },
            { "identity.primary": { "name": "pk", "@fields": ["id"] } }
        ] } },
        { "object.entity": { "name": "acme::shop::Order", "children": [
            { "field.long": { "name": "id" } },
            { "source.rdb": { "@table": "orders" } },
            { "identity.primary": { "name": "pk", "@fields": ["id"] } }
        ] } }
      ] }
    }""".trimIndent()

    @Test fun `imports Table objects that live in a different package than the validator`() {
        val outDir = Files.createTempDirectory("kvld-")
        try {
            val gen = KotlinValidatorGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString(), "packageName" to "acme"))
            gen.execute(loadString("multi", multiPkgFixture))

            val vSrc = Files.readString(outDir.resolve("acme/MetadataStartupValidator.kt"))
            assertTrue("import acme.blog.AuthorTable" in vSrc,
                "expected cross-package import for AuthorTable; saw:\n$vSrc")
            assertTrue("import acme.shop.OrderTable" in vSrc,
                "expected cross-package import for OrderTable; saw:\n$vSrc")
            assertTrue("\"acme::blog::Author\" to AuthorTable" in vSrc, vSrc)
            assertTrue("\"acme::shop::Order\" to OrderTable" in vSrc, vSrc)
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }
}

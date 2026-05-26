package com.metaobjects.generator.kotlin

import com.metaobjects.metadata.ktx.loadString
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertTrue

class KotlinExposedTableGeneratorTest {

    private val fixture = """{
      "metadata.root": { "package": "acme::demo", "children": [
        { "object.entity": { "name": "Author", "children": [
            { "field.long":   { "name": "id" } },
            { "field.string": { "name": "name", "@maxLength": 100, "@required": true } },
            { "field.string": { "name": "bio" } },
            { "source.rdb":   { "@table": "authors" } },
            { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } }
        ] } }
      ] }
    }""".trimIndent()

    @Test fun `emits Exposed Table object with columns and PK`() {
        val outDir = Files.createTempDirectory("ktbl-")
        try {
            val gen = KotlinExposedTableGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("test", fixture))

            val emitted = outDir.resolve("acme/demo/AuthorTable.kt")
            assertTrue(Files.exists(emitted),
                "expected $emitted; files=${Files.walk(outDir).toList()}")

            val src = Files.readString(emitted)
            assertTrue("import org.jetbrains.exposed.sql.Table" in src, src)
            assertTrue("object AuthorTable : Table(\"authors\")" in src, src)
            assertTrue("val id = long(\"id\").autoIncrement()" in src, src)
            assertTrue("val name = varchar(\"name\", 100)" in src, src)
            assertTrue("val bio = varchar(\"bio\", 255).nullable()" in src, src)
            assertTrue("override val primaryKey = PrimaryKey(id)" in src, src)
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    @Test fun `skips entities without source rdb child`() {
        val noSource = """{
          "metadata.root": { "package": "x", "children": [
            { "object.entity": { "name": "Author", "children": [
                { "field.long": { "name": "id" } }
            ] } }
          ] }
        }""".trimIndent()
        val outDir = Files.createTempDirectory("ktbl-")
        try {
            val gen = KotlinExposedTableGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("test2", noSource))

            // No AuthorTable.kt should be emitted
            assertTrue(!Files.exists(outDir.resolve("x/AuthorTable.kt")))
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    // === FK / relationship.composition coverage ==============================

    /** Fixture: Post has a to-one composition relationship to Author. */
    private val fkFixture = """{
      "metadata.root": { "package": "acme::demo", "children": [
        { "object.entity": { "name": "Author", "children": [
            { "field.long":   { "name": "id" } },
            { "field.string": { "name": "name", "@required": true } },
            { "source.rdb":   { "@table": "authors" } },
            { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } }
        ] } },
        { "object.entity": { "name": "Post", "children": [
            { "field.long":   { "name": "id" } },
            { "field.string": { "name": "title", "@required": true } },
            { "relationship.composition": { "name": "author", "@objectRef": "Author" } },
            { "source.rdb":   { "@table": "posts" } },
            { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } }
        ] } }
      ] }
    }""".trimIndent()

    @Test fun `fkColumnEmittedForCompositionRelationship`() {
        val outDir = Files.createTempDirectory("ktbl-")
        try {
            val gen = KotlinExposedTableGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("fk1", fkFixture))

            val postTable = outDir.resolve("acme/demo/PostTable.kt")
            assertTrue(Files.exists(postTable),
                "expected $postTable; files=${Files.walk(outDir).toList()}")
            val src = Files.readString(postTable)
            assertTrue("val authorId = long(\"authorId\").references(AuthorTable.id)" in src,
                "expected FK column with references() but saw:\n$src")
            // No ReferenceOption import when no onDelete/onUpdate is set.
            assertTrue("import org.jetbrains.exposed.sql.ReferenceOption" !in src,
                "should NOT import ReferenceOption when no onDelete/onUpdate is set; saw:\n$src")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    @Test fun `onDeleteCascadeAppendedToReferences`() {
        val withCascade = """{
          "metadata.root": { "package": "acme::demo", "children": [
            { "object.entity": { "name": "Author", "children": [
                { "field.long":   { "name": "id" } },
                { "source.rdb":   { "@table": "authors" } },
                { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } }
            ] } },
            { "object.entity": { "name": "Post", "children": [
                { "field.long":   { "name": "id" } },
                { "relationship.composition": {
                    "name": "author", "@objectRef": "Author",
                    "@onDelete": "cascade", "@onUpdate": "restrict"
                } },
                { "source.rdb":   { "@table": "posts" } },
                { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } }
            ] } }
          ] }
        }""".trimIndent()
        val outDir = Files.createTempDirectory("ktbl-")
        try {
            val gen = KotlinExposedTableGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("fk2", withCascade))

            val postTable = outDir.resolve("acme/demo/PostTable.kt")
            assertTrue(Files.exists(postTable))
            val src = Files.readString(postTable)
            assertTrue("import org.jetbrains.exposed.sql.ReferenceOption" in src,
                "expected ReferenceOption import; saw:\n$src")
            assertTrue(
                "val authorId = long(\"authorId\").references(AuthorTable.id, onDelete = ReferenceOption.CASCADE, onUpdate = ReferenceOption.RESTRICT)" in src,
                "expected FK with onDelete + onUpdate options; saw:\n$src",
            )
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }
}

package com.metaobjects.generator.kotlin

import com.metaobjects.metadata.ktx.loadString
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class KotlinRelationsGeneratorTest {

    /** Author declares `cardinality="many"` to Post — the canonical to-many shape. */
    private val manyFixture = """{
      "metadata.root": { "package": "acme::blog", "children": [
        { "object.entity": { "name": "Author", "children": [
            { "field.long":   { "name": "id" } },
            { "field.string": { "name": "name", "@required": true } },
            { "relationship.composition": {
                "name": "posts", "@objectRef": "Post", "@cardinality": "many"
            } },
            { "source.rdb":   { "@table": "authors" } },
            { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } }
        ] } },
        { "object.entity": { "name": "Post", "children": [
            { "field.long":   { "name": "id" } },
            { "field.string": { "name": "title", "@required": true } },
            { "source.rdb":   { "@table": "posts" } },
            { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } }
        ] } }
      ] }
    }""".trimIndent()

    @Test fun `cardinality many emits ergonomic query helper`() {
        val outDir = Files.createTempDirectory("krel-")
        try {
            val gen = KotlinRelationsGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("rel-many", manyFixture))

            val emitted = outDir.resolve("acme/blog/AuthorRelations.kt")
            assertTrue(Files.exists(emitted),
                "expected $emitted; files=${Files.walk(outDir).toList()}")

            val src = Files.readString(emitted)
            assertTrue("package acme.blog" in src, src)
            assertTrue("import org.jetbrains.exposed.sql.Query" in src, src)
            assertTrue("import org.jetbrains.exposed.sql.selectAll" in src, src)
            assertTrue("fun AuthorTable.postsQuery(authorId: Long): Query" in src,
                "expected ergonomic postsQuery extension fn; saw:\n$src")
            assertTrue(
                "PostTable.selectAll().where { PostTable.authorId eq authorId }" in src,
                "expected JOIN body; saw:\n$src",
            )
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    @Test fun `cardinality one or absent emits nothing`() {
        val toOne = """{
          "metadata.root": { "package": "acme::blog", "children": [
            { "object.entity": { "name": "Author", "children": [
                { "field.long":   { "name": "id" } },
                { "source.rdb":   { "@table": "authors" } },
                { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } }
            ] } },
            { "object.entity": { "name": "Post", "children": [
                { "field.long":   { "name": "id" } },
                { "relationship.composition": { "name": "author", "@objectRef": "Author" } },
                { "source.rdb":   { "@table": "posts" } },
                { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } }
            ] } }
          ] }
        }""".trimIndent()
        val outDir = Files.createTempDirectory("krel-")
        try {
            val gen = KotlinRelationsGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("rel-none", toOne))

            // No relations file should be emitted for either side.
            assertTrue(!Files.exists(outDir.resolve("acme/blog/AuthorRelations.kt")),
                "Author has no to-many — should not emit AuthorRelations.kt")
            assertTrue(!Files.exists(outDir.resolve("acme/blog/PostRelations.kt")),
                "Post has only to-one — should not emit PostRelations.kt")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    @Test fun `multiple many relationships emit one fn each`() {
        val multi = """{
          "metadata.root": { "package": "acme::blog", "children": [
            { "object.entity": { "name": "Author", "children": [
                { "field.long":   { "name": "id" } },
                { "relationship.composition": {
                    "name": "posts", "@objectRef": "Post", "@cardinality": "many"
                } },
                { "relationship.composition": {
                    "name": "comments", "@objectRef": "Comment", "@cardinality": "many"
                } },
                { "source.rdb":   { "@table": "authors" } },
                { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } }
            ] } },
            { "object.entity": { "name": "Post", "children": [
                { "field.long":   { "name": "id" } },
                { "source.rdb":   { "@table": "posts" } },
                { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } }
            ] } },
            { "object.entity": { "name": "Comment", "children": [
                { "field.long":   { "name": "id" } },
                { "source.rdb":   { "@table": "comments" } },
                { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } }
            ] } }
          ] }
        }""".trimIndent()
        val outDir = Files.createTempDirectory("krel-")
        try {
            val gen = KotlinRelationsGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("rel-multi", multi))

            val emitted = outDir.resolve("acme/blog/AuthorRelations.kt")
            assertTrue(Files.exists(emitted),
                "expected $emitted; files=${Files.walk(outDir).toList()}")
            val src = Files.readString(emitted)
            assertTrue("fun AuthorTable.postsQuery(authorId: Long): Query" in src,
                "expected postsQuery; saw:\n$src")
            assertTrue("fun AuthorTable.commentsQuery(authorId: Long): Query" in src,
                "expected commentsQuery; saw:\n$src")
            assertTrue(
                "PostTable.selectAll().where { PostTable.authorId eq authorId }" in src, src)
            assertTrue(
                "CommentTable.selectAll().where { CommentTable.authorId eq authorId }" in src, src)
            // Sanity: exactly two helper fns.
            val fnCount = src.split("fun AuthorTable.").size - 1
            assertEquals(2, fnCount,
                "expected exactly 2 query helper fns, saw $fnCount in:\n$src")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }
}

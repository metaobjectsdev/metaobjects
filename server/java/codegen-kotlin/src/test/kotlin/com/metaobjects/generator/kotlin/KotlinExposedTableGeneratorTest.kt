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

    // === field.object + @storage coverage ===================================

    /**
     * Build a fixture: User entity + Address value-object, with a `field.object` on User
     * referencing Address under the given [storageAttr] (null = no @storage attr).
     */
    private fun fieldObjectFixture(storageAttr: String?): String {
        val storage = storageAttr?.let { ", \"@storage\": \"$it\"" } ?: ""
        return """{
          "metadata.root": { "package": "acme::demo", "children": [
            { "object.value": { "name": "Address", "children": [
                { "field.string": { "name": "street", "@required": true } },
                { "field.string": { "name": "city",   "@required": true } },
                { "field.string": { "name": "zip" } }
            ] } },
            { "object.entity": { "name": "User", "children": [
                { "field.long":   { "name": "id" } },
                { "field.object": { "name": "address", "@objectRef": "Address"$storage } },
                { "source.rdb":   { "@table": "users" } },
                { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } }
            ] } }
          ] }
        }""".trimIndent()
    }

    @Test fun storageFlattenedEmitsPrefixedColumns() {
        val outDir = Files.createTempDirectory("ktbl-flat-")
        try {
            val gen = KotlinExposedTableGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("flat", fieldObjectFixture("flattened")))

            val userTable = outDir.resolve("acme/demo/UserTable.kt")
            assertTrue(Files.exists(userTable),
                "expected $userTable; files=${Files.walk(outDir).toList()}")
            val src = Files.readString(userTable)
            // Required sub-fields → no .nullable() on their columns.
            assertTrue("val addressStreet = varchar(\"address_street\", 255)" in src,
                "expected flattened addressStreet column; saw:\n$src")
            assertTrue("val addressCity = varchar(\"address_city\", 255)" in src,
                "expected flattened addressCity column; saw:\n$src")
            // zip is NOT @required on Address → its flattened column is nullable.
            assertTrue("val addressZip = varchar(\"address_zip\", 255).nullable()" in src,
                "expected flattened nullable addressZip column; saw:\n$src")
            // No jsonb import expected for the flattened case.
            assertTrue("import org.jetbrains.exposed.sql.json.jsonb" !in src,
                "should NOT import jsonb when storage=flattened; saw:\n$src")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    @Test fun storageJsonbEmitsJsonbColumn() {
        val outDir = Files.createTempDirectory("ktbl-jsonb-")
        try {
            val gen = KotlinExposedTableGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("jsonb", fieldObjectFixture("jsonb")))

            val userTable = outDir.resolve("acme/demo/UserTable.kt")
            assertTrue(Files.exists(userTable))
            val src = Files.readString(userTable)
            assertTrue("import org.jetbrains.exposed.sql.json.jsonb" in src,
                "expected jsonb import; saw:\n$src")
            assertTrue("import kotlinx.serialization.json.Json" in src,
                "expected Json import; saw:\n$src")
            assertTrue(
                "val address = jsonb(\"address\", { Json.encodeToString(it) }, { Json.decodeFromString(it) }).nullable()" in src,
                "expected jsonb column initializer; saw:\n$src",
            )
            // Flattened sub-columns must NOT appear in the jsonb case.
            assertTrue("addressStreet" !in src,
                "should NOT emit flattened sub-columns when storage=jsonb; saw:\n$src")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    @Test fun defaultStorageBehavesAsJsonb() {
        val outDir = Files.createTempDirectory("ktbl-default-")
        try {
            val gen = KotlinExposedTableGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("default", fieldObjectFixture(null)))

            val userTable = outDir.resolve("acme/demo/UserTable.kt")
            assertTrue(Files.exists(userTable))
            val src = Files.readString(userTable)
            assertTrue("import org.jetbrains.exposed.sql.json.jsonb" in src,
                "expected jsonb import (default storage); saw:\n$src")
            assertTrue(
                "val address = jsonb(\"address\", { Json.encodeToString(it) }, { Json.decodeFromString(it) }).nullable()" in src,
                "expected jsonb column when @storage absent; saw:\n$src",
            )
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

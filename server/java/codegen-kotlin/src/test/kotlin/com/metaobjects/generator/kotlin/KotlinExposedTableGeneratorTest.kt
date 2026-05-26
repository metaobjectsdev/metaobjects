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

    // === field.enum coverage ================================================

    @Test fun enumFieldEmitsEnumerationByName() {
        val enumFixture = """{
          "metadata.root": { "package": "acme::demo", "children": [
            { "object.entity": { "name": "Player", "children": [
                { "field.long": { "name": "id" } },
                { "field.enum": { "name": "status", "@required": true,
                    "@values": ["ACTIVE", "INACTIVE", "BANNED"] } },
                { "source.rdb": { "@table": "players" } },
                { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } }
            ] } }
          ] }
        }""".trimIndent()
        val outDir = Files.createTempDirectory("ktbl-enum-")
        try {
            val gen = KotlinExposedTableGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("enum-table", enumFixture))

            val playerTable = outDir.resolve("acme/demo/PlayerTable.kt")
            assertTrue(Files.exists(playerTable),
                "expected $playerTable; files=${Files.walk(outDir).toList()}")
            val src = Files.readString(playerTable)
            // Typed enum column, not a varchar.
            assertTrue(
                "val status = enumerationByName(\"status\", 64, PlayerStatus::class)" in src,
                "expected enumerationByName column; saw:\n$src",
            )
            assertTrue("varchar(\"status\"" !in src,
                "expected NO varchar fallback for the enum column; saw:\n$src")
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

    // === Bidirectional FK: inverse to-many infers FK on target table =========

    /**
     * Author declares `cardinality="many"` to Post; Post has NO reciprocal
     * relationship. The FK column on a one-to-many lives on the many side, so
     * the generator must contribute `authorId` to PostTable from Author's
     * inverse declaration alone.
     */
    @Test fun inverseManyToOneEmitsFkOnTargetTable() {
        val inverseOnly = """{
          "metadata.root": { "package": "acme::demo", "children": [
            { "object.entity": { "name": "Author", "children": [
                { "field.long":   { "name": "id" } },
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
        val outDir = Files.createTempDirectory("ktbl-inv-")
        try {
            val gen = KotlinExposedTableGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("inv1", inverseOnly))

            val postTable = outDir.resolve("acme/demo/PostTable.kt")
            assertTrue(Files.exists(postTable),
                "expected $postTable; files=${Files.walk(outDir).toList()}")
            val postSrc = Files.readString(postTable)
            assertTrue(
                "val authorId = long(\"authorId\").references(AuthorTable.id)" in postSrc,
                "expected inferred FK column on PostTable pointing at AuthorTable; saw:\n$postSrc",
            )
            // Author's own table must NOT carry a postId column — the FK belongs on the many side.
            val authorTable = outDir.resolve("acme/demo/AuthorTable.kt")
            val authorSrc = Files.readString(authorTable)
            assertTrue("postId" !in authorSrc,
                "AuthorTable must NOT carry the inverse FK column; saw:\n$authorSrc")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    /**
     * Author declares `cardinality="many"` to Post AND Post declares its own
     * `cardinality="one"` to Author with a custom column name `creator`. The
     * declared (to-one) side wins: PostTable carries exactly one FK to Author
     * — `creatorId`, not `authorId`.
     */
    @Test fun explicitToOneWinsOverInverseMany() {
        val bothSides = """{
          "metadata.root": { "package": "acme::demo", "children": [
            { "object.entity": { "name": "Author", "children": [
                { "field.long":   { "name": "id" } },
                { "relationship.composition": {
                    "name": "posts", "@objectRef": "Post", "@cardinality": "many"
                } },
                { "source.rdb":   { "@table": "authors" } },
                { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } }
            ] } },
            { "object.entity": { "name": "Post", "children": [
                { "field.long":   { "name": "id" } },
                { "relationship.composition": {
                    "name": "creator", "@objectRef": "Author"
                } },
                { "source.rdb":   { "@table": "posts" } },
                { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } }
            ] } }
          ] }
        }""".trimIndent()
        val outDir = Files.createTempDirectory("ktbl-dedup-")
        try {
            val gen = KotlinExposedTableGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("dedup", bothSides))

            val postTable = outDir.resolve("acme/demo/PostTable.kt")
            assertTrue(Files.exists(postTable))
            val src = Files.readString(postTable)
            assertTrue(
                "val creatorId = long(\"creatorId\").references(AuthorTable.id)" in src,
                "expected declared creatorId FK column; saw:\n$src",
            )
            // The inferred authorId from Author's many-side must NOT be present —
            // the declared (to-one) side wins. Note: declared creator's name is
            // "creator" so it does not collide on name; the dedup rule is about
            // not double-emitting a SECOND FK to the same target.
            assertTrue("val authorId = " !in src,
                "should NOT also emit inferred authorId FK when explicit to-one exists on Post; saw:\n$src")
            // Sanity: exactly one references(AuthorTable.id) call in PostTable.
            val refCount = src.split("references(AuthorTable.id").size - 1
            assertTrue(refCount == 1,
                "expected exactly 1 FK to AuthorTable, saw $refCount in:\n$src")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    /**
     * The to-many side authors lifecycle intent — `@onDelete: cascade` on
     * Author's many-side must propagate into the inferred FK on PostTable.
     */
    // === source.rdb @kind: "view" coverage ==================================

    /**
     * View fixture: AuthorSummary projects Author with @kind="view".
     * Even though the primary identity declares @generation="increment", the
     * generator must NOT emit .autoIncrement() on a view column (views inherit
     * stable PKs from their underlying tables). The read-only KDoc must appear.
     */
    @Test fun viewKindEmitsReadOnlyTable() {
        val viewFixture = """{
          "metadata.root": { "package": "acme::demo", "children": [
            { "object.entity": { "name": "AuthorSummary", "children": [
                { "field.long":   { "name": "id" } },
                { "field.string": { "name": "name", "@required": true } },
                { "field.int":    { "name": "postCount" } },
                { "source.rdb":   { "@table": "v_author_summary", "@kind": "view" } },
                { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } }
            ] } }
          ] }
        }""".trimIndent()
        val outDir = Files.createTempDirectory("ktbl-view-")
        try {
            val gen = KotlinExposedTableGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("view-ro", viewFixture))

            val table = outDir.resolve("acme/demo/AuthorSummaryTable.kt")
            assertTrue(Files.exists(table),
                "expected $table; files=${Files.walk(outDir).toList()}")
            val src = Files.readString(table)
            assertTrue("READ-ONLY VIEW" in src,
                "expected READ-ONLY VIEW KDoc; saw:\n$src")
            // Columns of the entity are present.
            assertTrue("val id = long(\"id\")" in src,
                "expected id column; saw:\n$src")
            assertTrue("val name = varchar(\"name\"" in src,
                "expected name column; saw:\n$src")
            assertTrue("val postCount = integer(\"postCount\")" in src,
                "expected postCount column; saw:\n$src")
            // PK MUST NOT autoIncrement — views inherit the PK from underlying tables.
            assertTrue(".autoIncrement()" !in src,
                "view columns must NOT use .autoIncrement(); saw:\n$src")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    /**
     * Author declares a to-many composition to Post (inferred FK on Post). But
     * Post is itself a VIEW — the generator must NOT emit a `.references(...)`
     * call on a view (FKs live on the underlying tables, not the view).
     */
    @Test fun viewKindSkipsFkConstraints() {
        val viewWithFk = """{
          "metadata.root": { "package": "acme::demo", "children": [
            { "object.entity": { "name": "Author", "children": [
                { "field.long":   { "name": "id" } },
                { "relationship.composition": {
                    "name": "posts", "@objectRef": "PostView", "@cardinality": "many"
                } },
                { "source.rdb":   { "@table": "authors" } },
                { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } }
            ] } },
            { "object.entity": { "name": "PostView", "children": [
                { "field.long":   { "name": "id" } },
                { "field.long":   { "name": "authorId" } },
                { "field.string": { "name": "title", "@required": true } },
                { "source.rdb":   { "@table": "v_posts", "@kind": "view" } },
                { "identity.primary": { "name": "pk", "@fields": ["id"] } }
            ] } }
          ] }
        }""".trimIndent()
        val outDir = Files.createTempDirectory("ktbl-view-fk-")
        try {
            val gen = KotlinExposedTableGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("view-fk", viewWithFk))

            val postView = outDir.resolve("acme/demo/PostViewTable.kt")
            assertTrue(Files.exists(postView),
                "expected $postView; files=${Files.walk(outDir).toList()}")
            val src = Files.readString(postView)
            assertTrue("READ-ONLY VIEW" in src,
                "expected READ-ONLY VIEW KDoc on the view; saw:\n$src")
            // Plain column types only — no .references() in the view's Table body.
            assertTrue(".references(" !in src,
                "view must NOT emit FK .references(...); saw:\n$src")
            // No ReferenceOption import either (no FK lines emitted).
            assertTrue("import org.jetbrains.exposed.sql.ReferenceOption" !in src,
                "view must NOT import ReferenceOption; saw:\n$src")
            // The plain authorId column is still present so the view can be queried.
            assertTrue("val authorId = long(\"authorId\")" in src,
                "expected plain authorId column (no FK constraint); saw:\n$src")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    /** `source.rdb @table` flows through verbatim as the view's table name. */
    @Test fun viewKindUsesSourceRdbTableNameAsViewName() {
        val fixture = """{
          "metadata.root": { "package": "acme::demo", "children": [
            { "object.entity": { "name": "AuthorSummary", "children": [
                { "field.long":   { "name": "id" } },
                { "source.rdb":   { "@table": "v_author_summary", "@kind": "view" } },
                { "identity.primary": { "name": "pk", "@fields": ["id"] } }
            ] } }
          ] }
        }""".trimIndent()
        val outDir = Files.createTempDirectory("ktbl-view-name-")
        try {
            val gen = KotlinExposedTableGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("view-name", fixture))

            val table = outDir.resolve("acme/demo/AuthorSummaryTable.kt")
            assertTrue(Files.exists(table))
            val src = Files.readString(table)
            assertTrue("object AuthorSummaryTable : Table(\"v_author_summary\")" in src,
                "expected view table name from @table; saw:\n$src")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    // === identity.reference FK emission =====================================

    /**
     * Week declares `identity.reference @fields="programId" @references="Program"` —
     * the FK lives on the Week table on the existing programId field column. The
     * generator must decorate the column with `.references(ProgramTable.id)` rather
     * than emit a separate FK row (which would duplicate the column).
     */
    @Test fun identityReferenceEmitsFkOnFieldColumn() {
        val refFixture = """{
          "metadata.root": { "package": "x", "children": [
            { "object.entity": { "name": "Program", "children": [
                { "field.long": { "name": "id" } },
                { "source.rdb": { "@table": "programs" } },
                { "identity.primary": { "@fields": "id" } }
            ] } },
            { "object.entity": { "name": "Week", "children": [
                { "field.long": { "name": "id" } },
                { "field.long": { "name": "programId" } },
                { "source.rdb": { "@table": "weeks" } },
                { "identity.primary": { "@fields": "id" } },
                { "identity.reference": { "name": "fkProgram", "@fields": "programId", "@references": "Program" } }
            ] } }
          ] }
        }""".trimIndent()
        val outDir = Files.createTempDirectory("ktbl-idref-")
        try {
            val gen = KotlinExposedTableGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("idref", refFixture))

            val weekTable = outDir.resolve("x/WeekTable.kt")
            assertTrue(Files.exists(weekTable),
                "expected $weekTable; files=${Files.walk(outDir).toList()}")
            val src = Files.readString(weekTable)
            // FK decoration on the existing field column — NOT a separate row.
            assertTrue(
                "val programId = long(\"programId\").references(ProgramTable.id)" in src,
                "expected programId column decorated with .references(); saw:\n$src",
            )
            // Exactly one programId declaration — no duplicated emission.
            val programIdCount = Regex("""\bval\s+programId\s*=""").findAll(src).count()
            assertTrue(programIdCount == 1,
                "expected exactly 1 `val programId = ...` declaration, saw $programIdCount in:\n$src")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    /**
     * Identity.reference may carry `@onDelete` / `@onUpdate` attrs (parity with
     * the relationship.composition path); they map kebab-case → ReferenceOption.
     */
    @Test fun identityReferenceWithOnDeleteMapsToReferenceOption() {
        val refWithCascade = """{
          "metadata.root": { "package": "x", "children": [
            { "object.entity": { "name": "Program", "children": [
                { "field.long": { "name": "id" } },
                { "source.rdb": { "@table": "programs" } },
                { "identity.primary": { "@fields": "id" } }
            ] } },
            { "object.entity": { "name": "Week", "children": [
                { "field.long": { "name": "id" } },
                { "field.long": { "name": "programId" } },
                { "source.rdb": { "@table": "weeks" } },
                { "identity.primary": { "@fields": "id" } },
                { "identity.reference": { "name": "fkProgram",
                    "@fields": "programId", "@references": "Program",
                    "@onDelete": "cascade", "@onUpdate": "restrict" } }
            ] } }
          ] }
        }""".trimIndent()
        val outDir = Files.createTempDirectory("ktbl-idref-od-")
        try {
            val gen = KotlinExposedTableGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("idref-od", refWithCascade))

            val weekTable = outDir.resolve("x/WeekTable.kt")
            assertTrue(Files.exists(weekTable))
            val src = Files.readString(weekTable)
            assertTrue("import org.jetbrains.exposed.sql.ReferenceOption" in src,
                "expected ReferenceOption import; saw:\n$src")
            assertTrue(
                "val programId = long(\"programId\").references(ProgramTable.id, onDelete = ReferenceOption.CASCADE, onUpdate = ReferenceOption.RESTRICT)" in src,
                "expected FK with onDelete + onUpdate options; saw:\n$src",
            )
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    /**
     * Canonical-fixture shape: Program declares `relationship.composition many → Week`
     * AND Week declares `identity.reference → Program`. Both paths point at the same
     * programId FK on Week. The declared identity.reference must win; only ONE
     * programId column with ONE `.references(ProgramTable.id)` call is emitted.
     */
    @Test fun identityReferenceWinsOverInverseManyComposition() {
        val both = """{
          "metadata.root": { "package": "x", "children": [
            { "object.entity": { "name": "Program", "children": [
                { "field.long": { "name": "id" } },
                { "source.rdb": { "@table": "programs" } },
                { "identity.primary": { "@fields": "id", "@generation": "increment" } },
                { "relationship.composition": { "name": "weeks", "@objectRef": "Week", "@cardinality": "many" } }
            ] } },
            { "object.entity": { "name": "Week", "children": [
                { "field.long": { "name": "id" } },
                { "field.long": { "name": "programId" } },
                { "source.rdb": { "@table": "weeks" } },
                { "identity.primary": { "@fields": "id", "@generation": "increment" } },
                { "identity.reference": { "name": "fkProgram", "@fields": "programId", "@references": "Program" } }
            ] } }
          ] }
        }""".trimIndent()
        val outDir = Files.createTempDirectory("ktbl-idref-dedup-")
        try {
            val gen = KotlinExposedTableGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("idref-dedup", both))

            val weekTable = outDir.resolve("x/WeekTable.kt")
            assertTrue(Files.exists(weekTable))
            val src = Files.readString(weekTable)
            // Exactly one programId column.
            val programIdCount = Regex("""\bval\s+programId\s*=""").findAll(src).count()
            assertTrue(programIdCount == 1,
                "expected exactly 1 `val programId = ...` declaration, saw $programIdCount in:\n$src")
            // Exactly one `.references(ProgramTable.id` call (decoration on the field column).
            val refCount = src.split("references(ProgramTable.id").size - 1
            assertTrue(refCount == 1,
                "expected exactly 1 references(ProgramTable.id), saw $refCount in:\n$src")
            assertTrue(
                "val programId = long(\"programId\").references(ProgramTable.id)" in src,
                "expected decorated programId field column; saw:\n$src",
            )
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    // === non-default Exposed column-function imports ========================

    /**
     * Regression: date / timestamp fields emit column functions that live in
     * `org.jetbrains.exposed.sql.javatime.*` (extension functions on Table — NOT
     * Table member methods like varchar/integer/long). Without the matching imports
     * the generated file compile-fails with "unresolved reference: date /
     * timestampWithTimeZone". See also the comment on
     * [KotlinTypeMapper.exposedColumnImport].
     */
    @Test fun dateAndTimestampFieldsEmitJavatimeImports() {
        val withDateAndTs = """{
          "metadata.root": { "package": "x", "children": [
            { "object.entity": { "name": "Event", "children": [
                { "field.long":      { "name": "id" } },
                { "field.date":      { "name": "occursOn" } },
                { "field.timestamp": { "name": "loggedAt" } },
                { "source.rdb":      { "@table": "events" } },
                { "identity.primary": { "@fields": "id", "@generation": "increment" } }
            ] } }
          ] }
        }""".trimIndent()
        val outDir = Files.createTempDirectory("ktbl-jt-")
        try {
            val gen = KotlinExposedTableGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("jt", withDateAndTs))

            val table = outDir.resolve("x/EventTable.kt")
            assertTrue(Files.exists(table),
                "expected $table; files=${Files.walk(outDir).toList()}")
            val src = Files.readString(table)
            assertTrue("import org.jetbrains.exposed.sql.javatime.date" in src,
                "expected javatime.date import for field.date; saw:\n$src")
            assertTrue("import org.jetbrains.exposed.sql.javatime.timestampWithTimeZone" in src,
                "expected javatime.timestampWithTimeZone import for field.timestamp; saw:\n$src")
            // And the column functions are still emitted in the body.
            assertTrue("val occursOn = date(\"occursOn\")" in src, src)
            assertTrue("val loggedAt = timestampWithTimeZone(\"loggedAt\")" in src, src)
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    /**
     * Tables with only primitive columns (varchar / integer / long / bool / double /
     * uuid / text / enumerationByName) emit ONLY the `Table` import — no spurious
     * javatime / json imports. The header should stay minimal when no extension-function
     * column functions are used.
     */
    @Test fun primitiveOnlyTableEmitsNoExtraImports() {
        val primitivesOnly = """{
          "metadata.root": { "package": "x", "children": [
            { "object.entity": { "name": "Plain", "children": [
                { "field.long":    { "name": "id" } },
                { "field.string":  { "name": "name", "@required": true } },
                { "field.int":     { "name": "count" } },
                { "field.boolean": { "name": "active" } },
                { "source.rdb":    { "@table": "plain" } },
                { "identity.primary": { "@fields": "id", "@generation": "increment" } }
            ] } }
          ] }
        }""".trimIndent()
        val outDir = Files.createTempDirectory("ktbl-prim-")
        try {
            val gen = KotlinExposedTableGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("prim", primitivesOnly))

            val table = outDir.resolve("x/PlainTable.kt")
            assertTrue(Files.exists(table))
            val src = Files.readString(table)
            assertTrue("import org.jetbrains.exposed.sql.Table" in src, src)
            assertTrue("import org.jetbrains.exposed.sql.javatime" !in src,
                "should NOT emit javatime imports for a primitives-only table; saw:\n$src")
            assertTrue("import org.jetbrains.exposed.sql.json" !in src,
                "should NOT emit json imports for a primitives-only table; saw:\n$src")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    /**
     * Flattened object sub-columns also feed the import collector — if a value-object
     * has a date sub-field, the flattened column emits `date(...)` and therefore
     * needs the matching javatime import on the owning entity's Table file.
     */
    @Test fun flattenedSubFieldDateContributesImport() {
        val flatWithDate = """{
          "metadata.root": { "package": "x", "children": [
            { "object.value": { "name": "Window", "children": [
                { "field.date": { "name": "openOn", "@required": true } },
                { "field.date": { "name": "closeOn", "@required": true } }
            ] } },
            { "object.entity": { "name": "Booking", "children": [
                { "field.long":   { "name": "id" } },
                { "field.object": { "name": "window", "@objectRef": "Window", "@storage": "flattened", "@required": true } },
                { "source.rdb":   { "@table": "bookings" } },
                { "identity.primary": { "@fields": "id", "@generation": "increment" } }
            ] } }
          ] }
        }""".trimIndent()
        val outDir = Files.createTempDirectory("ktbl-flatdate-")
        try {
            val gen = KotlinExposedTableGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("flatdate", flatWithDate))

            val table = outDir.resolve("x/BookingTable.kt")
            assertTrue(Files.exists(table),
                "expected $table; files=${Files.walk(outDir).toList()}")
            val src = Files.readString(table)
            assertTrue("import org.jetbrains.exposed.sql.javatime.date" in src,
                "flattened sub-field date should contribute the javatime.date import; saw:\n$src")
            assertTrue("val windowOpenOn = date(\"window_openOn\")" in src, src)
            assertTrue("val windowCloseOn = date(\"window_closeOn\")" in src, src)
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    @Test fun manyToOneInverseRespectsOnDelete() {
        val withCascadeOnMany = """{
          "metadata.root": { "package": "acme::demo", "children": [
            { "object.entity": { "name": "Author", "children": [
                { "field.long":   { "name": "id" } },
                { "relationship.composition": {
                    "name": "posts", "@objectRef": "Post",
                    "@cardinality": "many", "@onDelete": "cascade"
                } },
                { "source.rdb":   { "@table": "authors" } },
                { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } }
            ] } },
            { "object.entity": { "name": "Post", "children": [
                { "field.long":   { "name": "id" } },
                { "source.rdb":   { "@table": "posts" } },
                { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } }
            ] } }
          ] }
        }""".trimIndent()
        val outDir = Files.createTempDirectory("ktbl-invcas-")
        try {
            val gen = KotlinExposedTableGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("invcas", withCascadeOnMany))

            val postTable = outDir.resolve("acme/demo/PostTable.kt")
            assertTrue(Files.exists(postTable))
            val src = Files.readString(postTable)
            assertTrue("import org.jetbrains.exposed.sql.ReferenceOption" in src,
                "expected ReferenceOption import for inferred FK with onDelete; saw:\n$src")
            assertTrue(
                "val authorId = long(\"authorId\").references(AuthorTable.id, onDelete = ReferenceOption.CASCADE)" in src,
                "expected inferred FK to carry onDelete=CASCADE from the many-side declaration; saw:\n$src",
            )
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }
}

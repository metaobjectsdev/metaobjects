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
            // No `@maxLength` → derived `text(...)` (Phase 1), not the old varchar(255) default.
            assertTrue("val bio = text(\"bio\").nullable()" in src, src)
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
            assertTrue("val authorId = long(\"author_id\").references(AuthorTable.id)" in src,
                "expected FK column with references() but saw:\n$src")
            // No ReferenceOption import when no onDelete/onUpdate is set.
            assertTrue("import org.jetbrains.exposed.sql.ReferenceOption" !in src,
                "should NOT import ReferenceOption when no onDelete/onUpdate is set; saw:\n$src")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    // === reserved-name / PK-ordering / non-id FK target coverage =============

    /**
     * Node has: a `source` column (collides with the Exposed `ColumnSet.source`
     * member), a self-referential FK (`parentId` → Node) declared BEFORE its PK
     * `id`, and an FK to Account whose PK is `accountId` (not `id`). All three
     * shapes used to emit non-compiling Kotlin.
     */
    private val edgeFixture = """{
      "metadata.root": { "package": "acme::demo", "children": [
        { "object.entity": { "name": "Account", "children": [
            { "field.long":   { "name": "accountId" } },
            { "field.string": { "name": "name", "@required": true } },
            { "source.rdb":   { "@table": "accounts" } },
            { "identity.primary": { "name": "pk", "@fields": ["accountId"], "@generation": "increment" } }
        ] } },
        { "object.entity": { "name": "Node", "children": [
            { "field.long":   { "name": "parentId" } },
            { "field.string": { "name": "source", "@maxLength": 50 } },
            { "field.long":   { "name": "accountRef" } },
            { "field.long":   { "name": "id" } },
            { "source.rdb":   { "@table": "nodes" } },
            { "identity.primary":   { "name": "pk", "@fields": ["id"], "@generation": "increment" } },
            { "identity.reference": { "name": "fkParent",  "@fields": ["parentId"],   "@references": "Node" } },
            { "identity.reference": { "name": "fkAccount", "@fields": ["accountRef"], "@references": "Account" } }
        ] } }
      ] }
    }""".trimIndent()

    @Test fun `reserved name, PK-first ordering, and non-id FK target all emit compilable Kotlin`() {
        val outDir = Files.createTempDirectory("ktbl-")
        try {
            val gen = KotlinExposedTableGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("edge", edgeFixture))

            val src = Files.readString(outDir.resolve("acme/demo/NodeTable.kt"))

            // (1) reserved Exposed member `source` → safe `sourceColumn` val; column name kept.
            assertTrue("val sourceColumn = varchar(\"source\", 50)" in src,
                "expected reserved `source` renamed to `sourceColumn`; saw:\n$src")

            // (2) PK `id` emitted BEFORE the self-referential FK that references it.
            val idIdx = src.indexOf("val id = ")
            val parentIdx = src.indexOf("val parentId = ")
            assertTrue(idIdx in 0 until parentIdx,
                "PK `id` must be declared before self-FK `parentId` (idIdx=$idIdx parentIdx=$parentIdx);\n$src")
            assertTrue("references(NodeTable.id)" in src, "expected self-FK references(NodeTable.id);\n$src")

            // (3) FK to Account targets its real PK `accountId`, not a hardcoded `.id`.
            assertTrue("references(AccountTable.accountId)" in src,
                "expected FK to non-id PK `references(AccountTable.accountId)`; saw:\n$src")
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
            // Required sub-fields → no .nullable() on their columns. No `@maxLength` on the
            // Address sub-fields → derived `text(...)` (Phase 1), not the old varchar(255).
            assertTrue("val addressStreet = text(\"address_street\")" in src,
                "expected flattened addressStreet column; saw:\n$src")
            assertTrue("val addressCity = text(\"address_city\")" in src,
                "expected flattened addressCity column; saw:\n$src")
            // zip is NOT @required on Address → its flattened column is nullable.
            assertTrue("val addressZip = text(\"address_zip\").nullable()" in src,
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
                "val authorId = long(\"author_id\").references(AuthorTable.id, onDelete = ReferenceOption.CASCADE, onUpdate = ReferenceOption.RESTRICT)" in src,
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
                "val authorId = long(\"author_id\").references(AuthorTable.id)" in postSrc,
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
                "val creatorId = long(\"creator_id\").references(AuthorTable.id)" in src,
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
            { "object.projection": { "name": "AuthorSummary", "children": [
                { "field.long":   { "name": "id" } },
                { "field.string": { "name": "name", "@required": true } },
                { "field.int":    { "name": "postCount" } },
                { "source.rdb":   { "@table": "v_author_summary", "@kind": "view" } }
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
            // No `@maxLength` → derived `text(...)` (Phase 1).
            assertTrue("val name = text(\"name\")" in src,
                "expected name column; saw:\n$src")
            assertTrue("val postCount = integer(\"post_count\")" in src,
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
            { "object.projection": { "name": "PostView", "children": [
                { "field.long":   { "name": "id" } },
                { "field.long":   { "name": "authorId" } },
                { "field.string": { "name": "title", "@required": true } },
                { "source.rdb":   { "@table": "v_posts", "@kind": "view" } }
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
            assertTrue("val authorId = long(\"author_id\")" in src,
                "expected plain authorId column (no FK constraint); saw:\n$src")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    /** `source.rdb @table` flows through verbatim as the view's table name. */
    @Test fun viewKindUsesSourceRdbTableNameAsViewName() {
        val fixture = """{
          "metadata.root": { "package": "acme::demo", "children": [
            { "object.projection": { "name": "AuthorSummary", "children": [
                { "field.long":   { "name": "id" } },
                { "source.rdb":   { "@table": "v_author_summary", "@kind": "view" } }
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
                "val programId = long(\"program_id\").references(ProgramTable.id)" in src,
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
     * SP-G Unit 6a: `@onDelete` / `@onUpdate` are NOT part of `identity.reference`
     * in the cross-port canonical — referential actions live only on
     * `relationship.composition`. A reference-identity FK therefore emits a PLAIN
     * `.references(...)` with no `ReferenceOption` suffix, even if the (now
     * non-schema) `@onDelete` / `@onUpdate` attrs are present on the node.
     * Declare a `relationship.composition` to drive `ReferenceOption` emission.
     */
    @Test fun identityReferenceIgnoresOnDeletePerCanonical() {
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
            assertTrue(
                "val programId = long(\"program_id\").references(ProgramTable.id)" in src,
                "expected plain FK reference with NO ReferenceOption suffix; saw:\n$src",
            )
            assertTrue("ReferenceOption" !in src,
                "reference-identity FK must NOT emit ReferenceOption (referential actions are " +
                    "relationship.composition-only per the cross-port canonical); saw:\n$src")
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
                "val programId = long(\"program_id\").references(ProgramTable.id)" in src,
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
     * the generated file compile-fails with "unresolved reference: date / timestamp".
     * See also the comment on [KotlinTypeMapper.exposedColumnImport].
     *
     * The `@localTime:true` naive opt-out on a `field.timestamp` selects `datetime(...)`
     * (Postgres `timestamp without time zone`, java.time.LocalDateTime) — the zone-less
     * wall-clock wire shape (ADR-0036 Wave 2). Column names are snake_case-d for Postgres
     * convention. The DEFAULT (instant/TZ-aware) variant is covered by
     * [timestampFieldDefaultsToInstantTzColumn].
     */
    @Test fun dateAndTimestampFieldsEmitJavatimeImports() {
        val withDateAndTs = """{
          "metadata.root": { "package": "x", "children": [
            { "object.entity": { "name": "Event", "children": [
                { "field.long":      { "name": "id" } },
                { "field.date":      { "name": "occursOn" } },
                { "field.timestamp": { "name": "loggedAt", "@localTime": true } },
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
            assertTrue("import org.jetbrains.exposed.sql.javatime.datetime\n" in src ||
                src.endsWith("import org.jetbrains.exposed.sql.javatime.datetime"),
                "expected javatime.datetime import for @localTime field.timestamp; saw:\n$src")
            // @localTime naive `field.timestamp` MUST NOT bring in the instant TZ variant.
            assertTrue("instantWithTimeZone" !in src,
                "@localTime field.timestamp should NOT emit instantWithTimeZone; saw:\n$src")
            // Column names are snake_case-d for Postgres convention.
            assertTrue("val occursOn = date(\"occurs_on\")" in src, src)
            assertTrue("val loggedAt = datetime(\"logged_at\")" in src, src)
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    /**
     * Default (ADR-0036 Wave 2): a plain `field.timestamp` selects a
     * `Column<java.time.Instant>` column whose Postgres DDL is `timestamp with time zone`.
     * The emitted column function is the `instantWithTimeZone("col")` extension (a custom
     * `ColumnType<Instant>`), NOT Exposed's native `timestampWithTimeZone(...)` (which is
     * `Column<OffsetDateTime>` and would mismatch the `Instant` data class).
     *
     * The supporting helper (`MetaInstantWithTimeZoneColumnType` + the extension) is emitted
     * ONCE PER PACKAGE into a shared `MetaInstantWithTimeZoneColumnType.kt` file (internal
     * visibility, same package), so the table file itself carries NEITHER the helper NOR the
     * Instant/Column/javatime imports — it just calls the same-package internal extension.
     */
    @Test fun timestampFieldDefaultsToInstantTzColumn() {
        val tzFixture = """{
          "metadata.root": { "package": "x", "children": [
            { "object.entity": { "name": "Event", "children": [
                { "field.long":      { "name": "id" } },
                { "field.timestamp": { "name": "occurredAt" } },
                { "source.rdb":      { "@table": "events" } },
                { "identity.primary": { "@fields": "id", "@generation": "increment" } }
            ] } }
          ] }
        }""".trimIndent()
        val outDir = Files.createTempDirectory("ktbl-jt-tz-")
        try {
            val gen = KotlinExposedTableGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("jt-tz", tzFixture))

            val src = Files.readString(outDir.resolve("x/EventTable.kt"))
            // The column is the `instantWithTimeZone(...)` extension, NOT the native
            // Exposed `timestampWithTimeZone(...)` (Column<OffsetDateTime>).
            assertTrue("val occurredAt = instantWithTimeZone(\"occurred_at\")" in src,
                "expected instantWithTimeZone column for opt-in TZ-aware; saw:\n$src")
            assertTrue("import org.jetbrains.exposed.sql.javatime.timestampWithTimeZone" !in src,
                "must NOT import native timestampWithTimeZone (it is Column<OffsetDateTime>); saw:\n$src")
            // The helper is NO LONGER inlined into the table file — it lives in a shared
            // per-package support file. The table file must not carry the helper or its imports.
            assertTrue("class MetaInstantWithTimeZoneColumnType" !in src,
                "support helper must NOT be inlined into the table file (now per-package); saw:\n$src")
            assertTrue("import java.time.Instant" !in src && "import org.jetbrains.exposed.sql.Column\n" !in src,
                "table file must NOT carry Instant/Column imports (helper is per-package); saw:\n$src")

            // The shared per-package support file carries the helper + needed imports + DDL.
            val support = Files.readString(outDir.resolve("x/MetaInstantWithTimeZoneColumnType.kt"))
            assertTrue("internal class MetaInstantWithTimeZoneColumnType" in support,
                "expected the per-package internal custom ColumnType<Instant>; saw:\n$support")
            assertTrue("internal fun Table.instantWithTimeZone(name: String): Column<Instant>" in support,
                "expected the per-package internal instantWithTimeZone extension; saw:\n$support")
            assertTrue("import java.time.Instant" in support && "import org.jetbrains.exposed.sql.Column" in support,
                "expected Instant + Column imports in the support file; saw:\n$support")
            // The custom type overrides sqlType() to the dialect's TIMESTAMP WITH TIME ZONE.
            assertTrue("timestampWithTimeZoneType()" in support,
                "custom ColumnType must produce TIMESTAMP WITH TIME ZONE DDL; saw:\n$support")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    /**
     * Regression for the multi-table-per-package redeclaration bug: when TWO entities in the
     * SAME package each carry a default (instant/TZ-aware) timestamp column, the earlier per-file
     * inline emission emitted the top-level `MetaInstantWithTimeZoneColumnType` class +
     * `instantWithTimeZone` extension into BOTH `*Table.kt` files → redeclaration + private-access
     * compile errors (162 errors in a real consumer). The fix emits the helper ONCE PER PACKAGE
     * into a shared `MetaInstantWithTimeZoneColumnType.kt` (internal visibility) that both tables
     * reference.
     *
     * Asserts: exactly ONE shared support file; the helper appears ONLY there (not in either
     * table file); both tables call `instantWithTimeZone(...)`. On the PRE-FIX code this fails —
     * each table file inlined its own `private class MetaInstantWithTimeZoneColumnType` and no
     * shared support file existed.
     */
    @Test fun twoTimestampTzTablesInSamePackageShareOneSupportFile() {
        val twoTzTables = """{
          "metadata.root": { "package": "acme::audit", "children": [
            { "object.entity": { "name": "Role", "children": [
                { "field.long":      { "name": "id" } },
                { "field.timestamp": { "name": "createdAt"  } },
                { "source.rdb":      { "@table": "roles" } },
                { "identity.primary": { "@fields": "id", "@generation": "increment" } }
            ] } },
            { "object.entity": { "name": "UserAuthToken", "children": [
                { "field.long":      { "name": "id" } },
                { "field.timestamp": { "name": "issuedAt"  } },
                { "field.timestamp": { "name": "expiresAt"  } },
                { "source.rdb":      { "@table": "user_auth_tokens" } },
                { "identity.primary": { "@fields": "id", "@generation": "increment" } }
            ] } }
          ] }
        }""".trimIndent()
        val outDir = Files.createTempDirectory("ktbl-tz-multi-")
        try {
            val gen = KotlinExposedTableGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("tz-multi", twoTzTables))

            val roleSrc = Files.readString(outDir.resolve("acme/audit/RoleTable.kt"))
            val tokenSrc = Files.readString(outDir.resolve("acme/audit/UserAuthTokenTable.kt"))

            // Both tables call the shared extension…
            assertTrue("val createdAt = instantWithTimeZone(\"created_at\")" in roleSrc,
                "RoleTable must call instantWithTimeZone; saw:\n$roleSrc")
            assertTrue("val issuedAt = instantWithTimeZone(\"issued_at\")" in tokenSrc,
                "UserAuthTokenTable must call instantWithTimeZone; saw:\n$tokenSrc")
            assertTrue("val expiresAt = instantWithTimeZone(\"expires_at\")" in tokenSrc,
                "UserAuthTokenTable must call instantWithTimeZone for expiresAt; saw:\n$tokenSrc")

            // …but NEITHER table file inlines the helper class (the redeclaration root cause).
            assertTrue("class MetaInstantWithTimeZoneColumnType" !in roleSrc,
                "RoleTable must NOT inline the helper class; saw:\n$roleSrc")
            assertTrue("class MetaInstantWithTimeZoneColumnType" !in tokenSrc,
                "UserAuthTokenTable must NOT inline the helper class; saw:\n$tokenSrc")

            // Exactly ONE shared support file for the package, with the internal helper + extension.
            val supportFile = outDir.resolve("acme/audit/MetaInstantWithTimeZoneColumnType.kt")
            assertTrue(Files.exists(supportFile),
                "expected one shared support file per package; files=${Files.walk(outDir).toList()}")
            val support = Files.readString(supportFile)
            assertTrue("package acme.audit" in support,
                "support file must be in the package; saw:\n$support")
            assertTrue("internal class MetaInstantWithTimeZoneColumnType" in support,
                "support helper must be internal (package+module-private); saw:\n$support")
            assertTrue("internal fun Table.instantWithTimeZone(name: String): Column<Instant>" in support,
                "support extension must be internal; saw:\n$support")
            // The helper class is declared exactly once across the whole package output.
            val allSrc = Files.walk(outDir).filter { Files.isRegularFile(it) }
                .map { Files.readString(it) }.toList().joinToString("\n")
            val helperDeclCount =
                Regex("""\bclass\s+MetaInstantWithTimeZoneColumnType\b""").findAll(allSrc).count()
            assertTrue(helperDeclCount == 1,
                "expected the helper class declared exactly once per package, saw $helperDeclCount")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    /**
     * `@dbColumnType=uuid` on a `field.string` emits an Exposed `uuid("col")` column
     * (Postgres native uuid type) instead of `varchar(...)`. The Kotlin data class
     * property type stays `String` — Exposed coerces String ↔ uuid at the SQL boundary.
     */
    @Test fun stringFieldWithDbColumnTypeUuidEmitsUuidColumn() {
        val uuidFixture = """{
          "metadata.root": { "package": "x", "children": [
            { "object.entity": { "name": "Account", "children": [
                { "field.string": { "name": "id", "@required": true, "@dbColumnType": "uuid" } },
                { "field.string": { "name": "userId", "@required": true, "@dbColumnType": "uuid" } },
                { "field.string": { "name": "displayName" } },
                { "source.rdb":   { "@table": "accounts" } },
                { "identity.primary": { "@fields": "id" } }
            ] } }
          ] }
        }""".trimIndent()
        val outDir = Files.createTempDirectory("ktbl-uuid-")
        try {
            val gen = KotlinExposedTableGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("uuid", uuidFixture))

            val src = Files.readString(outDir.resolve("x/AccountTable.kt"))
            // uuid columns from @dbColumnType=uuid — NOT varchar.
            assertTrue("val id = uuid(\"id\")" in src,
                "expected uuid id column (not varchar); saw:\n$src")
            assertTrue("val userId = uuid(\"user_id\")" in src,
                "expected uuid userId column with snake_case name; saw:\n$src")
            // Regular field.string (no @dbColumnType, no @maxLength) derives `text(...)` (Phase 1).
            assertTrue("val displayName = text(\"display_name\")" in src,
                "expected plain text for displayName (no @dbColumnType/@maxLength); saw:\n$src")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    /**
     * Snake_case column-name conversion is applied uniformly: regular fields,
     * the snake-cased physical column matches Postgres convention; the Kotlin
     * property name stays camelCase (Kotlin convention).
     */
    @Test fun camelCaseFieldNamesEmitSnakeCaseColumnNames() {
        val camelFixture = """{
          "metadata.root": { "package": "x", "children": [
            { "object.entity": { "name": "User", "children": [
                { "field.long":      { "name": "id" } },
                { "field.string":    { "name": "displayName", "@required": true } },
                { "field.string":    { "name": "htmlContent" } },
                { "field.int":       { "name": "loginCount" } },
                { "source.rdb":      { "@table": "users" } },
                { "identity.primary": { "@fields": "id", "@generation": "increment" } }
            ] } }
          ] }
        }""".trimIndent()
        val outDir = Files.createTempDirectory("ktbl-snake-")
        try {
            val gen = KotlinExposedTableGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("snake", camelFixture))

            val src = Files.readString(outDir.resolve("x/UserTable.kt"))
            // No `@maxLength` → derived `text(...)` (Phase 1); snake_case column name preserved.
            assertTrue("val displayName = text(\"display_name\")" in src,
                "expected snake_case column for camelCase field; saw:\n$src")
            assertTrue("val htmlContent = text(\"html_content\").nullable()" in src,
                "expected snake_case column for camelCase field; saw:\n$src")
            assertTrue("val loginCount = integer(\"login_count\")" in src,
                "expected snake_case column for camelCase int field; saw:\n$src")
            // Verbatim camelCase column NAMES (the string in quotes) must NOT appear.
            assertTrue("\"displayName\"" !in src,
                "should NOT emit camelCase column name string; saw:\n$src")
            assertTrue("\"htmlContent\"" !in src,
                "should NOT emit camelCase column name string; saw:\n$src")
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
            // Flattened sub-column physical name is snake-joined: parent + sub, both snake_case-d.
            assertTrue("val windowOpenOn = date(\"window_open_on\")" in src, src)
            assertTrue("val windowCloseOn = date(\"window_close_on\")" in src, src)
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
                "val authorId = long(\"author_id\").references(AuthorTable.id, onDelete = ReferenceOption.CASCADE)" in src,
                "expected inferred FK to carry onDelete=CASCADE from the many-side declaration; saw:\n$src",
            )
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    // === inherited identity.primary coverage =================================

    /**
     * Wave 0 evidence: tables for entities extending an abstract base entity (which
     * declares `identity.primary` on `id`) were generated without an
     * `override val primaryKey = PrimaryKey(id)` line, because the emitter
     * collected identities from `entity.children` only and never walked the
     * `extends` chain. The fix uses `getIdentities(true)` so inherited primary
     * identities are picked up. This regression test guards the fix.
     */
    // === composite identity.primary coverage =================================

    /**
     * Regression: `identity.primary` with multiple fields (composite PK, e.g.
     * a junction table keyed by (userId, roleId)) silently truncated to the
     * first field — generating `PrimaryKey(userId)` instead of
     * `PrimaryKey(userId, roleId)`. The fix joins every field in the
     * identity's `fields` list. Surfaced by a downstream adopter that
     * authored its first composite-keyed entity; every prior user had
     * single-field PKs.
     */
    @Test fun `composite identity primary emits all fields in PrimaryKey`() {
        val fx = """{
          "metadata.root": { "package": "acme::demo", "children": [
            { "object.entity": { "name": "Membership", "children": [
                { "field.string": { "name": "userId", "@required": true } },
                { "field.string": { "name": "roleId", "@required": true } },
                { "source.rdb":   { "@table": "memberships" } },
                { "identity.primary": { "name": "pk", "@fields": ["userId", "roleId"] } }
            ] } }
          ] }
        }""".trimIndent()
        val outDir = Files.createTempDirectory("ktbl-composite-pk-")
        try {
            val gen = KotlinExposedTableGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("composite-pk", fx))

            val tableFile = outDir.resolve("acme/demo/MembershipTable.kt").toFile()
            assertTrue(tableFile.exists(),
                "MembershipTable.kt should be generated at $tableFile")
            val src = tableFile.readText()
            assertTrue(
                "override val primaryKey = PrimaryKey(userId, roleId)" in src,
                "Composite PK should emit both fields — was:\n$src",
            )
            // Both PK fields must be non-nullable (they're part of the PK).
            // Column names are snake_case-d for Postgres convention. No `@maxLength` on the
            // PK string fields → derived `text(...)` (Phase 1), not the old varchar(255).
            assertTrue(
                "val userId = text(\"user_id\")\n" in src ||
                    "val userId = text(\"user_id\")\r\n" in src ||
                    ("val userId = text(\"user_id\")" in src && "userId = text(\"user_id\").nullable" !in src),
                "userId (PK member) should NOT be .nullable() — was:\n$src",
            )
            assertTrue(
                "roleId = text(\"role_id\").nullable" !in src,
                "roleId (PK member) should NOT be .nullable() — was:\n$src",
            )
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    /**
     * When an `identity.reference` decoration points at a target entity in a
     * DIFFERENT Kotlin package, the generated Table file must import the target
     * Table symbol — otherwise the bare `TargetTable.id` inside `.references(...)`
     * fails to resolve at compile time. Same-package targets need no import.
     *
     * Uses two {@link InMemoryStringSource} so each package is loaded as its own
     * metadata.root (the loader only honors one root `package` attr per source).
     */
    @Test fun identityReferenceAcrossPackagesAddsImport() {
        val tenantSrc = """{
          "metadata.root": { "package": "acme::tenancy", "children": [
            { "object.entity": { "name": "Tenant", "children": [
                { "field.long": { "name": "id" } },
                { "source.rdb": { "@table": "tenants" } },
                { "identity.primary": { "name": "pk", "@fields": ["id"] } }
            ] } }
          ] }
        }""".trimIndent()
        val userSrc = """{
          "metadata.root": { "package": "acme::identity", "children": [
            { "object.entity": { "name": "User", "children": [
                { "field.long": { "name": "id" } },
                { "field.long": { "name": "tenantId" } },
                { "source.rdb": { "@table": "users" } },
                { "identity.primary": { "name": "pk", "@fields": ["id"] } },
                { "identity.reference": { "name": "fkTenant",
                    "@fields": "tenantId", "@references": "Tenant" } }
            ] } }
          ] }
        }""".trimIndent()
        val outDir = Files.createTempDirectory("ktbl-xpkg-")
        try {
            val loader = com.metaobjects.loader.MetaDataLoader.createManual(false, "xpkg-idref")
            loader.init()
            loader.load(listOf(
                com.metaobjects.loader.InMemoryStringSource(tenantSrc, "tenant"),
                com.metaobjects.loader.InMemoryStringSource(userSrc, "user"),
            ))
            loader.register()
            val gen = KotlinExposedTableGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loader)

            val userTable = outDir.resolve("acme/identity/UserTable.kt")
            assertTrue(Files.exists(userTable),
                "expected $userTable; files=${Files.walk(outDir).toList()}")
            val src = Files.readString(userTable)
            // Cross-package import for the referenced table is required for the
            // bare `TenantTable.id` reference to compile.
            assertTrue("import acme.tenancy.TenantTable" in src,
                "expected cross-package import for TenantTable; saw:\n$src")
            assertTrue(
                "val tenantId = long(\"tenant_id\").references(TenantTable.id)" in src,
                "expected tenantId column decorated with .references(); saw:\n$src",
            )

            // Same-package: TenantTable.kt should NOT import itself.
            val tenantTable = outDir.resolve("acme/tenancy/TenantTable.kt")
            assertTrue(Files.exists(tenantTable))
            val tenantTblSrc = Files.readString(tenantTable)
            assertTrue("import acme.tenancy.TenantTable" !in tenantTblSrc,
                "Tenant's own table file should not self-import; saw:\n$tenantTblSrc")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    // === identity.secondary coverage =========================================

    /**
     * `identity.secondary` declares an alternate uniqueness constraint (e.g.
     * `roles.name UNIQUE`). The generator must emit a matching Exposed
     * {@code uniqueIndex(...)} call inside an `init { }` block so Exposed-side
     * query/lookup APIs can see the index. Without this, the DB-level UNIQUE
     * still enforces the constraint but the Exposed metadata is incomplete and
     * downstream adopters can't use the index name for refactor / introspection.
     */
    @Test fun `identity secondary emits Exposed uniqueIndex`() {
        val fx = """{
          "metadata.root": { "package": "acme::demo", "children": [
            { "object.entity": { "name": "Role", "children": [
                { "field.string": { "name": "id",   "@required": true, "@dbColumnType": "uuid" } },
                { "field.string": { "name": "name", "@required": true, "@maxLength": 64 } },
                { "source.rdb":   { "@table": "roles" } },
                { "identity.primary":   { "name": "pk",      "@fields": ["id"] } },
                { "identity.secondary": { "name": "by_name", "@fields": ["name"] } }
            ] } }
          ] }
        }""".trimIndent()
        val outDir = Files.createTempDirectory("ktbl-secondary-")
        try {
            val gen = KotlinExposedTableGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("secondary", fx))

            val roleTable = outDir.resolve("acme/demo/RoleTable.kt").toFile()
            assertTrue(roleTable.exists(),
                "RoleTable.kt should be generated at $roleTable")
            val src = roleTable.readText()
            assertTrue(
                "uniqueIndex(\"by_name\", name)" in src,
                "Expected uniqueIndex declaration for identity.secondary 'by_name' — was:\n$src",
            )
            // The uniqueIndex call must live inside an init { } block so it runs
            // when the Table object is initialized.
            assertTrue(
                Regex("""init\s*\{[^}]*uniqueIndex\("by_name", name\)""", RegexOption.DOT_MATCHES_ALL).containsMatchIn(src),
                "uniqueIndex should be inside an init { } block — was:\n$src",
            )
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    /**
     * Multi-field `identity.secondary` (composite unique key, e.g. (tenantId, slug)
     * unique within a tenant) emits a single uniqueIndex call with all fields in
     * declaration order.
     */
    @Test fun `composite identity secondary emits multi-column uniqueIndex`() {
        val fx = """{
          "metadata.root": { "package": "acme::demo", "children": [
            { "object.entity": { "name": "Page", "children": [
                { "field.long":   { "name": "id" } },
                { "field.string": { "name": "tenantId", "@required": true } },
                { "field.string": { "name": "slug",     "@required": true } },
                { "source.rdb":   { "@table": "pages" } },
                { "identity.primary":   { "name": "pk",            "@fields": ["id"], "@generation": "increment" } },
                { "identity.secondary": { "name": "by_tenant_slug","@fields": ["tenantId", "slug"] } }
            ] } }
          ] }
        }""".trimIndent()
        val outDir = Files.createTempDirectory("ktbl-secondary-multi-")
        try {
            val gen = KotlinExposedTableGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("secondary-multi", fx))

            val pageTable = outDir.resolve("acme/demo/PageTable.kt").toFile()
            assertTrue(pageTable.exists())
            val src = pageTable.readText()
            assertTrue(
                "uniqueIndex(\"by_tenant_slug\", tenantId, slug)" in src,
                "Expected multi-column uniqueIndex — was:\n$src",
            )
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    /**
     * Multiple `identity.secondary` declarations on one entity emit multiple
     * uniqueIndex calls grouped inside a single init { } block.
     */
    @Test fun `multiple identity secondary entries share an init block`() {
        val fx = """{
          "metadata.root": { "package": "acme::demo", "children": [
            { "object.entity": { "name": "User", "children": [
                { "field.long":   { "name": "id" } },
                { "field.string": { "name": "email",     "@required": true } },
                { "field.string": { "name": "username",  "@required": true } },
                { "source.rdb":   { "@table": "users" } },
                { "identity.primary":   { "name": "pk",          "@fields": ["id"], "@generation": "increment" } },
                { "identity.secondary": { "name": "by_email",    "@fields": ["email"] } },
                { "identity.secondary": { "name": "by_username", "@fields": ["username"] } }
            ] } }
          ] }
        }""".trimIndent()
        val outDir = Files.createTempDirectory("ktbl-secondary-many-")
        try {
            val gen = KotlinExposedTableGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("secondary-many", fx))

            val userTable = outDir.resolve("acme/demo/UserTable.kt").toFile()
            assertTrue(userTable.exists())
            val src = userTable.readText()
            assertTrue("uniqueIndex(\"by_email\", email)" in src,
                "Expected by_email uniqueIndex — was:\n$src")
            assertTrue("uniqueIndex(\"by_username\", username)" in src,
                "Expected by_username uniqueIndex — was:\n$src")
            // Exactly one init { } block — both calls share it.
            val initCount = Regex("""\binit\s*\{""").findAll(src).count()
            assertTrue(initCount == 1,
                "Expected exactly 1 init { } block, saw $initCount — was:\n$src")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    /**
     * Inherited `identity.secondary` (declared on an abstract base entity) must
     * also be emitted on the concrete child's Table — parity with how
     * `identity.primary` is walked through {@code getIdentities(true)}.
     */
    @Test fun `inherited identity secondary is emitted on child Table`() {
        val fx = """{
          "metadata.root": { "package": "acme::demo", "children": [
            { "object.entity": { "name": "Named", "abstract": true, "children": [
                { "field.string": { "name": "id",   "@required": true } },
                { "field.string": { "name": "name", "@required": true, "@maxLength": 64 } },
                { "identity.primary":   { "name": "pk",      "@fields": ["id"] } },
                { "identity.secondary": { "name": "by_name", "@fields": ["name"] } }
            ] } },
            { "object.entity": { "name": "Tag", "extends": "acme::demo::Named", "children": [
                { "source.rdb":   { "@table": "tags" } }
            ] } }
          ] }
        }""".trimIndent()
        val outDir = Files.createTempDirectory("ktbl-secondary-inherit-")
        try {
            val gen = KotlinExposedTableGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("secondary-inherit", fx))

            val tagTable = outDir.resolve("acme/demo/TagTable.kt").toFile()
            assertTrue(tagTable.exists(),
                "TagTable.kt should be generated at $tagTable")
            val src = tagTable.readText()
            assertTrue(
                "uniqueIndex(\"by_name\", name)" in src,
                "TagTable should pick up inherited identity.secondary from Named — was:\n$src",
            )
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    @Test fun `inherited identity primary is emitted on child Table`() {
        val fx = """{
          "metadata.root": { "package": "acme::demo", "children": [
            { "object.entity": { "name": "Base", "abstract": true, "children": [
                { "field.string":     { "name": "id" } },
                { "identity.primary": { "name": "pk", "@fields": ["id"] } }
            ] } },
            { "object.entity": { "name": "Child", "extends": "acme::demo::Base", "children": [
                { "field.string": { "name": "label" } },
                { "source.rdb":   { "@table": "children" } }
            ] } }
          ] }
        }""".trimIndent()

        val outDir = Files.createTempDirectory("ktbl-inherit-pk-")
        try {
            val gen = KotlinExposedTableGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("inherit-pk", fx))

            val childTable = outDir.resolve("acme/demo/ChildTable.kt").toFile()
            assertTrue(childTable.exists(), "ChildTable.kt should be generated at $childTable")
            val src = childTable.readText()
            assertTrue(
                "override val primaryKey" in src,
                "ChildTable should declare primaryKey inherited from Base — was:\n$src",
            )
            assertTrue(
                "PrimaryKey(id)" in src,
                "primaryKey should reference id from Base — was:\n$src",
            )
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    // === R6 Plan 2a: field.uuid PK + @generation:uuid → gen_random_uuid() ====

    /**
     * A `field.uuid` primary key with `@generation: uuid` must emit a native
     * `uuid("id")` Exposed column carrying a server-side `gen_random_uuid()`
     * default — the Postgres-side mint, routed through the same generation
     * signal that `@generation: increment` uses for `.autoIncrement()` (never a
     * parallel emitter). A non-key `field.uuid` stays a plain `uuid(...)` column.
     */
    @Test fun `uuid pk with generation uuid emits gen_random_uuid server default`() {
        val fx = """{
          "metadata.root": { "package": "acme::demo", "children": [
            { "object.entity": { "name": "Asset", "children": [
                { "field.uuid":   { "name": "id" } },
                { "field.uuid":   { "name": "ownerId", "@required": true } },
                { "source.rdb":   { "@table": "assets" } },
                { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "uuid" } }
            ] } }
          ] }
        }""".trimIndent()
        val outDir = Files.createTempDirectory("ktbl-uuid-pk-")
        try {
            val gen = KotlinExposedTableGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("uuid-pk", fx))

            val table = outDir.resolve("acme/demo/AssetTable.kt").toFile()
            assertTrue(table.exists(), "AssetTable.kt should be generated at $table")
            val src = table.readText()
            // PK is a native uuid column with the gen_random_uuid() server default.
            assertTrue(
                "val id = uuid(\"id\").defaultExpression(CustomFunction(\"gen_random_uuid\", UUIDColumnType()))" in src,
                "expected uuid PK with gen_random_uuid() default; saw:\n$src",
            )
            // The default-expression machinery is imported.
            assertTrue("import org.jetbrains.exposed.sql.CustomFunction" in src, src)
            assertTrue("import org.jetbrains.exposed.sql.UUIDColumnType" in src, src)
            // Non-key uuid stays a plain uuid column (no default), and required → not nullable.
            assertTrue("val ownerId = uuid(\"owner_id\")\n" in src,
                "expected plain non-null uuid ownerId column; saw:\n$src")
            assertTrue("override val primaryKey = PrimaryKey(id)" in src, src)
            // gen_random_uuid() is NOT .autoIncrement() — they are distinct generation arms.
            assertTrue(".autoIncrement()" !in src, "uuid PK must not autoIncrement; saw:\n$src")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }
}

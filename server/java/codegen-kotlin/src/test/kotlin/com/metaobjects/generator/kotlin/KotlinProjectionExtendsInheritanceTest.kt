package com.metaobjects.generator.kotlin

import com.metaobjects.metadata.ktx.loadString
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Regression guard for projection `extends:` PHYSICAL-TYPE inheritance in the Kotlin
 * Exposed-table codegen. An `object.projection` field that binds to a base-entity field
 * via `extends:` must inherit that base field's *physical* shaping — the same way it
 * already inherits `@maxLength` — for:
 *
 *   - `@dbColumnType=uuid`            → `uuid("col")`            (NOT `varchar(col, 36)`)
 *   - `isArray:true` (string)         → `array<String>(...)`    (NOT `varchar`/`text`)
 *   - a default (instant/TZ-aware) `field.timestamp` → `instantWithTimeZone(...)` (NOT `datetime`)
 *   - a `field.enum` super            → the projection's OWN `<View>Status` enum
 *     (`ProgramViewStatus`, self-contained, values inherited via `extends`), NOT a
 *     root-package `Status` (the cross-entity-collision bug).
 *
 * Root causes (both in this module's generator, NOT the metadata model):
 *   1. `KotlinTypeMapper.dbColumnType()` read the attribute OWN-ONLY while `stringMaxLength()`
 *      read it INHERITED — so an `extends`-bound projection field inherited `@maxLength`
 *      but silently dropped `@dbColumnType`, falling back to varchar/datetime.
 *   2. `KotlinTypeMapper.enumTypeName()` collapsed ANY `extends`-bound enum onto the super's
 *      short name (`status` → root `Status`). Only a package-level ABSTRACT enum super should
 *      collapse; a CONCRETE entity super must fall through to per-projection naming so the
 *      projection gets its own `<View>Status` (in its own package), avoiding a cross-package
 *      reference AND the root-`Status` collision.
 *
 * The shared-abstract-enum (FR-019 `Priority`) path is intentionally left untouched: an
 * abstract package-level enum has NO declaring object, so it keeps its package-qualified
 * shared naming — see [KotlinFr019SharedProvidedConformanceTest].
 */
class KotlinProjectionExtendsInheritanceTest {

    // Program (writable base) carries uuid / isArray-string / instant-timestamp / enum fields.
    // ProgramView projects them via `extends:` with NO own physical shaping — every
    // physical type below MUST be inherited from the base field.
    private val fixture = """{
      "metadata.root": { "package": "acme::commerce", "children": [
        { "object.entity": { "name": "Program", "children": [
            { "field.string":    { "name": "id",          "@required": true, "@dbColumnType": "uuid" } },
            { "field.string":    { "name": "ownerId",     "@dbColumnType": "uuid" } },
            { "field.enum":      { "name": "status",      "@required": true,
                "@values": ["DRAFT", "LIVE", "ARCHIVED"] } },
            { "field.string":    { "name": "tags",        "isArray": true } },
            { "field.timestamp": { "name": "publishedAt" } },
            { "source.rdb":      { "@table": "programs" } },
            { "identity.primary": { "name": "id", "@fields": "id" } }
        ] } },
        { "object.projection": { "name": "ProgramView", "children": [
            { "source.rdb":      { "@kind": "view", "@view": "v_program" } },
            { "field.string":    { "name": "id",          "extends": "acme::commerce::Program.id", "@required": true } },
            { "field.string":    { "name": "ownerId",     "extends": "acme::commerce::Program.ownerId" } },
            { "field.enum":      { "name": "status",      "extends": "acme::commerce::Program.status", "@required": true } },
            { "field.string":    { "name": "tags",        "extends": "acme::commerce::Program.tags" } },
            { "field.timestamp": { "name": "publishedAt", "extends": "acme::commerce::Program.publishedAt" } },
            { "identity.primary": { "name": "id", "extends": "acme::commerce::Program.id" } }
        ] } }
      ] }
    }""".trimIndent()

    @Test fun `projection extends inherits dbColumnType and base-entity enum`() {
        val outDir = Files.createTempDirectory("kproj-extends-")
        try {
            val loader = loadString("projection-extends", fixture)
            for (gen in listOf(KotlinEntityGenerator(), KotlinExposedTableGenerator())) {
                gen.setArgs(mapOf("outputDir" to outDir.toString()))
                gen.execute(loader)
            }

            val tableKt = outDir.resolve("acme/commerce/ProgramViewTable.kt")
            assertTrue(Files.exists(tableKt),
                "expected projection Exposed table $tableKt; files=${Files.walk(outDir).toList()}")
            val table = Files.readString(tableKt)

            // --- @dbColumnType=uuid inherited via extends ---
            assertTrue("val id = uuid(\"id\")" in table,
                "uuid PK must inherit @dbColumnType=uuid (uuid(\"id\")); saw:\n$table")
            assertTrue("val ownerId = uuid(\"owner_id\")" in table,
                "ownerId must inherit @dbColumnType=uuid; saw:\n$table")
            assertFalse("varchar(\"id\"" in table || "varchar(\"owner_id\"" in table,
                "uuid columns must NOT fall back to varchar; saw:\n$table")

            // --- @dbColumnType=text_array inherited ---
            assertTrue("val tags = array<String>(\"tags\"" in table,
                "tags must inherit @dbColumnType=text_array (array<String>); saw:\n$table")

            // --- default (instant/TZ-aware) timestamp inherited ---
            assertTrue("val publishedAt = instantWithTimeZone(\"published_at\")" in table,
                "publishedAt must inherit the instant/TZ-aware timestamp (instantWithTimeZone); saw:\n$table")

            // --- enum gets the projection's OWN self-contained type, not root Status ---
            assertTrue("enumerationByName(\"status\", " in table && "ProgramViewStatus::class" in table,
                "status must reference the projection's own ProgramViewStatus enum; saw:\n$table")
            assertFalse(", Status::class)" in table,
                "status must NOT collapse to a root-package `Status` enum; saw:\n$table")

            // The projection's own enum class is materialized in the projection's package,
            // populated with the values INHERITED via `extends` (no stray root `Status.kt`).
            val viewEnumKt = outDir.resolve("acme/commerce/ProgramViewStatus.kt")
            assertTrue(Files.exists(viewEnumKt),
                "projection enum ProgramViewStatus.kt must be materialized (values inherited via extends)")
            val viewEnumSrc = Files.readString(viewEnumKt)
            for (m in listOf("DRAFT", "LIVE", "ARCHIVED"))
                assertTrue(m in viewEnumSrc,
                    "inherited enum member $m must be present in ProgramViewStatus; saw:\n$viewEnumSrc")
            assertFalse(Files.exists(outDir.resolve("Status.kt")),
                "no root-package Status.kt may be emitted for the extends-bound projection enum")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }
}

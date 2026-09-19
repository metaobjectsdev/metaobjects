package com.metaobjects.generator.kotlin

import com.metaobjects.loader.MetaDataLoader
import com.metaobjects.metadata.ktx.loadString
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * FW-8 follow-up — a TPH subtype may legally SHADOW a base-declared (or sibling-subtype-
 * declared) M:N relationship NAME with a DIFFERENT `@objectRef` target. Own children shadow
 * super on `(type, name)` (ADR-0039's resolving-accessor contract), so this is accepted by the
 * loader; before this fix [KotlinRelationsGenerator.tphAugmentedM2mNavs] deduped the TPH-wide
 * M:N nav set by relation NAME ALONE, first-seen wins — so the shadowing subtype's OWN nav was
 * silently DROPPED, and the shared `<relationName>Query` Exposed helper in `<Base>Relations.kt`
 * was built from whichever OTHER (first-seen) nav's target/junction won the name.
 *
 * [KotlinSpringControllerGenerator], however, independently re-resolves the correct
 * subtype-specific nav (`subtypeM2mNavs(st)`) for the CONTROLLER's return type and row-mapping —
 * so pre-fix the generated code COMPILES (every reference is a statically valid `Column<T>`,
 * regardless of which query actually produced the `ResultRow`) but the per-subtype endpoint
 * calls the WRONG-target shared helper: `AuthTable.tagsQuery(id)` returns rows joined against
 * `Tag`/`AuthTag`, then the Copay-scoped endpoint tries to read `SpecialTagTable.*` columns off
 * those rows — a `ResultRow` access that is well-typed but throws at RUNTIME (the column was
 * never selected), or silently maps unrelated data.
 *
 * Model: `Auth` (base, `@discriminator: type`) declares a hetero M:N `tags -> Tag` through
 * `AuthTag` (resolved unchanged by `BridgeAuth`). `CopayAuth` SHADOWS `tags`, redeclaring it as
 * `tags -> SpecialTag` through `CopaySpecialTag` — same relation NAME, genuinely different
 * target + junction.
 */
class KotlinTphM2mShadowedCodegenTest {

    private val fixture = """{
      "metadata.root": { "package": "acme::auth", "children": [
        { "object.entity": { "name": "Auth", "@discriminator": "type", "children": [
            { "source.rdb":   { "@table": "auths" } },
            { "field.long":   { "name": "id" } },
            { "field.enum":   { "name": "type", "@values": ["Bridge", "Copay"] } },
            { "field.string": { "name": "reference", "@required": true, "@maxLength": 80 } },
            { "relationship.association": { "name": "tags", "@cardinality": "many",
                "@objectRef": "Tag", "@through": "AuthTag" } },
            { "identity.primary": { "@fields": "id", "@generation": "increment" } }
        ] } },
        { "object.entity": { "name": "BridgeAuth", "extends": "Auth", "@discriminatorValue": "Bridge", "children": [
            { "field.int": { "name": "quantity", "@required": true } }
        ] } },
        { "object.entity": { "name": "CopayAuth", "extends": "Auth", "@discriminatorValue": "Copay", "children": [
            { "field.decimal": { "name": "copayAmount", "@precision": 10, "@scale": 2 } },
            { "relationship.association": { "name": "tags", "@cardinality": "many",
                "@objectRef": "SpecialTag", "@through": "CopaySpecialTag" } }
        ] } },
        { "object.entity": { "name": "Tag", "children": [
            { "source.rdb":   { "@table": "tags" } },
            { "field.long":   { "name": "id" } },
            { "field.string": { "name": "name", "@required": true, "@maxLength": 80 } },
            { "identity.primary": { "@fields": "id", "@generation": "increment" } }
        ] } },
        { "object.entity": { "name": "SpecialTag", "children": [
            { "source.rdb":   { "@table": "special_tags" } },
            { "field.long":   { "name": "id" } },
            { "field.string": { "name": "name", "@required": true, "@maxLength": 80 } },
            { "identity.primary": { "@fields": "id", "@generation": "increment" } }
        ] } },
        { "object.entity": { "name": "AuthTag", "children": [
            { "source.rdb":         { "@table": "auth_tags" } },
            { "field.long":         { "name": "authId", "@required": true } },
            { "field.long":         { "name": "tagId",  "@required": true } },
            { "identity.primary":   { "@fields": ["authId", "tagId"] } },
            { "identity.reference": { "name": "fkAuth", "@fields": "authId", "@references": "Auth" } },
            { "identity.reference": { "name": "fkTag",  "@fields": "tagId",  "@references": "Tag" } }
        ] } },
        { "object.entity": { "name": "CopaySpecialTag", "children": [
            { "source.rdb":         { "@table": "copay_special_tags" } },
            { "field.long":         { "name": "copayAuthId",  "@required": true } },
            { "field.long":         { "name": "specialTagId", "@required": true } },
            { "identity.primary":   { "@fields": ["copayAuthId", "specialTagId"] } },
            { "identity.reference": { "name": "fkCopay",      "@fields": "copayAuthId",  "@references": "CopayAuth" } },
            { "identity.reference": { "name": "fkSpecialTag", "@fields": "specialTagId", "@references": "SpecialTag" } }
        ] } }
      ] }
    }""".trimIndent()

    private fun loader(): MetaDataLoader = loadString("tph-m2m-shadow", fixture)

    private fun generate(run: (String, MetaDataLoader) -> Unit, relPath: String): String {
        val outDir = Files.createTempDirectory("ktph-m2m-shadow-")
        return try {
            run(outDir.toString(), loader())
            val f = outDir.resolve(relPath)
            assertTrue(Files.exists(f), "expected generated file $f; files=${Files.walk(outDir).toList()}")
            Files.readString(f)
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    private fun controller(): String = generate(
        { outDir, ld -> KotlinSpringControllerGenerator().apply { setArgs(mapOf("outputDir" to outDir)) }.execute(ld) },
        "acme/auth/AuthController.kt",
    )

    private fun relations(): String = generate(
        { outDir, ld -> KotlinRelationsGenerator().apply { setArgs(mapOf("outputDir" to outDir)) }.execute(ld) },
        "acme/auth/AuthRelations.kt",
    )

    // --- relations: the shadowed name gets TWO distinct query helpers, not one -----------

    @Test fun baseShapeKeepsThePlainHelperName() {
        val src = relations()
        assertTrue("fun AuthTable.tagsQuery(sourceId: Long): Query" in src,
            "expected the base's own tags->Tag shape to keep the plain tagsQuery helper; saw:\n$src")
        val tagsFn = src.substringAfter("fun AuthTable.tagsQuery").substringBefore("\n\n")
        assertTrue("TagTable" in tagsFn, "expected tagsQuery to join TagTable; saw:\n$tagsFn")
        assertFalse("SpecialTagTable" in tagsFn, "tagsQuery must not reference SpecialTagTable; saw:\n$tagsFn")
    }

    @Test fun shadowingSubtypeShapeGetsItsOwnDistinctHelper() {
        val src = relations()
        // The shadowing CopayAuth->SpecialTag shape must NOT collapse into tagsQuery — it needs
        // its own helper, joining SpecialTagTable/CopaySpecialTagTable, not TagTable/AuthTagTable.
        assertFalse(
            src.contains(Regex("""fun AuthTable\.tagsQuery\([^)]*\): Query =\s*\n\s*SpecialTagTable""")),
            "the shared tagsQuery helper must not join SpecialTagTable; saw:\n$src",
        )
        // A second, distinctly-named helper must exist for the shadowed shape.
        val distinctHelpers = Regex("""fun AuthTable\.(tags\w*)Query\(""").findAll(src)
            .map { it.groupValues[1] }
            .toSet()
        assertTrue(distinctHelpers.size >= 2,
            "expected at least 2 distinct tags*Query helpers (base shape + shadow shape); found $distinctHelpers in:\n$src")
        val shadowName = distinctHelpers.first { it != "tags" }
        val shadowFn = src.substringAfter("fun AuthTable.${shadowName}Query").substringBefore("\n\n")
        assertTrue("SpecialTagTable" in shadowFn, "expected the shadow helper to join SpecialTagTable; saw:\n$shadowFn")
        assertTrue("CopaySpecialTagTable" in shadowFn, "expected the shadow helper to join CopaySpecialTagTable; saw:\n$shadowFn")
        assertFalse(
            "AuthTagTable" in shadowFn,
            "the shadow helper must not join the BASE shape's junction (AuthTagTable); saw:\n$shadowFn",
        )
    }

    // --- controller: the Copay-scoped mount must call ITS OWN helper, not the base's -----

    @Test fun copayScopedMountReturnsSpecialTagAndCallsItsOwnHelper() {
        val src = controller()
        assertTrue("@GetMapping(\"/copay/{id}/tags\")" in src, "expected /copay/{id}/tags; saw:\n$src")
        assertTrue("fun tagsCopay(@PathVariable id: Long): ResponseEntity<List<SpecialTag>>" in src,
            "expected tagsCopay() to return List<SpecialTag> (already correct pre-fix); saw:\n$src")

        val tagsCopayBody = src.substringAfter("fun tagsCopay(").substringBefore("\n    }\n")

        // THE regression this fix targets: tagsCopay() must NOT delegate to the base/Bridge
        // shape's AuthTable.tagsQuery(id) helper — that helper joins Tag/AuthTag, not
        // SpecialTag/CopaySpecialTag, so reading SpecialTagTable columns off its rows throws
        // at runtime (a well-typed but empty-record-set ResultRow access).
        assertFalse("AuthTable.tagsQuery(id)" in tagsCopayBody,
            "tagsCopay() must not call the base-shape tagsQuery helper (wrong target/junction); saw:\n$tagsCopayBody")
        assertTrue(Regex("""AuthTable\.tags\w+Query\(id\)""").containsMatchIn(tagsCopayBody),
            "expected tagsCopay() to call its OWN disambiguated helper; saw:\n$tagsCopayBody")

        // And the row-mapping columns (already correct pre-fix) must be SpecialTagTable's.
        assertTrue("row[SpecialTagTable." in tagsCopayBody, "expected row mapping off SpecialTagTable; saw:\n$tagsCopayBody")
    }

    @Test fun bridgeScopedMountIsUnaffectedByTheShadow() {
        val src = controller()
        assertTrue("@GetMapping(\"/bridge/{id}/tags\")" in src, "expected /bridge/{id}/tags; saw:\n$src")
        assertTrue("fun tagsBridge(@PathVariable id: Long): ResponseEntity<List<Tag>>" in src,
            "expected tagsBridge() to still return List<Tag> (inherits the base shape unchanged); saw:\n$src")
        val tagsBridgeBody = src.substringAfter("fun tagsBridge(").substringBefore("\n    }\n")
        assertTrue("AuthTable.tagsQuery(id)" in tagsBridgeBody,
            "expected tagsBridge() to keep reusing the shared base-shape helper; saw:\n$tagsBridgeBody")
    }

    @Test fun baseUnscopedMountIsUnaffectedByTheShadow() {
        val src = controller()
        assertTrue("@GetMapping(\"/{id}/tags\")" in src, "expected base-level /{id}/tags; saw:\n$src")
        assertTrue("fun tags(@PathVariable id: Long): ResponseEntity<List<Tag>>" in src,
            "expected unscoped tags() handler returning List<Tag>; saw:\n$src")
        assertTrue("AuthTable.tagsQuery(id)" in src.substringAfter("fun tags(").substringBefore("fun tagsBridge"),
            "expected the base mount to keep calling AuthTable.tagsQuery(id); saw:\n$src")
    }
}

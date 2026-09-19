package com.metaobjects.integration.kotlin.api.tph

import com.metaobjects.generator.kotlin.KotlinEntityGenerator
import com.metaobjects.generator.kotlin.KotlinExposedTableGenerator
import com.metaobjects.generator.kotlin.KotlinFilterAllowlistGenerator
import com.metaobjects.generator.kotlin.KotlinRelationsGenerator
import com.metaobjects.generator.kotlin.KotlinSpringControllerGenerator
import com.metaobjects.generator.kotlin.KotlinValidatorGenerator
import com.metaobjects.metadata.ktx.loadString
import com.tschuchort.compiletesting.KotlinCompilation
import com.tschuchort.compiletesting.SourceFile
import java.nio.file.Files
import kotlin.io.path.isRegularFile
import kotlin.io.path.readText
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * FW-8 follow-up — compile-gate for the full codegen-kotlin generator suite over a discriminator
 * hierarchy where a concrete TPH subtype SHADOWS a base-declared M:N relationship NAME with a
 * genuinely DIFFERENT target/junction. Own children shadow super on `(type, name)` (ADR-0039's
 * resolving-accessor contract), so this is legal metadata the loader accepts cleanly — sibling of
 * [TphM2mFullSuiteCompilesTest], which covers the (unshadowed) base-declared + subtype-own case.
 *
 * Before this fix, [com.metaobjects.generator.kotlin.KotlinRelationsGenerator]'s TPH-wide M:N nav
 * union deduped by relation NAME alone (first-seen wins), so `CopayAuth`'s shadowing `tags ->
 * SpecialTag` nav was silently DROPPED and `AuthRelations.kt` emitted only ONE `tagsQuery` helper
 * — built from `Auth`'s own `tags -> Tag` shape. [com.metaobjects.generator.kotlin.KotlinSpringControllerGenerator],
 * however, independently RE-RESOLVES each subtype's own nav for its return type + row mapping, so
 * the generated `tagsCopay()` endpoint declared `ResponseEntity<List<SpecialTag>>` and mapped
 * `row[SpecialTagTable.*]` — off rows the WRONG-target `AuthTable.tagsQuery(id)` helper produced
 * (a `Tag`/`AuthTag` join). This is the "compiles, wrong at runtime" shape: every reference here
 * is a statically valid `Column<T>`, so the pre-fix code compiles cleanly and only throws when the
 * mismatched `ResultRow` is actually read. This test therefore does not rely on compilation alone
 * — it asserts the WIRING (which helper each mount calls, and what each helper joins) on the real
 * generated + compiled source, on top of the compile gate.
 */
@OptIn(org.jetbrains.kotlin.compiler.plugin.ExperimentalCompilerApi::class)
class TphM2mShadowedFullSuiteCompilesTest {

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

    @Test
    fun `FW-8 TPH subtype shadowing a base M2M relation name gets its own compiled helper`() {
        val outDir = Files.createTempDirectory("tph-m2m-shadow-suite-")
        try {
            val loader = loadString("tph-m2m-shadow-suite", fixture)
            for (gen in listOf(
                KotlinEntityGenerator(),
                KotlinExposedTableGenerator(),
                KotlinSpringControllerGenerator(),
                KotlinFilterAllowlistGenerator(),
                KotlinRelationsGenerator(),
                KotlinValidatorGenerator(),
            )) {
                val args = mutableMapOf("outputDir" to outDir.toString())
                if (gen is KotlinValidatorGenerator) args["packageName"] = "acme.auth.validation"
                gen.setArgs(args)
                gen.execute(loader)
            }

            val emitted = Files.walk(outDir).filter { it.isRegularFile() }.sorted().toList()
            val names = emitted.map { it.fileName.toString() }.toSet()
            for (dead in listOf("BridgeAuthTable.kt", "CopayAuthTable.kt", "BridgeAuthRelations.kt", "CopayAuthRelations.kt")) {
                assertFalse(dead in names, "TPH subtype must not emit $dead; got $names")
            }

            assertTrue("AuthRelations.kt" in names, "expected AuthRelations.kt; got $names")
            val relations = emitted.first { it.fileName.toString() == "AuthRelations.kt" }.readText()

            // The base shape keeps the plain helper, joining Tag/AuthTag — NOT SpecialTag.
            assertTrue("fun AuthTable.tagsQuery(" in relations, relations)
            val tagsQueryBody = relations.substringAfter("fun AuthTable.tagsQuery").substringBefore("\n\n")
            assertTrue("TagTable" in tagsQueryBody, tagsQueryBody)
            assertFalse("SpecialTagTable" in tagsQueryBody, tagsQueryBody)

            // The shadowing CopayAuth shape must have gotten its OWN, distinctly-named helper
            // (not collapsed into tagsQuery), joining SpecialTag/CopaySpecialTag.
            val helperNames = Regex("""fun AuthTable\.(tags\w*)Query\(""").findAll(relations)
                .map { it.groupValues[1] }.toSet()
            assertTrue(helperNames.size >= 2, "expected >=2 distinct tags*Query helpers; found $helperNames in:\n$relations")
            val shadowHelper = helperNames.first { it != "tags" }
            val shadowBody = relations.substringAfter("fun AuthTable.${shadowHelper}Query").substringBefore("\n\n")
            assertTrue("SpecialTagTable" in shadowBody, shadowBody)
            assertTrue("CopaySpecialTagTable" in shadowBody, shadowBody)
            assertFalse("AuthTagTable" in shadowBody, shadowBody)

            val controller = emitted.first { it.fileName.toString() == "AuthController.kt" }.readText()
            assertTrue("@GetMapping(\"/copay/{id}/tags\")" in controller, controller)
            val tagsCopayBody = controller.substringAfter("fun tagsCopay(").substringBefore("\n    }\n")
            assertFalse("AuthTable.tagsQuery(id)" in tagsCopayBody,
                "tagsCopay() must not delegate to the base-shape helper (wrong target); saw:\n$tagsCopayBody")
            assertTrue("AuthTable.${shadowHelper}Query(id)" in tagsCopayBody,
                "expected tagsCopay() to call its own $shadowHelper Query helper; saw:\n$tagsCopayBody")
            assertTrue("row[SpecialTagTable." in tagsCopayBody, tagsCopayBody)

            // The unaffected mounts still delegate to the plain shared helper.
            val tagsBridgeBody = controller.substringAfter("fun tagsBridge(").substringBefore("\n    }\n")
            assertTrue("AuthTable.tagsQuery(id)" in tagsBridgeBody, tagsBridgeBody)

            val sources = emitted.map { path ->
                SourceFile.kotlin(outDir.relativize(path).toString().replace('/', '_'), path.readText())
            }
            val result = KotlinCompilation().apply {
                this.sources = sources
                inheritClassPath = true
                messageOutputStream = System.out
            }.compile()

            assertEquals(KotlinCompilation.ExitCode.OK, result.exitCode,
                "TPH M:N shadow full generator suite failed to compile:\n${result.messages}")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }
}

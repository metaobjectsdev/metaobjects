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
 * FW-8 x FR-017 x FW-3 — compile-gate for the full codegen-kotlin generator suite over a
 * discriminator hierarchy that ALSO owns M:N relationships, one of them a self-join whose
 * TARGET is a TPH subtype. Sibling of [TphFullSuiteCompilesTest], which covers a to-many
 * COMPOSITION; this covers `relationship.association @cardinality:"many" @through` instead.
 *
 * Before the FW-8/FW-3 fix this would not merely have emitted an absent route (an absence
 * compiles fine) — `linkedAuths` targets `BridgeAuth` itself, a TPH subtype with NO Exposed
 * `Table` object and NO data class of its own (only its validation-only `BridgeAuthValidation`
 * exists), so the pre-fix `KotlinM2mSupport.resolve` bound the join to a nonexistent
 * `BridgeAuthTable` and the controller returned a nonexistent `List<BridgeAuth>` — a real
 * `unresolved reference` compile failure the moment this scenario was exercised. codegen-kotlin's
 * own module has no Exposed/Spring on its test classpath (see
 * [com.metaobjects.generator.kotlin.KotlinTphM2mCodegenTest] for the string-assertion coverage);
 * this module has both, so it is where the FULL emitted set can actually be compiled.
 */
@OptIn(org.jetbrains.kotlin.compiler.plugin.ExperimentalCompilerApi::class)
class TphM2mFullSuiteCompilesTest {

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
            { "field.int": { "name": "quantity", "@required": true } },
            { "relationship.association": { "name": "linkedAuths", "@cardinality": "many",
                "@objectRef": "BridgeAuth", "@through": "AuthLink", "@sourceRefField": "fromAuthId" } }
        ] } },
        { "object.entity": { "name": "CopayAuth", "extends": "Auth", "@discriminatorValue": "Copay", "children": [
            { "field.decimal": { "name": "copayAmount", "@precision": 10, "@scale": 2 } }
        ] } },
        { "object.entity": { "name": "Tag", "children": [
            { "source.rdb":   { "@table": "tags" } },
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
        { "object.entity": { "name": "AuthLink", "children": [
            { "source.rdb":         { "@table": "auth_links" } },
            { "field.long":         { "name": "fromAuthId", "@required": true } },
            { "field.long":         { "name": "toAuthId",   "@required": true } },
            { "identity.primary":   { "@fields": ["fromAuthId", "toAuthId"] } },
            { "identity.reference": { "name": "fkFrom", "@fields": "fromAuthId", "@references": "BridgeAuth" } },
            { "identity.reference": { "name": "fkTo",   "@fields": "toAuthId",   "@references": "BridgeAuth" } }
        ] } }
      ] }
    }""".trimIndent()

    @Test
    fun `FR-017 x FW-8 full TPH generator suite with a self-join M2M onto a subtype compiles`() {
        val outDir = Files.createTempDirectory("tph-m2m-suite-")
        try {
            val loader = loadString("tph-m2m-suite", fixture)
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
            // The subtypes fold into the base — no per-subtype persistence artifact of any kind,
            // M:N included (the whole point: linkedAuths must NOT try to reference BridgeAuthTable).
            for (dead in listOf("BridgeAuthTable.kt", "CopayAuthTable.kt", "BridgeAuthRelations.kt", "CopayAuthRelations.kt")) {
                assertFalse(dead in names, "TPH subtype must not emit $dead; got $names")
            }

            // The M:N traversal artifacts a route-absence bug would never even produce.
            assertTrue("AuthRelations.kt" in names, "expected AuthRelations.kt (tags + linkedAuths queries); got $names")
            val relations = emitted.first { it.fileName.toString() == "AuthRelations.kt" }.readText()
            assertTrue("fun AuthTable.tagsQuery(" in relations, relations)
            assertTrue("fun AuthTable.linkedAuthsQuery(" in relations, relations)
            // FW-3: the self-join's target (BridgeAuth) has no table of its own — bound to AuthTable.
            assertFalse("BridgeAuthTable" in relations, relations)
            assertTrue("AuthTable.type eq AuthType.Bridge" in relations, relations)

            val controller = emitted.first { it.fileName.toString() == "AuthController.kt" }.readText()
            assertTrue("@GetMapping(\"/{id}/tags\")" in controller, controller)
            assertTrue("@GetMapping(\"/bridge/{id}/tags\")" in controller, controller)
            assertTrue("@GetMapping(\"/copay/{id}/tags\")" in controller, controller)
            assertTrue("@GetMapping(\"/bridge/{id}/linkedAuths\")" in controller, controller)
            assertFalse("/copay/{id}/linkedAuths" in controller, controller)

            val sources = emitted.map { path ->
                SourceFile.kotlin(outDir.relativize(path).toString().replace('/', '_'), path.readText())
            }
            val result = KotlinCompilation().apply {
                this.sources = sources
                inheritClassPath = true
                messageOutputStream = System.out
            }.compile()

            assertEquals(KotlinCompilation.ExitCode.OK, result.exitCode,
                "TPH x M:N full generator suite failed to compile:\n${result.messages}")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }
}

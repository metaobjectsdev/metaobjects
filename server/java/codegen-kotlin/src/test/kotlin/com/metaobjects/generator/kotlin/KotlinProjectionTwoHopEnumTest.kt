package com.metaobjects.generator.kotlin

import com.metaobjects.metadata.ktx.loadString
import com.tschuchort.compiletesting.KotlinCompilation
import com.tschuchort.compiletesting.SourceFile
import java.nio.file.Files
import java.nio.file.Path
import kotlin.io.path.isRegularFile
import kotlin.io.path.readText
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * #259 / FR-019 — a `field.enum` that inherits its `@values` through TWO `extends` hops
 * (projection.status → entity.status → shared-abstract enum) resolves to the shared
 * declaration, the SAME cross-generator authority every other hop count resolves through
 * ([EnumField.resolveSharedEnumDeclaration], metadata module).
 *
 * This SUPERSEDES the original #259 remedy, which gave the projection its OWN per-projection
 * `ProgramViewStatus` enum so the two-hop case would not silently emit nothing. That worked
 * around the real defect instead of fixing it: a projection reaching a shared declaration is
 * exactly like an entity reaching one, and must reference the SAME materialized type — not a
 * second, differently-populated copy. The one-hop case ([KotlinProjectionExtendsInheritanceTest])
 * already demonstrated this is unproblematic when the chain is shallow; the two-hop case must
 * behave identically, just with one more hop walked.
 */
@OptIn(org.jetbrains.kotlin.compiler.plugin.ExperimentalCompilerApi::class)
class KotlinProjectionTwoHopEnumTest {

    // SharedStatus (abstract, root) ← Program.status (entity, hop 1) ← ProgramView.status
    // (projection, hop 2). ProgramView.status carries NO own @values — they resolve two hops up.
    private val fixture = """{
      "metadata.root": { "package": "acme::commerce", "children": [
        { "field.enum": { "name": "SharedStatus", "abstract": true, "@required": true,
            "@values": ["DRAFT", "LIVE", "ARCHIVED"] } },
        { "object.entity": { "name": "Program", "children": [
            { "field.string":    { "name": "id",     "@required": true, "@dbColumnType": "uuid" } },
            { "field.enum":      { "name": "status",  "extends": "acme::commerce::SharedStatus", "@required": true } },
            { "source.rdb":      { "@table": "programs" } },
            { "identity.primary": { "name": "id", "@fields": "id" } }
        ] } },
        { "object.projection": { "name": "ProgramView", "children": [
            { "source.rdb":      { "@kind": "view", "@view": "v_program" } },
            { "field.string":    { "name": "id",     "extends": "acme::commerce::Program.id", "@required": true } },
            { "field.enum":      { "name": "status", "extends": "acme::commerce::Program.status", "@required": true } },
            { "identity.primary": { "name": "id", "extends": "acme::commerce::Program.id" } }
        ] } }
      ] }
    }""".trimIndent()

    // The reduced model for the "projection-only" must-generate check: NO entity at all — the
    // projection's field.enum extends the shared declaration directly (one hop), so the shared
    // type's ONLY possible generated consumer in the whole loaded model is the projection.
    private val projectionOnlyFixture = """{
      "metadata.root": { "package": "acme::commerce", "children": [
        { "field.enum": { "name": "SharedStatus", "abstract": true, "@required": true,
            "@values": ["DRAFT", "LIVE", "ARCHIVED"] } },
        { "object.projection": { "name": "ProgramView", "children": [
            { "source.rdb":      { "@kind": "view", "@view": "v_program" } },
            { "field.enum":      { "name": "status", "extends": "acme::commerce::SharedStatus", "@required": true } }
        ] } }
      ] }
    }""".trimIndent()

    private fun compile(outDir: Path): KotlinCompilation.Result {
        val sources = Files.walk(outDir).filter { it.isRegularFile() }.sorted().toList()
            .map { path -> SourceFile.kotlin(path.parent.relativize(path).toString().replace('/', '_'), path.readText()) }
        return KotlinCompilation().apply {
            this.sources = sources
            inheritClassPath = true
            messageOutputStream = System.out
        }.compile()
    }

    @Test fun `two-hop projection enum references the shared type, not a per-projection copy`() {
        val outDir = Files.createTempDirectory("k2hop-enum-")
        try {
            val loader = loadString("two-hop-enum", fixture)
            for (gen in listOf(KotlinEntityGenerator(), KotlinExposedTableGenerator())) {
                gen.setArgs(mapOf("outputDir" to outDir.toString()))
                gen.execute(loader)
            }

            // The shared enum is emitted exactly once, carrying every member.
            val sharedEnum = outDir.resolve("acme/commerce/SharedStatus.kt")
            assertTrue(Files.exists(sharedEnum),
                "shared SharedStatus.kt must be emitted; files=${Files.walk(outDir).toList()}")
            val sharedSrc = sharedEnum.readText()
            for (m in listOf("DRAFT", "LIVE", "ARCHIVED"))
                assertTrue(m in sharedSrc, "member $m must be present; saw:\n$sharedSrc")

            // NO per-projection enum is written — the #259 remedy is superseded.
            assertFalse(Files.exists(outDir.resolve("acme/commerce/ProgramViewStatus.kt")),
                "a per-projection ProgramViewStatus.kt must NOT be materialized now that the " +
                    "projection references the shared type; files=${Files.walk(outDir).toList()}")

            // The projection table references the SHARED enum.
            val viewTable = outDir.resolve("acme/commerce/ProgramViewTable.kt").readText()
            assertTrue("SharedStatus::class" in viewTable,
                "projection table must reference the shared SharedStatus enum; saw:\n$viewTable")
            assertFalse("ProgramViewStatus::class" in viewTable,
                "projection table must NOT reference a per-projection enum; saw:\n$viewTable")

            // The ENTITY table still collapses onto the shared enum (byte-identity guardrail).
            val programTable = outDir.resolve("acme/commerce/ProgramTable.kt").readText()
            assertTrue("SharedStatus::class" in programTable,
                "entity table must still reference the shared enum; saw:\n$programTable")

            // Compile-gate: the whole generated tree must resolve.
            val result = compile(outDir)
            assertEquals(KotlinCompilation.ExitCode.OK, result.exitCode, result.messages)
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    @Test fun `shared enum materializes when a projection is the only generated consumer`() {
        val outDir = Files.createTempDirectory("k-proj-only-enum-")
        try {
            val loader = loadString("projection-only-enum", projectionOnlyFixture)
            for (gen in listOf(KotlinEntityGenerator(), KotlinExposedTableGenerator())) {
                gen.setArgs(mapOf("outputDir" to outDir.toString()))
                gen.execute(loader)
            }

            val sharedEnum = outDir.resolve("acme/commerce/SharedStatus.kt")
            assertTrue(Files.exists(sharedEnum),
                "shared SharedStatus.kt must be materialized when a projection is the only " +
                    "consumer; files=${Files.walk(outDir).toList()}")

            val viewTable = outDir.resolve("acme/commerce/ProgramViewTable.kt").readText()
            assertTrue("SharedStatus::class" in viewTable,
                "projection table must reference the shared SharedStatus enum; saw:\n$viewTable")

            val result = compile(outDir)
            assertEquals(KotlinCompilation.ExitCode.OK, result.exitCode, result.messages)
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }
}

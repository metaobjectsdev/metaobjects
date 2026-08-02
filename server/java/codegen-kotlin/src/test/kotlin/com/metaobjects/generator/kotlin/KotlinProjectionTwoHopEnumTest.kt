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
 * #259 — a `field.enum` that inherits its `@values` through TWO `extends` hops
 * (projection.status → entity.status → shared-abstract enum) must still generate the
 * projection's OWN per-projection enum, populated with the transitively-inherited members.
 *
 * Sibling of #246 (same shared-enum feature area). The one-hop case
 * ([KotlinProjectionExtendsInheritanceTest]) already worked because the entity field carried
 * its own inline `@values`. The two-hop case regressed: [KotlinTypeMapper.enumTypeName]
 * decided "collapse onto the shared enum" from the TOP-MOST super (its private
 * `resolveSuperRoot`), so a projection field walked PAST its concrete entity super to the root
 * abstract enum (no declaring object) and wrongly collapsed to the shared type — the
 * per-projection enum was never emitted, and every consumer of that column failed to resolve
 * the (now-absent) per-projection type. Values themselves were never the problem:
 * `getMetaAttr(@values)` is inheritance-aware across multiple hops.
 *
 * The fix keys the collapse decision on the IMMEDIATE super: only a field whose direct
 * `extends` target is a package-level abstract enum (no declaring object) collapses onto the
 * shared type. A field whose direct super is a CONCRETE entity/projection field gets its own
 * `<Object><Field>` enum, populated with the depth-2-inherited members.
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

    private fun compile(outDir: Path): KotlinCompilation.Result {
        val sources = Files.walk(outDir).filter { it.isRegularFile() }.sorted().toList()
            .map { path -> SourceFile.kotlin(path.parent.relativize(path).toString().replace('/', '_'), path.readText()) }
        return KotlinCompilation().apply {
            this.sources = sources
            inheritClassPath = true
            messageOutputStream = System.out
        }.compile()
    }

    @Test fun `two-hop projection enum materializes its own per-projection type`() {
        val outDir = Files.createTempDirectory("k2hop-enum-")
        try {
            val loader = loadString("two-hop-enum", fixture)
            for (gen in listOf(KotlinEntityGenerator(), KotlinExposedTableGenerator())) {
                gen.setArgs(mapOf("outputDir" to outDir.toString()))
                gen.execute(loader)
            }

            // The shared enum is emitted once (the entity field DOES collapse onto it).
            assertTrue(Files.exists(outDir.resolve("acme/commerce/SharedStatus.kt")),
                "shared SharedStatus.kt must be emitted; files=${Files.walk(outDir).toList()}")

            // The projection gets its OWN enum, populated with the DEPTH-2-inherited values.
            val viewEnum = outDir.resolve("acme/commerce/ProgramViewStatus.kt")
            assertTrue(Files.exists(viewEnum),
                "#259: projection enum ProgramViewStatus.kt must be materialized (values inherited " +
                    "through TWO extends hops); files=${Files.walk(outDir).toList()}")
            val viewEnumSrc = viewEnum.readText()
            for (m in listOf("DRAFT", "LIVE", "ARCHIVED"))
                assertTrue(m in viewEnumSrc, "inherited member $m must be present; saw:\n$viewEnumSrc")

            // The projection table references its OWN enum, NOT the collapsed shared one.
            val viewTable = outDir.resolve("acme/commerce/ProgramViewTable.kt").readText()
            assertTrue("ProgramViewStatus::class" in viewTable,
                "projection table must reference its own ProgramViewStatus enum; saw:\n$viewTable")
            assertFalse("SharedStatus::class" in viewTable,
                "#259: projection table must NOT collapse to the shared SharedStatus enum; saw:\n$viewTable")

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
}

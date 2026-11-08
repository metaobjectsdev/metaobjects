package com.metaobjects.generator.kotlin

import com.metaobjects.metadata.ktx.loadString
import com.tschuchort.compiletesting.KotlinCompilation
import com.tschuchort.compiletesting.SourceFile
import java.nio.file.Files
import kotlin.io.path.isRegularFile
import kotlin.io.path.readText
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * R33: the Exposed table carries the index vocabulary Exposed can express: an index's resolved
 * name, `@using` (Exposed's `indexType`) and `@where` (its `filterCondition`, the predicate as
 * written), on an identity.secondary (unique) and an index.lookup. What Exposed cannot express
 * (`@orders`, `@expr`, `@description`) is recorded in docs/CONFORMANCE.md "Split coverage";
 * `meta migrate` creates all of it.
 */
@OptIn(org.jetbrains.kotlin.compiler.plugin.ExperimentalCompilerApi::class)
class KotlinExposedIndexVocabularyTest {

    private val fixture = """{
      "metadata.root": { "package": "acme::support", "children": [
        { "object.entity": { "name": "Ticket", "children": [
            { "source.rdb": { "@table": "tickets" } },
            { "field.long":   { "name": "id" } },
            { "field.string": { "name": "email", "@maxLength": 80 } },
            { "field.string": { "name": "status", "@maxLength": 20 } },
            { "identity.primary": { "@fields": "id", "@generation": "increment" } },
            { "identity.secondary": { "name": "ux_tickets_open_email", "@fields": "email", "@where": "status = 'open'" } },
            { "index.lookup": { "name": "ix_tickets_email_trgm", "@fields": "email", "@using": "gin" } }
        ] } }
      ] }
    }""".trimIndent()

    @Test
    fun `an index carries its method and its predicate, and the table compiles`() {
        val outDir = Files.createTempDirectory("ktbl-index-vocab-")
        try {
            val loader = loadString("index-vocab", fixture)
            for (gen in listOf(KotlinEntityGenerator(), KotlinExposedTableGenerator())) {
                gen.setArgs(mapOf("outputDir" to outDir.toString()))
                gen.execute(loader)
            }
            val src = outDir.resolve("acme/support/TicketTable.kt").readText()
            assertTrue("indexType = \"gin\"" in src, src)
            assertTrue("status = 'open'" in src && "filterCondition" in src, src)
            val result = KotlinCompilation().apply {
                sources = Files.walk(outDir).filter { it.isRegularFile() }.toList()
                    .map { SourceFile.kotlin(outDir.relativize(it).toString().replace('/', '_'), it.readText()) }
                inheritClassPath = true
                messageOutputStream = System.out
            }.compile()
            assertEquals(KotlinCompilation.ExitCode.OK, result.exitCode, result.messages)
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }
}

package com.metaobjects.generator.kotlin

import com.metaobjects.generator.kotlin.apidocs.DocsPaths
import com.metaobjects.generator.kotlin.apidocs.KotlinApiDocsRenderer
import com.metaobjects.generator.kotlin.apidocs.KotlinApiModelBuilder
import com.metaobjects.generator.util.GeneratedFileWriter
import com.metaobjects.MetaData
import com.metaobjects.metadata.ktx.loadDirectory
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import java.util.TreeMap
import kotlin.io.path.isRegularFile
import kotlin.io.path.readText
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * ADR-0063 - the business-rules vocabulary is INERT in the Kotlin generators.
 *
 * `api.operational`, `operation.*`, `binding.rest` and `transition.action` are registered,
 * validated at load and checked in `verify`; nothing generates from them yet. A model that
 * uses them emits exactly what the same model without them emits, byte for byte, through every
 * generator in [GENERATOR_REGISTRY] and every page of the api reference.
 *
 * The model pair is `fixtures/codegen-noop/rules/{with,without}`, shared with the other ports.
 */
class RulesInertTest {

    private fun modelDir(variant: String): Path {
        var cur: Path? = Paths.get("").toAbsolutePath()
        while (cur != null) {
            val candidate = cur.resolve("fixtures/codegen-noop/rules/$variant")
            if (Files.isDirectory(candidate)) return candidate
            cur = cur.parent
        }
        throw IllegalStateException("Could not locate fixtures/codegen-noop/rules from ${Paths.get("").toAbsolutePath()}")
    }

    // One loader name for both variants, so nothing that stamps it into output can differ.
    private fun load(variant: String) = loadDirectory("rules-inert", modelDir(variant))

    /**
     * Run a generator suite into a fresh directory and read back every file it wrote:
     * relative path to contents. A throw is recorded as the single entry `<threw>`, so a
     * generator that cannot run from a bare model must at least fail identically.
     */
    private fun emit(variant: String, suite: List<GeneratorInfo>): Map<String, String> {
        val loader = load(variant)
        val outDir = Files.createTempDirectory("rules-inert-")
        val templateRoot = Files.createTempDirectory("rules-inert-templates-")
        try {
            try {
                GeneratedFileWriter.beginRun().use { run ->
                    for (info in suite) {
                        val gen = info.factory()
                        run.attributeTo(info.name)
                        gen.setArgs(mapOf(
                            "outputDir" to outDir.toString(),
                            // KotlinValidatorGenerator emits a package-level stub and needs one.
                            "packageName" to "acme.shop",
                            "templateRoot" to templateRoot.toString(),
                        ))
                        gen.execute(loader)
                    }
                }
            } catch (e: Exception) {
                return mapOf(THREW to e.message.toString())
            }
            val files = TreeMap<String, String>()
            Files.walk(outDir).use { s ->
                s.filter { it.isRegularFile() }.forEach { files[outDir.relativize(it).toString()] = it.readText() }
            }
            return files
        } finally {
            outDir.toFile().deleteRecursively()
            templateRoot.toFile().deleteRecursively()
        }
    }

    private fun sameOrLeak(label: String, expected: Map<String, String>, actual: Map<String, String>): String? {
        if (expected.keys.toList() != actual.keys.toList()) {
            return "$label: emitted file set ${expected.keys} became ${actual.keys}"
        }
        val differing = expected.keys.filter { expected[it] != actual[it] }
        return if (differing.isEmpty()) null else "$label: $differing differ once rules nodes are declared"
    }

    // shared-model writes no code: it publishes the model's own metadata files, named by its args.
    private val codeGenerators get() = GENERATOR_REGISTRY.values.filter { it.name != "api-docs" && it.name != "shared-model" }

    @Test
    fun `the with-model really carries the vocabulary`() {
        // Else every comparison below is vacuously green.
        val root = load("with").root
        assertEquals(1, root.getChildren(MetaData::class.java, true).count { it.type == "api" })
        val transitions = root.getChildren(MetaData::class.java, true).filter { it.type == "object" }
            .flatMap { o -> o.getChildren(MetaData::class.java, true) }
            .flatMap { f -> f.getChildren(MetaData::class.java, true) }
            .count { it.type == "transition" }
        assertEquals(3, transitions)
        assertFalse(load("without").root.getChildren(MetaData::class.java, true).any { it.type == "api" })
    }

    @Test
    fun `every generator emits the same files`() {
        val leaks = codeGenerators.mapNotNull { info ->
            sameOrLeak(info.name, emit("without", listOf(info)), emit("with", listOf(info)))
        }
        assertTrue(leaks.isEmpty(), leaks.joinToString("\n"))
    }

    @Test
    fun `every runnable generator in one run emits the same files`() {
        val runnable = codeGenerators.filter { THREW !in emit("without", listOf(it)) }
        val expected = emit("without", runnable)
        assertFalse(THREW in expected, "the combined suite threw: ${expected[THREW]}")
        assertTrue(expected.size > 10, "only ${expected.size} files - the suite barely ran")
        val leak = sameOrLeak("combined", expected, emit("with", runnable))
        assertTrue(leak == null, leak)
    }

    /**
     * The api docs surface: every unit page, the index and the agent page. A served report
     * has a generated API to document (its row, table, list route and allowlist); a
     * sourceless one has none.
     */
    private fun apiDocs(variant: String): Map<String, String> {
        val out = Files.createTempDirectory("rules-inert-docs-")
        try {
            val docs = GENERATOR_REGISTRY.getValue("api-docs").factory()
            docs.setArgs(mapOf("outputDir" to out.toString(), "projectName" to "purchasing", "layout" to "package"))
            docs.execute(load(variant))
            val pages = TreeMap<String, String>()
            Files.walk(out).use { s ->
                s.filter { it.isRegularFile() }.forEach {
                    pages[out.resolve("api/kotlin").relativize(it).toString()] = it.readText()
                }
            }
            return pages
        } finally {
            out.toFile().deleteRecursively()
        }
    }

    @Test
    fun `the api reference is identical`() {
        val expected = apiDocs("without")
        assertTrue(expected.size > 3, "only ${expected.size} pages - the docs barely ran")
        val leak = sameOrLeak("api docs", expected, apiDocs("with"))
        assertTrue(leak == null, leak)
    }

    private companion object {
        const val THREW = "<threw>"
    }
}

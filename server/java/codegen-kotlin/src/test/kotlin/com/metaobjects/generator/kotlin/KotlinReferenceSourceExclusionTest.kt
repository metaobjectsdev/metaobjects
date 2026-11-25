package com.metaobjects.generator.kotlin

import com.google.gson.JsonParser
import com.metaobjects.config.SourceResolver
import com.metaobjects.generator.Generator
import com.metaobjects.generator.util.GeneratedFileWriter
import com.metaobjects.loader.FileSource
import com.metaobjects.loader.LoaderOptions
import com.metaobjects.loader.MetaDataLoader
import com.metaobjects.loader.MetaDataSource
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * A node declared only by a REFERENCE source (`{"path": ..., "reference": true}`) loads and resolves
 * but is another run's to generate: no Kotlin generator writes a data class for it (nor for a reference
 * value object it nests), while the output parser of a LOCAL prompt whose `@responseRef` names it still
 * emits. The project is the shared `fixtures/reference-source-conformance` corpus case the other ports load.
 */
class KotlinReferenceSourceExclusionTest {

    private val caseName = "reply-type-in-a-reference-source-resolves-and-is-not-generated"
    private val referenceIdPrefix = "ref:"

    private fun corpus(): Path {
        var dir: Path? = Paths.get("").toAbsolutePath()
        while (dir != null && !Files.isDirectory(dir.resolve("fixtures"))) dir = dir.parent
        return dir!!.resolve("fixtures/reference-source-conformance/cases.json")
    }

    @Test fun `no Kotlin generator emits for a reference node but the parser still names it`() {
        val project = Files.createTempDirectory("kref-project-")
        val outDir = Files.createTempDirectory("kref-out-")
        try {
            val case = JsonParser.parseString(Files.readString(corpus()))
                .asJsonObject.getAsJsonArray("cases")
                .map { it.asJsonObject }.first { it["name"].asString == caseName }
            for ((k, v) in case.getAsJsonObject("tree").entrySet()) {
                val p = project.resolve(k)
                Files.createDirectories(p.parent)
                Files.write(p, v.asString.toByteArray())
            }
            val cfg = project.resolve(".metaobjects/config.json")
            Files.createDirectories(cfg.parent)
            Files.write(cfg, case.getAsJsonObject("config").toString().toByteArray())

            val collection = SourceResolver.resolveCollectionWithDependencies(project)
            val sources = ArrayList<MetaDataSource>()
            val referenceIds = HashSet<String>()
            for (file in collection.ownFiles()) {
                if (collection.referenceFiles().contains(file)) {
                    val id = referenceIdPrefix + project.relativize(file).toString().replace('\\', '/')
                    referenceIds.add(id)
                    sources.add(FileSource(file, id))
                } else {
                    sources.add(FileSource(file))
                }
            }
            val loader = MetaDataLoader(LoaderOptions.create(false, false, true), MetaDataLoader.SUBTYPE_MANUAL, "kref")
            loader.init()
            loader.setReferenceSourceIds(referenceIds)
            loader.load(sources)
            assertEquals(setOf("acme::support::SupportAnswer", "acme::support::AnswerSource"),
                loader.root.referenceNodes)

            val generators: List<Generator> = listOf(
                KotlinEntityGenerator(), KotlinExposedTableGenerator(), KotlinRelationsGenerator(),
                KotlinRepositoryGenerator(), KotlinNamesGenerator(), KotlinFilterAllowlistGenerator(),
                KotlinSpringControllerGenerator(), KotlinReportExportGenerator(),
                KotlinStoredProcGenerator(), KotlinExtractorGenerator(), KotlinOutputParserGenerator(),
            )
            GeneratedFileWriter.beginRun().use { run ->
                for (gen in generators) {
                    run.attributeTo(gen.javaClass.simpleName)
                    gen.setArgs(mapOf("outputDir" to outDir.toString(), "packageName" to "demo")).execute(loader)
                }
            }

            val files = Files.walk(outDir).use { s -> s.filter { Files.isRegularFile(it) }.toList() }
            val names = files.map { outDir.relativize(it).toString() }
            assertTrue(names.any { it.endsWith("SupportRequest.kt") }, "the project's own payload still generates: $names")
            for (n in names) {
                assertFalse(n.endsWith("/SupportAnswer.kt") || n.endsWith("/AnswerSource.kt"),
                    "a file was emitted for a reference node: $n")
            }
            val parser = files.firstOrNull { it.fileName.toString().endsWith("SupportAnswerPromptParser.kt") }
            assertTrue(parser != null, "the local prompt's parser must still emit: $names")
            assertTrue("acme.support.SupportAnswer" in Files.readString(parser!!),
                "the parser names the reference reply type")
        } finally {
            project.toFile().deleteRecursively()
            outDir.toFile().deleteRecursively()
        }
    }
}

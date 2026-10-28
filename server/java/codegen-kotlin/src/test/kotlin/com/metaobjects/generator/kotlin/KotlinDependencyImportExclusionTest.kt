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
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * FR-023 — Kotlin inherits dependency consumption from the Java loader and Maven plugin; what it
 * owns is its generators. An object a metadata dependency owns loads (the project's own nodes
 * extend and reference it) but is another project's to generate, so no Kotlin generator may write a
 * file or a line for it. The project and its snapshot are the shared
 * `fixtures/dependency-conformance` corpus case the other ports load.
 */
class KotlinDependencyImportExclusionTest {

    private val caseName = "a-dependency-adds-its-artifact-to-the-resolved-set"

    private fun corpus(): Path {
        var dir: Path? = Paths.get("").toAbsolutePath()
        while (dir != null && !Files.isDirectory(dir.resolve("fixtures"))) dir = dir.parent
        return dir!!.resolve("fixtures/dependency-conformance")
    }

    private fun write(p: Path, bytes: ByteArray) {
        Files.createDirectories(p.parent)
        Files.write(p, bytes)
    }

    @Test fun `no Kotlin generator emits for an imported node`() {
        val project = Files.createTempDirectory("kdep-project-")
        val outDir = Files.createTempDirectory("kdep-out-")
        try {
            val case = JsonParser.parseString(Files.readString(corpus().resolve("cases.json")))
                .asJsonObject.getAsJsonArray("cases")
                .map { it.asJsonObject }.first { it["name"].asString == caseName }
            for ((k, v) in case.getAsJsonObject("tree").entrySet()) {
                write(project.resolve(k), v.asString.toByteArray())
            }
            for ((k, v) in case.getAsJsonObject("treeFiles").entrySet()) {
                write(project.resolve(k), Files.readAllBytes(corpus().resolve(v.asString)))
            }
            write(project.resolve(".metaobjects/config.json"), case.getAsJsonObject("config").toString().toByteArray())
            write(project.resolve(".metaobjects/deps.lock.json"), case.getAsJsonObject("lock").toString().toByteArray())

            val collection = SourceResolver.resolveCollectionWithDependencies(project)
            val deps = collection.dependencies()
            val sources = ArrayList<MetaDataSource>(deps.sources())
            collection.ownFiles().forEach { sources.add(FileSource(it)) }

            val loader = MetaDataLoader(LoaderOptions.create(false, false, true), MetaDataLoader.SUBTYPE_MANUAL, "kdep")
            loader.init()
            loader.setDependencies(deps)
            loader.load(sources)
            assertTrue(loader.metaObjects.any { it.name == "acme::common::Customer" },
                "the imported model is part of the loaded graph")

            val generators: List<Generator> = listOf(
                KotlinEntityGenerator(), KotlinExposedTableGenerator(), KotlinRelationsGenerator(),
                KotlinRepositoryGenerator(), KotlinNamesGenerator(), KotlinFilterAllowlistGenerator(),
                KotlinSpringControllerGenerator(), KotlinReportExportGenerator(),
                KotlinStoredProcGenerator(), KotlinExtractorGenerator(),
            )
            GeneratedFileWriter.beginRun().use { run ->
                for (gen in generators) {
                    run.attributeTo(gen.javaClass.simpleName)
                    gen.setArgs(mapOf("outputDir" to outDir.toString(), "packageName" to "demo")).execute(loader)
                }
            }

            val files = Files.walk(outDir).use { s -> s.filter { Files.isRegularFile(it) }.toList() }
            assertTrue(files.any { it.fileName.toString().startsWith("Order") },
                "the project's own Order must still generate: $files")
            for (f in files) {
                val rel = outDir.relativize(f).toString()
                assertFalse("acme" in rel || "Customer" in rel || "Address" in rel,
                    "a file was emitted for an imported node: $rel")
                val body = Files.readString(f)
                assertFalse("Customer" in body || "acme::common" in body, "$rel mentions an imported node")
            }
        } finally {
            project.toFile().deleteRecursively()
            outDir.toFile().deleteRecursively()
        }
    }
}

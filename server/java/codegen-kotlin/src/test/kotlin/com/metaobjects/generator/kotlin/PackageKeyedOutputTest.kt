package com.metaobjects.generator.kotlin

import com.metaobjects.generator.GeneratorException
import com.metaobjects.generator.Generator
import com.metaobjects.generator.util.GeneratedFileWriter
import com.metaobjects.generator.util.OutputPackageCollisions
import com.metaobjects.metadata.ktx.loadDirectory
import com.tschuchort.compiletesting.KotlinCompilation
import com.tschuchort.compiletesting.SourceFile
import java.nio.file.Files
import java.nio.file.Path
import kotlin.io.path.isRegularFile
import kotlin.io.path.readText
import kotlin.io.path.writeText
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/**
 * GitHub #546 (Kotlin lane): generated output paths follow the object's METADATA package, so two
 * same-named entities (and two same-named value objects) in two packages generate two files each,
 * every reference resolves to its own package's type, and the whole tree compiles. Two different
 * metadata packages that would land in one directory are refused (ERR_NAME_COLLISION).
 */
@OptIn(org.jetbrains.kotlin.compiler.plugin.ExperimentalCompilerApi::class)
class PackageKeyedOutputTest {

    private fun model(pkg: String) = """
        { "metadata.root": { "package": "$pkg", "children": [
          { "object.value": { "name": "Address", "children": [
            { "field.string": { "name": "street" } },
            { "field.int": { "name": "zip" } } ] } },
          { "object.entity": { "name": "Invoice", "children": [
            { "source.rdb": { "@table": "${pkg.replace("::", "_")}_invoices" } },
            { "field.long": { "name": "id" } },
            { "field.string": { "name": "memo", "@maxLength": 100 } },
            { "field.object": { "name": "billTo", "@objectRef": "$pkg::Address", "@storage": "jsonb" } },
            { "identity.primary": { "@fields": "id", "@generation": "increment" } }
          ] } }
        ] } }
    """.trimIndent()

    private fun load(vararg pkgs: String): Pair<Path, com.metaobjects.loader.MetaDataLoader> {
        val dir = Files.createTempDirectory("pkg-keyed-in-")
        pkgs.forEachIndexed { i, p -> dir.resolve("meta.$i.json").writeText(model(p)) }
        return dir to loadDirectory("pkg-keyed", dir)
    }

    @Test
    fun `same-named entities and value objects in two packages generate two files each and compile`() {
        for (pkgs in listOf(listOf("sales", "billing"), listOf("acme::sales", "acme::billing"))) {
            val (inDir, loader) = load(*pkgs.toTypedArray())
            val outDir = Files.createTempDirectory("pkg-keyed-out-")
            try {
                val gens: List<Pair<String, Generator>> = listOf(
                    "entity" to KotlinEntityGenerator(),
                    "table" to KotlinExposedTableGenerator(),
                    "names" to KotlinNamesGenerator(),
                    "relations" to KotlinRelationsGenerator(),
                    "filter" to KotlinFilterAllowlistGenerator(),
                )
                GeneratedFileWriter.beginRun().use { run ->
                    for ((name, gen) in gens) {
                        run.attributeTo(name)
                        gen.setArgs(mapOf("outputDir" to outDir.toString())).execute(loader)
                    }
                }
                for (p in pkgs) {
                    val d = outDir.resolve(p.replace("::", "/"))
                    for (f in listOf("Invoice.kt", "Address.kt", "InvoiceTable.kt", "InvoiceFilterAllowlist.kt")) {
                        assertTrue(Files.exists(d.resolve(f)), "$p/$f missing; saw ${Files.walk(outDir).toList()}")
                    }
                }
                val sources = Files.walk(outDir).filter { it.isRegularFile() && it.toString().endsWith(".kt") }
                    .toList().map { SourceFile.kotlin(outDir.relativize(it).toString().replace('/', '_'), it.readText()) }
                val result = KotlinCompilation().apply {
                    this.sources = sources
                    inheritClassPath = true
                    messageOutputStream = System.out
                }.compile()
                assertEquals(KotlinCompilation.ExitCode.OK, result.exitCode, "$pkgs does not compile:\n${result.messages}")
            } finally {
                outDir.toFile().deleteRecursively()
                inDir.toFile().deleteRecursively()
            }
        }
    }

    @Test
    fun `two metadata packages sharing one output directory are refused`() {
        val (inDir, loader) = load("Sales", "sales")
        try {
            val e = assertFailsWith<GeneratorException> {
                OutputPackageCollisions.assertDistinct(loader.metaObjects.toList())
            }
            assertTrue("ERR_NAME_COLLISION" in e.message!! && "\"Sales\"" in e.message!! && "\"sales\"" in e.message!!, e.message)
        } finally {
            inDir.toFile().deleteRecursively()
        }
    }
}

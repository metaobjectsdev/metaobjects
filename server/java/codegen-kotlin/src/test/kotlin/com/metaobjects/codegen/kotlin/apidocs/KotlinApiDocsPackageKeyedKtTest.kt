package com.metaobjects.codegen.kotlin.apidocs

import com.metaobjects.generator.GeneratorException
import com.metaobjects.generator.kotlin.apidocs.KotlinApiDocsGenerator
import com.metaobjects.loader.InMemoryStringSource
import com.metaobjects.loader.LoaderOptions
import com.metaobjects.loader.MetaDataLoader
import com.metaobjects.loader.MetaDataSource
import com.metaobjects.registry.ObjectClassRegistry
import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/**
 * The api reference is keyed by package by default: a page sits under its package path, so two
 * same-named nodes in two packages (a layered model's `enterprise::party::Address` beside
 * `core::common::Address`) are two pages, and the index tells them apart by package. Two names in
 * ONE package that differ only in case (`ProductNdc`, `ProductNDC`) are one file on a
 * case-insensitive filesystem, so they are refused by name, in either layout.
 */
class KotlinApiDocsPackageKeyedKtTest {

    private val dirs = mutableListOf<Path>()

    @AfterTest
    fun tearDown() {
        dirs.forEach { it.toFile().deleteRecursively() }
        ObjectClassRegistry.resetGlobal()
    }

    private fun entity(pkg: String, name: String) = """
        { "metadata.root": { "package": "$pkg", "children": [
          { "object.entity": { "name": "$name", "children": [
            { "source.rdb": { "@table": "t_${name.lowercase()}_${pkg.replace("::", "_")}" } },
            { "field.long": { "name": "id" } },
            { "identity.primary": { "@fields": "id", "@generation": "increment" } }
          ] } }
        ] } }
    """.trimIndent()

    private fun pages(args: Map<String, String>, vararg nodes: Pair<String, String>): Map<String, String> {
        val sources: List<MetaDataSource> = nodes.mapIndexed { i, (pkg, name) ->
            InMemoryStringSource(entity(pkg, name), "docs/src$i.json")
        }
        val loader = MetaDataLoader(LoaderOptions.create(false, false, true), MetaDataLoader.SUBTYPE_MANUAL, "package-keyed")
        loader.init()
        loader.load(sources)
        val out = Files.createTempDirectory("kapidocs-pkg-").also { dirs.add(it) }
        val gen = KotlinApiDocsGenerator()
        gen.setArgs(args + ("outputDir" to out.toString()))
        gen.execute(loader)
        return Files.walk(out).use { s ->
            s.filter { Files.isRegularFile(it) }.toList()
                .associate { out.relativize(it).toString().replace('\\', '/') to Files.readString(it) }
        }
    }

    @Test
    fun twoSameNamedNodesInTwoPackagesAreTwoPagesTheIndexTellsApart() {
        val files = pages(emptyMap(), "enterprise::party" to "Address", "core::common" to "Address")
        assertTrue("api/kotlin/enterprise/party/Address.md" in files, files.keys.toString())
        assertTrue("api/kotlin/core/common/Address.md" in files, files.keys.toString())
        val index = files.getValue("api/kotlin/README.md")
        assertTrue(Regex("""\[Address \(core[.:]+common\)]\(\./core/common/Address\.md\)""").containsMatchIn(index), index)
        assertTrue(Regex("""\[Address \(enterprise[.:]+party\)]\(\./enterprise/party/Address\.md\)""").containsMatchIn(index), index)
    }

    @Test
    fun aUniqueShortNameKeepsItsBareLabel() {
        val index = pages(emptyMap(), "acme::shop" to "Cart").getValue("api/kotlin/README.md")
        assertTrue("[Cart](./acme/shop/Cart.md)" in index, index)
    }

    @Test
    fun namesThatDifferOnlyInCaseInOnePackageAreRefused() {
        for (layout in listOf("package", "flat")) {
            val ex = assertFailsWith<GeneratorException> {
                pages(mapOf("layout" to layout), "acme::products" to "ProductNdc", "acme::products" to "ProductNDC")
            }
            val message = ex.message ?: ""
            assertTrue("ProductNdc" in message && "ProductNDC" in message, message)
            assertTrue("case-insensitive" in message, message)
        }
    }

    @Test
    fun anExplicitFlatLayoutIsStillHonoured() {
        val files = pages(mapOf("layout" to "flat"), "acme::shop" to "Cart")
        assertEquals(listOf("api/kotlin/AGENT-API.md", "api/kotlin/Cart.md", "api/kotlin/README.md"), files.keys.sorted())
    }
}

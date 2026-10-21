package com.metaobjects.integration.kotlin.spring

import com.metaobjects.generator.kotlin.KotlinExposedTableGenerator
import com.metaobjects.loader.MetaDataLoader
import com.metaobjects.spring.MetaDataLoaderConfiguration
import java.net.URLClassLoader
import java.nio.file.Files
import java.nio.file.Path
import kotlin.io.path.readText
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * B1 / ADR-0058 from Kotlin. A Kotlin Spring application starts from the same
 * `MetaDataLoaderConfiguration` bean as a Java one, and with no property set that bean finds the
 * project's `naming` at `classpath:.metaobjects/config.json`. The Exposed table generated from
 * the loader it returns must then spell the LITERAL column name the project asked for, not the
 * snake_case default a loader with no config would derive.
 */
class ClasspathNamingDiscoveryTest {

    private val model = """{
      "metadata.root": { "package": "acme::naming", "children": [
        { "object.entity": { "name": "Booking", "children": [
            { "field.long":   { "name": "id" } },
            { "field.string": { "name": "createdBy", "@maxLength": 40 } },
            { "source.rdb":   { "@table": "bookings" } },
            { "identity.primary": { "@fields": ["id"], "@generation": "increment" } }
        ] } }
      ] }
    }""".trimIndent()

    private val originalLoader: ClassLoader = Thread.currentThread().contextClassLoader

    @AfterTest
    fun restoreClassLoader() {
        Thread.currentThread().contextClassLoader = originalLoader
    }

    private fun projectRoot(config: String?): Path {
        val root = Files.createTempDirectory("kt-naming-")
        if (config != null) {
            Files.createDirectories(root.resolve(".metaobjects"))
            Files.writeString(root.resolve(".metaobjects/config.json"), config)
        }
        return root
    }

    /** The loader the Spring configuration bean builds with [root] on the thread's classpath. */
    private fun springLoader(root: Path): MetaDataLoader {
        Thread.currentThread().contextClassLoader = URLClassLoader(arrayOf(root.toUri().toURL()), originalLoader)
        val metadata = Files.createTempDirectory("kt-naming-meta-").resolve("meta.booking.json")
        Files.writeString(metadata, model)
        val config = MetaDataLoaderConfiguration()
        config.metadataSources = listOf(metadata.toUri().toString())
        return config.applicationMetaDataLoader()
    }

    private fun tableSource(loader: MetaDataLoader): String {
        val out = Files.createTempDirectory("kt-naming-out-")
        KotlinExposedTableGenerator()
            .apply { setArgs(mapOf("outputDir" to out.toString())) }
            .execute(loader)
        return out.resolve("acme/naming/BookingTable.kt").readText()
    }

    @Test
    fun `an unset property reads naming from the classpath config and the table spells the literal column`() {
        val loader = springLoader(projectRoot("""{"schema_version":1,"naming":{"columns":"literal"}}"""))
        assertEquals("literal", loader.root.physicalNaming.columns())
        val src = tableSource(loader)
        assertTrue("\"createdBy\"" in src, "the literal column name createdBy is expected in:\n$src")
        assertTrue("created_by" !in src, "no snake_case column is expected in:\n$src")
    }

    @Test
    fun `with no classpath config the same model gets the snake_case default`() {
        val loader = springLoader(projectRoot(null))
        assertEquals("snake_case", loader.root.physicalNaming.columns())
        assertTrue("\"created_by\"" in tableSource(loader))
    }
}

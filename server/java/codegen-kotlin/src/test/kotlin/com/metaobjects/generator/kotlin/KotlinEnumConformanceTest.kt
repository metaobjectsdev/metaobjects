package com.metaobjects.generator.kotlin

import com.metaobjects.metadata.ktx.loadString
import com.metaobjects.loader.MetaDataLoader
import org.junit.jupiter.api.Test
import java.nio.file.Files
import java.nio.file.Path
import kotlin.io.path.readText
import kotlin.test.assertTrue

/**
 * Cross-port enum conformance (Kotlin). Loads the shared fixture
 * `fixtures/codegen-conformance/enum/input/meta.enum.json` and asserts the Kotlin entity
 * generator emits a standalone `enum class` per enum field — an INLINE enum (`status`)
 * named `<Entity><Field>` carrying its own members, and a field that `extends` the abstract
 * root `Priority` enum collapsed onto one shared `enum class Priority` with the inherited
 * members.
 */
class KotlinEnumConformanceTest {

    private fun loadFixture(): MetaDataLoader {
        val fixture = Path.of(System.getProperty("user.dir"))
            .resolve("../../..").normalize()
            .resolve("fixtures/codegen-conformance/enum/input/meta.enum.json")
        assertTrue(Files.exists(fixture), "shared enum fixture missing at $fixture")
        return loadString("enumFixture", Files.readString(fixture))
    }

    private fun generate(): Path {
        val out = Files.createTempDirectory("kgen-enum-conf-")
        KotlinEntityGenerator().apply { setArgs(mapOf("outputDir" to out.toString())) }.execute(loadFixture())
        return out
    }

    @Test
    fun `inline enum field emits a standalone enum class`() {
        val out = generate()
        try {
            val statusEnum = out.resolve("acme/shop/TicketStatus.kt")
            assertTrue(Files.exists(statusEnum), "TicketStatus.kt enum class must be emitted")
            val src = statusEnum.readText()
            assertTrue("enum class TicketStatus" in src, "expected `enum class TicketStatus`; saw:\n$src")
            for (m in listOf("OPEN", "PENDING", "CLOSED"))
                assertTrue(m in src, "member $m must be present; saw:\n$src")
        } finally {
            out.toFile().deleteRecursively()
        }
    }

    @Test
    fun `extends an abstract root enum collapses onto one shared enum class`() {
        val out = generate()
        try {
            val priorityEnum = out.resolve("acme/shop/Priority.kt")
            assertTrue(Files.exists(priorityEnum), "shared Priority.kt enum class must be emitted")
            val src = priorityEnum.readText()
            assertTrue("enum class Priority" in src, "expected shared `enum class Priority`; saw:\n$src")
            for (m in listOf("LOW", "MEDIUM", "HIGH"))
                assertTrue(m in src, "inherited member $m must be present; saw:\n$src")
        } finally {
            out.toFile().deleteRecursively()
        }
    }
}

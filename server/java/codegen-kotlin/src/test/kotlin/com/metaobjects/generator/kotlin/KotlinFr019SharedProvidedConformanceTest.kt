package com.metaobjects.generator.kotlin

import com.metaobjects.metadata.ktx.loadString
import com.metaobjects.loader.MetaDataLoader
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.nio.file.Files
import java.nio.file.Path
import kotlin.io.path.readText
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Cross-port FR-019 conformance (Kotlin). Loads the shared fixture
 * `fixtures/codegen-conformance/shared-provided-enum/input/meta.json` and asserts the two FR-019
 * behaviors (ADR-0026):
 *  - Shared materialization — a package-level abstract `field.enum` (`Priority`) extended by TWO
 *    entities is materialized ONCE as a standalone `enum class Priority`; both data classes type
 *    their property as it (no per-entity redeclaration).
 *  - `@provided` — a package-level abstract `field.enum` (`Currency`, `@provided: true`) is NOT
 *    materialized; consuming data classes reference it at the configured namespace
 *    (`<ns>.Currency`). A referenced provided enum with no configured namespace is a codegen-time
 *    error naming the enum.
 */
class KotlinFr019SharedProvidedConformanceTest {

    private fun loadFixture(): MetaDataLoader {
        val fixture = Path.of(System.getProperty("user.dir"))
            .resolve("../../..").normalize()
            .resolve("fixtures/codegen-conformance/shared-provided-enum/input/meta.json")
        assertTrue(Files.exists(fixture), "shared FR-019 fixture missing at $fixture")
        return loadString("sharedProvidedEnumFixture", Files.readString(fixture))
    }

    private fun generate(providedEnumNamespace: String?): Path {
        val out = Files.createTempDirectory("kgen-fr019-conf-")
        val args = mutableMapOf("outputDir" to out.toString())
        if (providedEnumNamespace != null) args["providedEnumNamespace"] = providedEnumNamespace
        KotlinEntityGenerator().apply { setArgs(args) }.execute(loadFixture())
        return out
    }

    @Test
    fun `shared enum is materialized once and referenced by both entities`() {
        val out = generate("com.acme.ext")
        try {
            val priorityEnum = out.resolve("acme/shop/Priority.kt")
            assertTrue(Files.exists(priorityEnum), "shared Priority.kt enum class must be materialized")
            val enumSrc = priorityEnum.readText()
            assertTrue("enum class Priority" in enumSrc, "expected shared `enum class Priority`; saw:\n$enumSrc")
            for (m in listOf("LOW", "MEDIUM", "HIGH"))
                assertTrue(m in enumSrc, "member $m must be present; saw:\n$enumSrc")

            for (name in listOf("Ticket.kt", "Order.kt")) {
                val dc = out.resolve("acme/shop").resolve(name)
                assertTrue(Files.exists(dc), "$name must be emitted")
                val src = dc.readText()
                assertTrue("priority" in src && "Priority" in src,
                    "$name must type its priority property as the shared enum; saw:\n$src")
                // Same-package reference: no redeclaration and no cross-package import.
                assertFalse("enum class Priority" in src, "$name must NOT redeclare the shared enum; saw:\n$src")
            }
        } finally {
            out.toFile().deleteRecursively()
        }
    }

    @Test
    fun `provided enum is not materialized and referenced at the configured namespace`() {
        val out = generate("com.acme.ext")
        try {
            assertFalse(Files.exists(out.resolve("acme/shop/Currency.kt")),
                "provided Currency must NOT be materialized")
            val ticket = out.resolve("acme/shop/Ticket.kt").readText()
            assertTrue("com.acme.ext.Currency" in ticket || "import com.acme.ext.Currency" in ticket,
                "currency property must reference the configured external namespace; saw:\n$ticket")
        } finally {
            out.toFile().deleteRecursively()
        }
    }

    @Test
    fun `provided enum with no namespace config is a codegen error naming the enum`() {
        val ex = assertThrows<RuntimeException> { generate(null) }
        assertTrue(ex.message?.contains("Currency") == true,
            "error must name the provided enum Currency; was: ${ex.message}")
    }
}

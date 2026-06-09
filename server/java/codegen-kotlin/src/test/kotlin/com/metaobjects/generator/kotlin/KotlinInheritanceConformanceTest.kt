package com.metaobjects.generator.kotlin

import com.metaobjects.metadata.ktx.loadString
import com.metaobjects.loader.MetaDataLoader
import org.junit.jupiter.api.Test
import java.nio.file.Files
import java.nio.file.Path
import kotlin.io.path.readText
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Cross-port inheritance conformance (Kotlin). Loads the shared fixture
 * `fixtures/codegen-conformance/inheritance/input/meta.inheritance.json` and asserts the flatten
 * port inlines the FULL field set across two abstract levels into the concrete `Product` data
 * class — `id`, `createdBy` (Base), `updatedBy` (Auditable) + `sku`, `qtyOnHand` (own) — while
 * the abstract bases emit no entity file.
 */
class KotlinInheritanceConformanceTest {

    private fun loadFixture(): MetaDataLoader {
        val fixture = Path.of(System.getProperty("user.dir"))
            .resolve("../../..").normalize()
            .resolve("fixtures/codegen-conformance/inheritance/input/meta.inheritance.json")
        assertTrue(Files.exists(fixture), "shared inheritance fixture missing at $fixture")
        return loadString("inheritanceFixture", Files.readString(fixture))
    }

    @Test
    fun `concrete data class flattens the full multi-level inherited field set`() {
        val out = Files.createTempDirectory("kgen-inh-conf-")
        try {
            KotlinEntityGenerator().apply { setArgs(mapOf("outputDir" to out.toString())) }.execute(loadFixture())

            // Abstract bases produce no entity file.
            assertFalse(Files.exists(out.resolve("acme/shop/Base.kt")), "Base is abstract — no Base.kt")
            assertFalse(Files.exists(out.resolve("acme/shop/Auditable.kt")), "Auditable is abstract — no Auditable.kt")

            val product = out.resolve("acme/shop/Product.kt")
            assertTrue(Files.exists(product), "Product.kt MUST be emitted (concrete entity)")
            val src = product.readText()

            for (field in listOf("id", "createdBy", "updatedBy", "sku", "qtyOnHand"))
                assertTrue("val $field" in src, "Product must carry inherited/own field `$field`; saw:\n$src")

            // The inherited required `createdBy` keeps its validation (flattened from Base).
            assertTrue("@field:Size(max = 80)" in src, "inherited createdBy must keep @Size(max=80); saw:\n$src")
        } finally {
            out.toFile().deleteRecursively()
        }
    }
}

package com.metaobjects.generator.kotlin

import com.metaobjects.generator.GeneratorException
import com.metaobjects.loader.MetaDataLoader
import com.metaobjects.metadata.ktx.loadString
import com.tschuchort.compiletesting.KotlinCompilation
import com.tschuchort.compiletesting.SourceFile
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.nio.file.Files
import java.nio.file.Path
import kotlin.io.path.isRegularFile
import kotlin.io.path.readText
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * FR-019 — a `@provided` shared enum is ONE class, wherever a generator types it.
 *
 * The shared fixture declares `Currency` (`@provided`) and reaches it in one hop
 * (`Ticket.currency`) and through another field (`Refund.tender extends Ticket.currency`). The
 * provided class is whatever `providedEnumNamespace` / `providedEnumPackages` name; nothing
 * generates one in the declaration's own package. So every generator must type both fields by
 * the configured class — a data class typed `com.acme.ext.Currency` beside an Exposed table
 * typed `acme.shop.Currency` does not compile, because the second class does not exist.
 *
 * The entity and Exposed table output are compiled together with a hand-written
 * `com.acme.ext.Currency` standing in for the adopter's own enum. The Spring controller tier is
 * NOT in the compile: its framework imports are not on this module's test classpath (the same
 * boundary the codegen-compile gate draws), so its enum reference is asserted on the emitted
 * source instead.
 */
@OptIn(org.jetbrains.kotlin.compiler.plugin.ExperimentalCompilerApi::class)
class KotlinProvidedEnumAcrossGeneratorsTest {

    private val provided = mapOf("providedEnumNamespace" to "com.acme.ext")

    private fun loadFixture(): MetaDataLoader {
        val fixture = Path.of(System.getProperty("user.dir"))
            .resolve("../../..").normalize()
            .resolve("fixtures/codegen-conformance/shared-provided-enum/input/meta.json")
        return loadString("providedEnumAcrossGenerators", Files.readString(fixture))
    }

    private fun generate(generator: com.metaobjects.generator.GeneratorBase, args: Map<String, String>): Path {
        val out = Files.createTempDirectory("kgen-provided-")
        generator.setArgs(args + ("outputDir" to out.toString()))
        generator.execute(loadFixture())
        return out
    }

    private fun sourcesUnder(dir: Path): List<Path> =
        Files.walk(dir).use { walk -> walk.filter { it.isRegularFile() }.sorted().toList() }

    @Test
    fun `one-hop and multi-hop provided enum fields are the configured class in the data class and the table`() {
        val entityOut = generate(KotlinEntityGenerator(), provided)
        val tableOut = generate(KotlinExposedTableGenerator(), provided)
        try {
            val generated = sourcesUnder(entityOut) + sourcesUnder(tableOut)
            for (file in generated) {
                assertFalse("acme.shop.Currency" in file.readText(),
                    "$file must not reference a Currency in the declaration's package, which nothing generates")
            }
            assertFalse(generated.any { it.fileName.toString() == "Currency.kt" },
                "a @provided enum must never be generated; files=$generated")

            val result = KotlinCompilation().apply {
                sources = generated.mapIndexed { i, path -> SourceFile.kotlin("g${i}_${path.fileName}", path.readText()) } +
                    SourceFile.kotlin("ProvidedCurrency.kt", "package com.acme.ext\n\nenum class Currency { USD, EUR, GBP }\n")
                inheritClassPath = true
                messageOutputStream = System.out
            }.compile()
            assertEquals(KotlinCompilation.ExitCode.OK, result.exitCode, result.messages)

            val loader = result.classLoader
            assertEquals("com.acme.ext.Currency",
                loader.loadClass("acme.shop.Ticket").getMethod("getCurrency").returnType.name)
            assertEquals("com.acme.ext.Currency",
                loader.loadClass("acme.shop.Refund").getMethod("getTender").returnType.name)
            for ((table, column) in listOf("acme.shop.TicketTable" to "getCurrency", "acme.shop.RefundTable" to "getTender")) {
                val columnType = loader.loadClass(table).getMethod(column).genericReturnType.typeName
                assertTrue("com.acme.ext.Currency" in columnType,
                    "$table.$column must be a column of the configured provided enum; was $columnType")
            }
        } finally {
            entityOut.toFile().deleteRecursively()
            tableOut.toFile().deleteRecursively()
        }
    }

    @Test
    fun `the Spring controller references the configured provided class`() {
        val out = generate(KotlinSpringControllerGenerator(), provided)
        try {
            for (name in listOf("TicketController.kt", "RefundController.kt")) {
                val src = out.resolve("acme/shop").resolve(name).readText()
                assertTrue("com.acme.ext.Currency" in src,
                    "$name must type the provided enum by the configured class; saw:\n$src")
                assertFalse("acme.shop.Currency" in src,
                    "$name must not reference a Currency in the declaration's package; saw:\n$src")
            }
        } finally {
            out.toFile().deleteRecursively()
        }
    }

    @Test
    fun `a generator with no provided config fails at generate time, naming the enum and the args`() {
        for (generator in listOf(KotlinExposedTableGenerator(), KotlinSpringControllerGenerator(), KotlinEntityGenerator())) {
            val ex = assertThrows<GeneratorException>("${generator::class.simpleName}") { generate(generator, emptyMap()) }
            val message = ex.message.orEmpty()
            for (expected in listOf("Currency", "acme::shop", "providedEnumNamespace", "providedEnumPackages")) {
                assertTrue(expected in message, "${generator::class.simpleName}: the error must name $expected; was: $message")
            }
        }
    }
}

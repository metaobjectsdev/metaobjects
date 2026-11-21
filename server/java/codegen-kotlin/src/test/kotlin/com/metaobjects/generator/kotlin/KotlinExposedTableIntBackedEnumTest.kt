package com.metaobjects.generator.kotlin

import com.metaobjects.metadata.ktx.loadDirectory
import com.tschuchort.compiletesting.KotlinCompilation
import com.tschuchort.compiletesting.SourceFile
import java.nio.file.Files
import java.nio.file.Path
import kotlin.io.path.isRegularFile
import kotlin.io.path.readText
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Int-backed `field.enum` (`@intValueMap`) on the Exposed table generator.
 *
 * A string-backed enum persists its member symbol into a VARCHAR via
 * `enumerationByName`. One declaring `@intValueMap` must instead persist the declared
 * INTEGER via `customEnumeration`, while the Kotlin-side property type stays the very
 * same generated enum class — int-backing is a persistence concern, invisible in the
 * entity's API.
 *
 * The fixture carries BOTH modes on one entity (`priority` int-backed, `status`
 * string-backed) so the test also pins that adding the feature did not change the
 * string-backed emission.
 *
 * The compile gate is the load-bearing part. The generator hand-rolls its file body as
 * a string, so `customEnumeration`'s two lambdas are only proven to type-check against
 * the real Exposed API — the `Number`→`Int` narrowing on read, and the exhaustive `when`
 * over the enum on write — by compiling the emitted tree. A text assertion alone would
 * happily pass on a column spec that does not compile in the adopter's build.
 */
@OptIn(org.jetbrains.kotlin.compiler.plugin.ExperimentalCompilerApi::class)
class KotlinExposedTableIntBackedEnumTest {

    private val models: Path = run {
        var p: Path? = Path.of(System.getProperty("user.dir")).toAbsolutePath()
        while (p != null && !Files.exists(p.resolve("src/test/resources/models"))) {
            p = p.parent
        }
        assertTrue(p != null, "could not locate src/test/resources/models from user.dir")
        p!!.resolve("src/test/resources/models")
    }

    private fun compile(outDir: Path): KotlinCompilation.Result {
        val sources = Files.walk(outDir).filter { it.isRegularFile() }.sorted().toList()
            .map { path -> SourceFile.kotlin(path.parent.relativize(path).toString().replace('/', '_'), path.readText()) }
        return KotlinCompilation().apply {
            this.sources = sources
            inheritClassPath = true
            messageOutputStream = System.out
        }.compile()
    }

    @Test fun `int-backed enum emits customEnumeration over INTEGER and still compiles`() {
        val outDir = Files.createTempDirectory("ktbl-int-enum-")
        try {
            val loader = loadDirectory("enum-int-backed", models.resolve("enum-int-backed"))
            for (gen in listOf(KotlinEntityGenerator(), KotlinExposedTableGenerator())) {
                gen.setArgs(mapOf("outputDir" to outDir.toString()))
                gen.execute(loader)
            }

            val table = outDir.resolve("acme/shop/OrderTable.kt")
            assertTrue(Files.exists(table), "expected $table; files=${Files.walk(outDir).toList()}")
            val src = table.readText()

            // int-backed → customEnumeration over an INTEGER column, carrying the
            // declared mapping in BOTH directions.
            assertTrue("customEnumeration(\"priority\", \"INTEGER\"" in src,
                "priority must use customEnumeration over INTEGER; saw:\n$src")
            assertTrue("0 -> OrderPriority.DRAFT" in src && "5 -> OrderPriority.PUBLISHED" in src &&
                "9 -> OrderPriority.ARCHIVED" in src,
                "read lambda must map every declared int to its member; saw:\n$src")
            assertTrue("OrderPriority.DRAFT -> 0" in src && "OrderPriority.PUBLISHED -> 5" in src &&
                "OrderPriority.ARCHIVED -> 9" in src,
                "write lambda must map every member to its declared int; saw:\n$src")

            // ...and the int-backed column must NOT take the string form.
            assertTrue("enumerationByName(\"priority\"" !in src,
                "priority must not emit the string-backed column; saw:\n$src")

            // The string-backed sibling is unchanged — this feature is additive.
            assertTrue("customEnumeration(\"status\", \"TEXT\"" in src,
                "string-backed status (no length configured) is a text column; saw:\n$src")
            assertTrue("customEnumeration(\"status\", \"INTEGER\"" !in src,
                "string-backed status must not become the int-backed form; saw:\n$src")

            // Compile gate: proves both lambdas type-check against the real Exposed API.
            val result = compile(outDir)
            assertEquals(KotlinCompilation.ExitCode.OK, result.exitCode, result.messages)
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    /**
     * An int-backed enum ARRAY (the map inherited from a shared abstract enum, the shape adopters
     * write) is one array column over the declared integers, never the scalar `customEnumeration`:
     * that would not type-check against the `List<E>` property, and must never store member symbols.
     * The column type lives in its own support file, emitted only because such a column exists.
     */
    @Test fun `int-backed enum array emits the integer array column and its support file and compiles`() {
        val outDir = Files.createTempDirectory("ktbl-int-enum-array-")
        try {
            val loader = loadDirectory("enum-int-backed-array", models.resolve("enum-int-backed-array"))
            for (gen in listOf(KotlinEntityGenerator(), KotlinExposedTableGenerator())) {
                gen.setArgs(mapOf("outputDir" to outDir.toString()))
                gen.execute(loader)
            }

            val src = outDir.resolve("acme/shop/DocTable.kt").readText()
            assertTrue("portableIntEnumArray<Stage>(\"history\"" in src,
                "history must be the integer array column; saw:\n$src")
            assertTrue("Stage.DRAFT -> 0" in src && "Stage.PUBLISHED -> 5" in src && "Stage.ARCHIVED -> 9" in src,
                "the write lambda must map every member to its declared int; saw:\n$src")
            assertTrue("0 -> Stage.DRAFT" in src && "5 -> Stage.PUBLISHED" in src && "9 -> Stage.ARCHIVED" in src,
                "the read lambda must map every declared int to its member; saw:\n$src")
            assertTrue("unmapped stored value" in src, "an int with no member must fail the read; saw:\n$src")
            assertTrue("customEnumeration(\"history\"" !in src,
                "an array must not take the scalar column; saw:\n$src")
            // The scalar sibling sharing the map keeps the scalar form.
            assertTrue("customEnumeration(\"stage\", \"INTEGER\"" in src, "scalar stage unchanged; saw:\n$src")

            val support = outDir.resolve("acme/shop/MetaIntEnumArrayColumnType.kt")
            assertTrue(Files.exists(support), "expected the support file; files=${Files.walk(outDir).toList()}")
            val supportSrc = support.readText()
            assertTrue("INTEGER[]" in supportSrc && "\"integer\"" in supportSrc,
                "the support file must bind a native integer[] on Postgres; saw:\n$supportSrc")

            val result = compile(outDir)
            assertEquals(KotlinCompilation.ExitCode.OK, result.exitCode, result.messages)
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    @Test fun `a package with no int-backed enum array gets no integer array support file`() {
        val outDir = Files.createTempDirectory("ktbl-int-enum-noarray-")
        try {
            val loader = loadDirectory("enum-int-backed", models.resolve("enum-int-backed"))
            for (gen in listOf(KotlinEntityGenerator(), KotlinExposedTableGenerator())) {
                gen.setArgs(mapOf("outputDir" to outDir.toString()))
                gen.execute(loader)
            }
            assertTrue(!Files.exists(outDir.resolve("acme/shop/MetaIntEnumArrayColumnType.kt")),
                "a scalar-only int-backed enum must not emit the array support file")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }
}

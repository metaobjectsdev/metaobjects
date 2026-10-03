package com.metaobjects.generator.kotlin.exposed1x

import com.metaobjects.generator.Generator
import com.metaobjects.generator.kotlin.KotlinEntityGenerator
import com.metaobjects.generator.kotlin.KotlinExposedTableGenerator
import com.metaobjects.generator.kotlin.KotlinFilterAllowlistGenerator
import com.metaobjects.generator.kotlin.KotlinNamesGenerator
import com.metaobjects.generator.kotlin.KotlinRelationsGenerator
import com.metaobjects.generator.kotlin.KotlinValidatorGenerator
import com.metaobjects.generator.util.GeneratedFileWriter
import com.metaobjects.metadata.ktx.loadDirectory
import com.tschuchort.compiletesting.KotlinCompilation
import com.tschuchort.compiletesting.SourceFile
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import kotlin.io.path.isRegularFile
import kotlin.io.path.readText
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Issue #390 — the `exposedApi=1` sibling of codegen-kotlin's `CodegenCompileConformanceTest`.
 *
 * Generates from the SAME shared cross-port corpus
 * (`fixtures/persistence-conformance/canonical/meta.fitness.json`), with the SAME generator
 * selection that test's "model and persistence tier" run uses (Entity, ExposedTable, Names,
 * Relations, FilterAllowlist, Validator — excluding the framework-bound
 * `KotlinSpringControllerGenerator`/`KotlinSpringConfigGenerator` tier for the identical
 * cross-port reason: those imports are not on an in-memory compile's classpath, and
 * `integration-tests-kotlin` proves the controller tier via a real HTTP lane instead), but with
 * `exposedApi=1` and a DIFFERENT compiler: `dev.zacsweers.kctfork`'s embedded Kotlin compiler
 * (>= 2.2, pinned in this module's pom), not the module's own 2.0.21 `kotlin-maven-plugin`.
 *
 * `exposedApi=0`'s byte-identity is proven in codegen-kotlin itself (every existing golden/
 * snapshot test there is unchanged); this module only needs to prove the NEW `exposedApi=1`
 * arm actually compiles — nothing upstream exercises it otherwise, and "a mode that is never
 * compiled will rot" (issue #390's own words).
 */
@OptIn(org.jetbrains.kotlin.compiler.plugin.ExperimentalCompilerApi::class)
class Exposed1xCodegenCompileTest {

    private fun findCorpusRoot(): Path {
        var cur: Path? = Paths.get("").toAbsolutePath()
        while (cur != null) {
            val candidate = cur.resolve("fixtures/persistence-conformance")
            if (Files.isDirectory(candidate)) return candidate
            cur = cur.parent
        }
        throw IllegalStateException(
            "Could not locate fixtures/persistence-conformance from ${Paths.get("").toAbsolutePath()}")
    }

    @Test
    fun `exposedApi=1 model and persistence tier compiles against Exposed 1_3_x`() {
        val canonical = findCorpusRoot().resolve("canonical")
        val outDir = Files.createTempDirectory("exposed1x-compile-")
        try {
            val loader = loadDirectory("fitness-exposed1x", canonical)

            val generators: List<Pair<String, Generator>> = listOf(
                "KotlinEntityGenerator" to KotlinEntityGenerator(),
                "KotlinExposedTableGenerator" to KotlinExposedTableGenerator(),
                "KotlinNamesGenerator" to KotlinNamesGenerator(),
                "KotlinRelationsGenerator" to KotlinRelationsGenerator(),
                "KotlinFilterAllowlistGenerator" to KotlinFilterAllowlistGenerator(),
                "KotlinValidatorGenerator" to KotlinValidatorGenerator(),
            )

            GeneratedFileWriter.beginRun().use { run ->
                for ((name, gen) in generators) {
                    run.attributeTo(name)
                    gen.setArgs(mapOf(
                        "outputDir" to outDir.toString(),
                        "packageName" to "fitness",
                        "templateRoot" to canonical.resolve("prompts").toString(),
                        // The ONE thing this test exists to exercise (issue #390).
                        "exposedApi" to "1",
                    ))
                    gen.execute(loader)
                }
            }

            val emittedPaths = Files.walk(outDir)
                .filter { it.isRegularFile() && it.toString().endsWith(".kt") }
                .toList()
            assertTrue(emittedPaths.size >= 17,
                "expected at least 17 file(s) from the model+persistence selection, saw ${emittedPaths.size}")

            val combined = emittedPaths.joinToString("\n") { it.readText() }
            // Sanity: this run actually exercised the 1.x arm, not a silently-ignored arg.
            assertTrue("org.jetbrains.exposed.v1." in combined,
                "exposedApi=1 output never referenced org.jetbrains.exposed.v1.* — the arg was " +
                    "silently ignored:\n${emittedPaths.map { it.fileName }}")
            assertFalse("org.jetbrains.exposed.sql." in combined,
                "exposedApi=1 output still referenced the 0.x org.jetbrains.exposed.sql.* " +
                    "package — exposedApi did not fully flip every emission site")
            // The acceptance-critical trap the issue calls out BY NAME: a java.util.UUID column
            // must use javaUUID(...), never bare uuid(...) (which binds kotlin.uuid.Uuid under
            // 1.x — "the one silent trap: emitting uuid() still compiles, but it changes the
            // Kotlin type"). The Asset entity's `id`/`ownerId` (native field.uuid) route through
            // this. `externalId` (field.string @dbColumnType=uuid) does NOT — it now emits the
            // package-shared `uuidString(...)` extension (ADR-0037: the escape hatch is
            // physical-only, so the property stays String; see
            // KotlinExposedTableGenerator.uuidStringSupportBlock) — but id/ownerId alone still
            // exercise the javaUUID(...) trap this assertion exists to catch.
            assertTrue(Regex("""\bjavaUUID\(""").containsMatchIn(combined),
                "expected at least one javaUUID(...) column — the fixture declares field.uuid " +
                    "columns (Asset.id/ownerId); none were found in:\n${emittedPaths.map { it.fileName }}")
            assertFalse(Regex("""(?<!java)\buuid\(""").containsMatchIn(combined),
                "expected NO bare uuid(...) column under exposedApi=1 (it would bind " +
                    "kotlin.uuid.Uuid, not java.util.UUID — issue #390's named silent trap)")

            val sources = emittedPaths.map { SourceFile.kotlin(it.fileName.toString(), it.readText()) }
            val result = KotlinCompilation().apply {
                this.sources = sources
                inheritClassPath = true
                messageOutputStream = System.out
            }.compile()

            assertEquals(KotlinCompilation.ExitCode.OK, result.exitCode,
                "exposedApi=1 output over the shared fitness corpus emitted ${sources.size} " +
                    "file(s) that do not compile against Exposed 1.3.x:\n${result.messages}")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }
}

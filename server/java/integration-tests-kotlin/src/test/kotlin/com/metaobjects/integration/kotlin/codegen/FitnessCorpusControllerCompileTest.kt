package com.metaobjects.integration.kotlin.codegen

import com.metaobjects.generator.Generator
import com.metaobjects.generator.kotlin.KotlinEntityGenerator
import com.metaobjects.generator.kotlin.KotlinExposedTableGenerator
import com.metaobjects.generator.kotlin.KotlinFilterAllowlistGenerator
import com.metaobjects.generator.kotlin.KotlinNamesGenerator
import com.metaobjects.generator.kotlin.KotlinRelationsGenerator
import com.metaobjects.generator.kotlin.KotlinSpringControllerGenerator
import com.metaobjects.generator.kotlin.KotlinValidatorGenerator
import com.metaobjects.integration.kotlin.ScenarioLoader
import com.metaobjects.loader.MetaDataLoader
import com.tschuchort.compiletesting.KotlinCompilation
import com.tschuchort.compiletesting.SourceFile
import java.nio.file.Files
import kotlin.io.path.isRegularFile
import kotlin.io.path.readText
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * `exposedApi=0` (the default) sibling of `codegen-kotlin-exposed1x-check`'s
 * `Exposed1xControllerCompileTest` — closes the SAME gap that test closes for `exposedApi=1`:
 * `codegen-kotlin`'s own `CodegenCompileConformanceTest` compiles the full shared fitness corpus
 * (`fixtures/persistence-conformance/canonical/meta.fitness.json`) for the model+persistence tier,
 * but deliberately EXCLUDES [KotlinSpringControllerGenerator] (that module has no Spring on its
 * classpath by design — see that test's own class doc). `codegen-kotlin-exposed1x-check` compiles
 * the controller tier, but only against Exposed 1.x — it has no 0.x Exposed dependency at all.
 * So the `exposedApi=0` controller tier — the DEFAULT every adopter who sets nothing gets — had
 * NEVER been compiled over the full corpus by anything until this test. This module already has
 * real Exposed 0.x + Spring 6.2 + jakarta.servlet + Jackson on its test classpath (it hosts the
 * generated-controller HTTP lanes), so it is the natural place to close the gap.
 *
 * Found and fixed by this same thoroughness, mirroring `Exposed1xControllerCompileTest`'s find:
 *  1. `AllTypesController.kt` — the per-field filter dispatch's ordering-op gate was a hand-rolled
 *     `!isStringLike && !isBoolean` check, which emitted `greater`/`greaterEq`/`less`/`lessEq` for
 *     `field.inet` — whose Kotlin type (`java.net.InetAddress`) is not `Comparable`. Fixed by
 *     deriving the gate from the SAME single source of truth the generated `<Entity>FilterAllowlist`
 *     reads — `com.metaobjects.query.FilterOps` — via `KotlinSpringControllerGenerator.fieldFilterBand`.
 *  2. `AssetController.kt` — the `field.string @dbColumnType=uuid` escape hatch bound a native
 *     `Column<UUID>` table-side while the controller assumed `String` (ADR-0037: the escape hatch
 *     is physical-only, so the property stays `String`) — a mismatch on every comparison and the
 *     PATCH bind. Fixed by giving the table a `Column<String>` instead
 *     (`KotlinExposedTableGenerator`'s package-shared `uuidString(...)` extension, which persists
 *     through the native Postgres `uuid` type while converting only at the Kotlin-value boundary).
 *
 * Both fixes are `exposedApi`-INDEPENDENT (the root causes held identically on both versions), so
 * this test — unlike `Exposed1xControllerCompileTest` — needed NO exclusion at any point; it is
 * added already green.
 */
@OptIn(org.jetbrains.kotlin.compiler.plugin.ExperimentalCompilerApi::class)
class FitnessCorpusControllerCompileTest {

    @Test
    fun `exposedApi=0 controller tier compiles over the full shared fitness corpus`() {
        val canonical = ScenarioLoader.findCorpusRoot().resolve("canonical")
        val outDir = Files.createTempDirectory("fitness-controller-compile-")
        try {
            val loader = MetaDataLoader.fromDirectory("fitness-controller-v0", canonical)

            val generators: List<Pair<String, Generator>> = listOf(
                "KotlinEntityGenerator" to KotlinEntityGenerator(),
                "KotlinExposedTableGenerator" to KotlinExposedTableGenerator(),
                "KotlinNamesGenerator" to KotlinNamesGenerator(),
                "KotlinRelationsGenerator" to KotlinRelationsGenerator(),
                "KotlinFilterAllowlistGenerator" to KotlinFilterAllowlistGenerator(),
                "KotlinValidatorGenerator" to KotlinValidatorGenerator(),
                "KotlinSpringControllerGenerator" to KotlinSpringControllerGenerator(),
            )
            for ((_, gen) in generators) {
                gen.setArgs(mapOf(
                    "outputDir" to outDir.toString(),
                    "packageName" to "fitness",
                    "templateRoot" to canonical.resolve("prompts").toString(),
                    // The point of this test: exposedApi is left UNSET, so every generator
                    // takes the "0" default (byte-identical to every release before issue #390).
                ))
                gen.execute(loader)
            }

            val emittedPaths = Files.walk(outDir)
                .filter { it.isRegularFile() && it.toString().endsWith(".kt") }
                .toList()
            assertTrue(emittedPaths.any { it.fileName.toString().endsWith("Controller.kt") },
                "expected at least one <Entity>Controller.kt; saw ${emittedPaths.map { it.fileName }}")
            assertTrue(emittedPaths.any { it.fileName.toString() == "AllTypesController.kt" },
                "expected the fitness corpus to include AllTypesController.kt; saw ${emittedPaths.map { it.fileName }}")
            assertTrue(emittedPaths.any { it.fileName.toString() == "AssetController.kt" },
                "expected the fitness corpus to include AssetController.kt; saw ${emittedPaths.map { it.fileName }}")

            val sources = emittedPaths.map { SourceFile.kotlin(it.fileName.toString(), it.readText()) }
            val result = KotlinCompilation().apply {
                this.sources = sources
                inheritClassPath = true
                messageOutputStream = System.out
            }.compile()

            assertEquals(KotlinCompilation.ExitCode.OK, result.exitCode,
                "exposedApi=0 controller tier over the shared fitness corpus emitted " +
                    "${sources.size} file(s) that do not compile:\n${result.messages}")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }
}

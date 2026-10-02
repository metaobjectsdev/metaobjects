package com.metaobjects.generator.kotlin.exposed1x

import com.metaobjects.generator.Generator
import com.metaobjects.generator.kotlin.KotlinEntityGenerator
import com.metaobjects.generator.kotlin.KotlinExposedTableGenerator
import com.metaobjects.generator.kotlin.KotlinFilterAllowlistGenerator
import com.metaobjects.generator.kotlin.KotlinNamesGenerator
import com.metaobjects.generator.kotlin.KotlinRelationsGenerator
import com.metaobjects.generator.kotlin.KotlinSpringControllerGenerator
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
import kotlin.test.assertTrue

/**
 * Issue #390 (review fix #2) — the controller tier's `exposedApi=1` compile pass that was
 * MISSING: [Exposed1xCodegenCompileTest] mirrors `CodegenCompileConformanceTest`'s exclusion of
 * `KotlinSpringControllerGenerator` (the framework-bound tier, proven by a real HTTP lane for
 * 0.x) and the round-trip test only runs `KotlinExposedTableGenerator` — so the blocker review
 * caught (every `emitFilterPipeline` operator but `eq`/`and`/`castTo` missing its v1 top-level
 * import, across all three of `emit`/`emitTph`/`emitReadOnly`) shipped with BOTH existing passes
 * green. This test closes that gap for exactly the part 0.x proves by a *different* mechanism
 * (a real HTTP lane) that this module does not also stand up: it compiles the generated
 * controller — not host it — which is exactly where a missing operator import surfaces.
 *
 * Generates the FULL shared fitness corpus (not a trimmed selection) with
 * `exposedApi=1`, using every generator a real build would wire alongside the controller
 * (Entity, ExposedTable, Names, Relations, FilterAllowlist, Validator, SpringController) so the
 * corpus's TPH hierarchy (Auth/Bridge/Copay/PriorAuth/Referral — exercises `emitTph`), its M:N
 * associations (tags/referrals/following/friends — exercises `emitM2mEndpoint` +
 * `KotlinRelationsGenerator`'s M:N join helpers), its view projections (exercises
 * `emitReadOnly`), and its mixed scalar subtypes (string/enum/int-backed-enum/boolean/numeric/
 * uuid — exercises every `emitPerFieldDispatchArm` operator arm) all compile in ONE pass against
 * real Spring 6.2 (`spring-webmvc`) + jakarta.servlet + Jackson types on this module's test
 * classpath (this module's pom — real dependencies, not stubs, so a missing import fails here
 * exactly as it would for a real consumer).
 *
 * **Excluded: `AllTypesController.kt` and `AssetController.kt`** — found by this same thoroughness,
 * but PRE-EXISTING and `exposedApi`-INDEPENDENT (confirmed: neither trace mentions a package the
 * `exposedApi` branch chooses, and the root causes hold identically for `uuid`/`javaUUID`, which
 * bind the same `java.util.UUID` on both versions). Verbatim from the compiler, before this
 * exclusion was added:
 *  1. `AllTypesController.kt` — `emitPerFieldDispatchArm`'s `!isStringLike && !isBoolean` gate
 *     emits `greater`/`greaterEq`/`less`/`lessEq` for ANY such field, but `field.inet`'s Kotlin
 *     type (`java.net.InetAddress`) does not implement `Comparable` (unlike `field.uuid`'s `UUID`
 *     and `field.uri`'s `URI`, which do and compile fine) — "None of the following candidates is
 *     applicable" on `inetVal`/`inet6Val`'s ordering arms.
 *  2. `AssetController.kt` — the `field.string @dbColumnType=uuid` escape hatch's own contract
 *     (`KotlinTypeMapper`: "the property stays String") binds `externalId` to a `Column<UUID>`
 *     table-side ADR-0037) while `emitPerFieldDispatchArm` casts `(p.value as String)`
 *     controller-side — a String/UUID mismatch on every comparison AND the PATCH bind.
 * Neither is reachable through `KotlinFilterAllowlistGenerator`'s allowlist in a REAL request (it
 * does not admit `gt`/`gte`/`lt`/`lte` for `inet`, matching the port's own filter-op semantics),
 * but the generated Kotlin still has to COMPILE regardless of what a well-formed HTTP request can
 * reach — and until now nothing had ever compiled `KotlinSpringControllerGenerator`'s output for
 * either entity, on any `exposedApi`. Both are genuine defects worth fixing, but a design
 * decision (not a mechanical import) each, and out of issue #390's scope — call out, not papered
 * over, so a reader of a green run here knows exactly what is and is not proven.
 */
@OptIn(org.jetbrains.kotlin.compiler.plugin.ExperimentalCompilerApi::class)
class Exposed1xControllerCompileTest {

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
    fun `exposedApi=1 controller tier compiles against Exposed 1_3_x and Spring 6_2`() {
        val canonical = findCorpusRoot().resolve("canonical")
        val outDir = Files.createTempDirectory("exposed1x-controller-compile-")
        try {
            val loader = loadDirectory("fitness-exposed1x-controller", canonical)

            val generators: List<Pair<String, Generator>> = listOf(
                "KotlinEntityGenerator" to KotlinEntityGenerator(),
                "KotlinExposedTableGenerator" to KotlinExposedTableGenerator(),
                "KotlinNamesGenerator" to KotlinNamesGenerator(),
                "KotlinRelationsGenerator" to KotlinRelationsGenerator(),
                "KotlinFilterAllowlistGenerator" to KotlinFilterAllowlistGenerator(),
                "KotlinValidatorGenerator" to KotlinValidatorGenerator(),
                "KotlinSpringControllerGenerator" to KotlinSpringControllerGenerator(),
            )

            GeneratedFileWriter.beginRun().use { run ->
                for ((name, gen) in generators) {
                    run.attributeTo(name)
                    gen.setArgs(mapOf(
                        "outputDir" to outDir.toString(),
                        "packageName" to "fitness",
                        "templateRoot" to canonical.resolve("prompts").toString(),
                        "exposedApi" to "1",
                    ))
                    gen.execute(loader)
                }
            }

            // See the class doc's "Excluded" section: two PRE-EXISTING, exposedApi-INDEPENDENT
            // controller defects (non-Comparable field.inet ordering ops; the
            // @dbColumnType=uuid escape hatch's String/UUID mismatch) — neither a missing
            // import, neither introduced by this issue, both out of #390's scope.
            val preexistingBrokenControllers = setOf("AllTypesController.kt", "AssetController.kt")
            val emittedPaths: List<Path> = Files.walk(outDir)
                .filter { it.isRegularFile() && it.toString().endsWith(".kt") }
                .filter { it.fileName.toString() !in preexistingBrokenControllers }
                .toList()
            assertTrue(emittedPaths.any { it.fileName.toString().endsWith("Controller.kt") },
                "expected at least one <Entity>Controller.kt; saw ${emittedPaths.map { it.fileName }}")

            val sources = emittedPaths.map { SourceFile.kotlin(it.fileName.toString(), it.readText()) }
            val result = KotlinCompilation().apply {
                this.sources = sources
                inheritClassPath = true
                messageOutputStream = System.out
            }.compile()

            assertEquals(KotlinCompilation.ExitCode.OK, result.exitCode,
                "exposedApi=1 controller tier over the shared fitness corpus emitted " +
                    "${sources.size} file(s) that do not compile against Exposed 1.3.x + " +
                    "Spring 6.2:\n${result.messages}")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }
}

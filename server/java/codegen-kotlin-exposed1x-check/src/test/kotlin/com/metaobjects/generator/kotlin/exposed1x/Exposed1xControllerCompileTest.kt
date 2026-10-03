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
 * **`AllTypesController.kt` and `AssetController.kt` are no longer excluded.** Both were
 * PRE-EXISTING, `exposedApi`-INDEPENDENT defects this same thoroughness first found (confirmed:
 * neither trace mentioned a package the `exposedApi` branch chooses, and the root causes held
 * identically for `uuid`/`javaUUID`, which bind the same `java.util.UUID` on both versions):
 *  1. `AllTypesController.kt` — the per-field filter dispatch's ordering-op gate was a hand-rolled
 *     `!isStringLike && !isBoolean` check that happened to agree with the generated
 *     `<Entity>FilterAllowlist`'s operator band for every subtype EXCEPT `uuid`/`uri`/`inet`
 *     (none string-like, none boolean, so it fell through to "emit ordering ops"): `field.inet`'s
 *     Kotlin type (`java.net.InetAddress`) does not implement `Comparable` (unlike `field.uuid`'s
 *     `UUID` and `field.uri`'s `URI`, which do and compiled fine even though those ordering arms
 *     were ALSO allowlist-unreachable) — "None of the following candidates is applicable" on
 *     `inetVal`/`inet6Val`'s ordering arms. Fixed by deriving the dispatch gate from the SAME
 *     single source of truth the allowlist generator reads —
 *     `com.metaobjects.query.FilterOps.opsForSubType(subType)` — via
 *     `KotlinSpringControllerGenerator.fieldFilterBand`, so the controller can never again emit an
 *     operator the allowlist itself would refuse to admit.
 *  2. `AssetController.kt` — the `field.string @dbColumnType=uuid` escape hatch's own contract
 *     (ADR-0037: physical-only, so `KotlinTypeMapper.kotlinTypeName` keeps the property `String`)
 *     bound `externalId` to a native `Column<UUID>` table-side (`uuid(...)`/`javaUUID(...)`) while
 *     the controller casts `(p.value as String)` and binds `dto.externalId: String` directly
 *     against it — a String/UUID mismatch on every comparison AND the PATCH bind. Fixed by giving
 *     the TABLE a `Column<String>` instead: `KotlinExposedTableGenerator`'s package-shared
 *     `uuidString(...)` extension (`MetaUuidStringColumnType`) persists through the real Postgres
 *     `uuid` type — delegating every JDBC/DDL concern to Exposed's own `UUIDColumnType` — while
 *     converting only at the Kotlin-value boundary, so the column now agrees with the generated
 *     entity/controller's `String` property (matching every other MetaObjects port, which converts
 *     String↔UUID at the layer BELOW the ORM — Java's OMDB `JdbcCodecs.UuidCodec`, say — not in
 *     application code).
 * Neither was reachable through `KotlinFilterAllowlistGenerator`'s allowlist in a REAL request
 * (it never admitted `gt`/`gte`/`lt`/`lte` for `inet`, matching the port's own filter-op
 * semantics), but the generated Kotlin still has to COMPILE regardless of what a well-formed HTTP
 * request can reach.
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

            // See the class doc above: both AllTypesController.kt (non-Comparable field.inet
            // ordering ops) and AssetController.kt (the @dbColumnType=uuid escape hatch's
            // String/UUID mismatch) are now fixed — no exclusions.
            val emittedPaths: List<Path> = Files.walk(outDir)
                .filter { it.isRegularFile() && it.toString().endsWith(".kt") }
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

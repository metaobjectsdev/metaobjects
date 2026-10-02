package com.metaobjects.generator.kotlin.exposed1x

import com.metaobjects.generator.Generator
import com.metaobjects.generator.kotlin.KotlinExposedTableGenerator
import com.metaobjects.generator.util.GeneratedFileWriter
import com.metaobjects.metadata.ktx.loadString
import com.tschuchort.compiletesting.KotlinCompilation
import com.tschuchort.compiletesting.SourceFile
import java.nio.file.Files
import java.nio.file.Path
import kotlin.io.path.isRegularFile
import kotlin.io.path.readText
import kotlin.test.Test
import kotlin.test.assertEquals
import org.junit.jupiter.api.Assumptions.assumeTrue

/**
 * Issue #390 acceptance criterion: "the emitted custom column types round-trip through a real
 * JDBC read under 1.x." `Exposed1xCodegenCompileTest` proves the full fitness corpus COMPILES
 * against Exposed 1.3.x; this test proves the THREE hand-rolled `Meta*ColumnType` support
 * classes ([KotlinExposedTableGenerator]'s `instantTzSupportBlock` / `inetUriSupportBlock`) —
 * the ones issue #390 calls out by name as needing the `readObject(rs: RowApi, …)` signature
 * change — actually read back correctly against a real Postgres:
 *
 *  - `MetaInstantWithTimeZoneColumnType` (a `field.timestamp`, default/non-`@localTime`),
 *  - `MetaUriColumnType` (`field.uri`),
 *  - `MetaInetColumnType` (`field.inet`),
 *
 * plus a `javaUUID`-generated PK (`field.uuid` + `@generation: uuid`), the issue's other named
 * acceptance point. A tiny PURPOSE-BUILT fixture (not the shared `meta.fitness.json`) keeps the
 * INSERT in the driver below to four columns instead of needing a `Settings`/`Label` value
 * object for `AllTypes`' jsonb columns — orthogonal to what this test exists to prove.
 *
 * Needs a real Postgres (via [PostgresContainer] — docker CLI, or `METAOBJECTS_TEST_PG_URL`
 * for a shared CI sidecar). Per issue #390's own instruction ("if it cannot run here, say so
 * explicitly rather than skipping silently"): [org.junit.jupiter.api.Assumptions.assumeTrue]
 * marks the test SKIPPED (not green, not silently absent) in the surefire report with a named
 * reason when neither is available.
 */
@OptIn(org.jetbrains.kotlin.compiler.plugin.ExperimentalCompilerApi::class)
class Exposed1xRoundTripTest {

    private val fixtureJson = """
        {
          "metadata.root": {
            "package": "exposed1xprobe",
            "children": [
              { "object.entity": {
                "name": "RoundTripProbe",
                "children": [
                  { "source.rdb": { "@table": "round_trip_probe" } },
                  { "field.uuid":      { "name": "id" } },
                  { "field.timestamp": { "name": "createdAt", "@required": true } },
                  { "field.uri":       { "name": "homepage",  "@required": true } },
                  { "field.inet":      { "name": "address",   "@required": true } },
                  { "identity.primary": { "name": "id", "@fields": "id", "@generation": "uuid" } }
                ]
              }}
            ]
          }
        }
    """.trimIndent()

    private val driverSource = """
        package exposed1x.driver

        import java.net.InetAddress
        import java.net.URI
        import java.time.Instant
        import org.jetbrains.exposed.v1.core.eq
        import org.jetbrains.exposed.v1.jdbc.Database
        import org.jetbrains.exposed.v1.jdbc.SchemaUtils
        import org.jetbrains.exposed.v1.jdbc.insert
        import org.jetbrains.exposed.v1.jdbc.selectAll
        import org.jetbrains.exposed.v1.jdbc.transactions.transaction
        import exposed1xprobe.RoundTripProbeTable

        /**
         * Runs entirely against the DYNAMICALLY-compiled exposedApi=1 output (compiled by
         * kctfork's embedded >= 2.2 compiler, never this module's own 2.0.21 toolchain — see
         * the class doc on [com.metaobjects.generator.kotlin.exposed1x.Exposed1xRoundTripTest]).
         * Returns "OK" or a "MISMATCH: ..." string rather than throwing, so a failure surfaces
         * as a normal assertEquals diff in the static test instead of an opaque
         * InvocationTargetException stack.
         */
        fun runRoundTrip(jdbcUrl: String, user: String, pass: String): String {
            Database.connect(jdbcUrl, user = user, password = pass)
            return transaction {
                SchemaUtils.create(RoundTripProbeTable)

                val wantCreatedAt = Instant.parse("2026-01-01T12:34:56.789Z")
                val wantHomepage = URI.create("https://example.com/path?q=1")
                val wantAddress = InetAddress.getByName("192.168.1.42")

                val insertedId = RoundTripProbeTable.insert {
                    it[RoundTripProbeTable.createdAt] = wantCreatedAt
                    it[RoundTripProbeTable.homepage] = wantHomepage
                    it[RoundTripProbeTable.address] = wantAddress
                }[RoundTripProbeTable.id]

                val row = RoundTripProbeTable.selectAll()
                    .where { RoundTripProbeTable.id eq insertedId }
                    .single()
                val gotCreatedAt = row[RoundTripProbeTable.createdAt]
                val gotHomepage = row[RoundTripProbeTable.homepage]
                val gotAddress = row[RoundTripProbeTable.address]

                val problems = mutableListOf<String>()
                if (gotCreatedAt != wantCreatedAt) problems += "createdAt: want=${'$'}wantCreatedAt got=${'$'}gotCreatedAt"
                if (gotHomepage != wantHomepage) problems += "homepage: want=${'$'}wantHomepage got=${'$'}gotHomepage"
                if (gotAddress.hostAddress != wantAddress.hostAddress) {
                    problems += "address: want=${'$'}{wantAddress.hostAddress} got=${'$'}{gotAddress.hostAddress}"
                }

                if (problems.isEmpty()) "OK" else "MISMATCH: " + problems.joinToString("; ")
            }
        }
    """.trimIndent()

    @Test
    fun `exposedApi=1 custom column types round-trip through real Postgres`() {
        assumeTrue(
            PostgresContainer.dockerAvailable(),
            "SKIPPED (not silently — see surefire report): no docker daemon and no " +
                "METAOBJECTS_TEST_PG_URL sidecar; issue #390's round-trip proof needs a real " +
                "Postgres (gen_random_uuid() PK default, TIMESTAMP WITH TIME ZONE, native inet).",
        )

        val outDir = Files.createTempDirectory("exposed1x-roundtrip-")
        try {
            val loader = loadString("exposed1x-roundtrip-probe", fixtureJson)

            val generators: List<Pair<String, Generator>> = listOf(
                "KotlinExposedTableGenerator" to KotlinExposedTableGenerator(),
            )
            GeneratedFileWriter.beginRun().use { run ->
                for ((name, gen) in generators) {
                    run.attributeTo(name)
                    gen.setArgs(mapOf(
                        "outputDir" to outDir.toString(),
                        "exposedApi" to "1",
                    ))
                    gen.execute(loader)
                }
            }

            val emittedPaths: List<Path> = Files.walk(outDir)
                .filter { it.isRegularFile() && it.toString().endsWith(".kt") }
                .toList()
            val sources = emittedPaths.map { SourceFile.kotlin(it.fileName.toString(), it.readText()) } +
                SourceFile.kotlin("Driver.kt", driverSource)

            val compileResult = KotlinCompilation().apply {
                this.sources = sources
                inheritClassPath = true
                messageOutputStream = System.out
            }.compile()
            assertEquals(KotlinCompilation.ExitCode.OK, compileResult.exitCode,
                "round-trip probe + driver failed to compile against Exposed 1.3.x:\n${compileResult.messages}")

            PostgresContainer().use { pg ->
                val driverClass = compileResult.classLoader.loadClass("exposed1x.driver.DriverKt")
                val method = driverClass.getMethod(
                    "runRoundTrip", String::class.java, String::class.java, String::class.java)
                val verdict = method.invoke(null, pg.jdbcUrl, pg.username, pg.password) as String
                assertEquals("OK", verdict)
            }
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }
}

package com.metaobjects.generator.kotlin.exposed1x

import com.metaobjects.generator.kotlin.KotlinExposedTableGenerator
import com.metaobjects.metadata.ktx.loadString
import com.tschuchort.compiletesting.KotlinCompilation
import com.tschuchort.compiletesting.SourceFile
import java.nio.file.Files
import kotlin.io.path.isRegularFile
import kotlin.io.path.readText
import kotlin.test.Test
import kotlin.test.assertEquals
import org.junit.jupiter.api.Assumptions.assumeTrue

/**
 * #544 on the Exposed 1.x line: `identity.primary @sequenceStart: 1000` compiles against
 * exposed-core 1.3.x (`Sequence` from `v1.core`) and `SchemaUtils.create` begins the key at 1000 on
 * Postgres. The 0.x twin lives in `integration-tests-kotlin`. Forward-only: no migration path here.
 */
@OptIn(org.jetbrains.kotlin.compiler.plugin.ExperimentalCompilerApi::class)
class Exposed1xSequenceStartTest {

    private val fixtureJson = """{
      "metadata.root": { "package": "acme::demo", "children": [
        { "object.entity": { "name": "Ticket", "children": [
            { "field.long":   { "name": "id" } },
            { "field.string": { "name": "title", "@maxLength": 100 } },
            { "source.rdb":   { "@table": "tickets" } },
            { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment", "@sequenceStart": 1000 } }
        ] } }
      ] }
    }""".trimIndent()

    private val driverSource = """
        package acme.demo

        import org.jetbrains.exposed.v1.jdbc.Database
        import org.jetbrains.exposed.v1.jdbc.SchemaUtils
        import org.jetbrains.exposed.v1.jdbc.insert
        import org.jetbrains.exposed.v1.jdbc.selectAll
        import org.jetbrains.exposed.v1.jdbc.transactions.transaction

        fun firstId(jdbcUrl: String, user: String, pass: String): Long {
            Database.connect(jdbcUrl, user = user, password = pass)
            return transaction {
                SchemaUtils.create(TicketTable)
                TicketTable.insert { it[TicketTable.title] = "first" }
                TicketTable.selectAll().map { it[TicketTable.id] }.min()
            }
        }
    """.trimIndent()

    @Test
    fun `exposedApi=1 sequence start compiles and begins the key at the declared start`() {
        assumeTrue(
            PostgresContainer.dockerAvailable(),
            "SKIPPED (not silently): no docker daemon and no METAOBJECTS_TEST_PG_URL sidecar.",
        )
        val outDir = Files.createTempDirectory("exposed1x-seq-")
        try {
            val gen = KotlinExposedTableGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString(), "exposedApi" to "1"))
            gen.execute(loadString("exposed1x-seq", fixtureJson))
            val sources = Files.walk(outDir).filter { it.isRegularFile() && it.toString().endsWith(".kt") }
                .toList().map { SourceFile.kotlin(it.fileName.toString(), it.readText()) } +
                SourceFile.kotlin("Driver.kt", driverSource)
            val compiled = KotlinCompilation().apply {
                this.sources = sources
                inheritClassPath = true
            }.compile()
            assertEquals(KotlinCompilation.ExitCode.OK, compiled.exitCode, compiled.messages)

            PostgresContainer().use { pg ->
                val m = compiled.classLoader.loadClass("acme.demo.DriverKt").getMethod(
                    "firstId", String::class.java, String::class.java, String::class.java)
                assertEquals(1000L, m.invoke(null, pg.jdbcUrl, pg.username, pg.password) as Long)
            }
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }
}

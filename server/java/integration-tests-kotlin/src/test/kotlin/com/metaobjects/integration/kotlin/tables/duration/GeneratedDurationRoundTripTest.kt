package com.metaobjects.integration.kotlin.tables.duration

import com.metaobjects.generator.kotlin.KotlinEntityGenerator
import com.metaobjects.generator.kotlin.KotlinExposedTableGenerator
import com.metaobjects.integration.kotlin.PostgresContainer
import com.metaobjects.metadata.ktx.loadString
import com.tschuchort.compiletesting.KotlinCompilation
import com.tschuchort.compiletesting.SourceFile
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Files
import java.nio.file.Path
import kotlin.io.path.isRegularFile
import kotlin.io.path.readText
import kotlin.test.assertEquals

/**
 * The GENERATED (exposedApi=0) `field.duration` columns, compiled and run: a scalar and an
 * `isArray` duration round-trip, a range filter and a sort order spans (never text), on SQLite (a
 * BIGINT microsecond count, a JSON array of counts) and Postgres (INTERVAL, INTERVAL[]).
 */
@OptIn(org.jetbrains.kotlin.compiler.plugin.ExperimentalCompilerApi::class)
class GeneratedDurationRoundTripTest {

    private val fixture = """{
      "metadata.root": { "package": "durdemo", "children": [
        { "object.entity": { "name": "Timer", "children": [
            { "source.rdb":     { "@table": "timers" } },
            { "field.long":     { "name": "id", "@required": true } },
            { "field.duration": { "name": "timeout", "@required": true } },
            { "field.duration": { "name": "backoff", "isArray": true } },
            { "identity.primary": { "name": "id", "@fields": "id" } }
        ] } }
      ] }
    }""".trimIndent()

    private val driverSource = """
        package durdemo

        import org.jetbrains.exposed.sql.Database
        import org.jetbrains.exposed.sql.SchemaUtils
        import org.jetbrains.exposed.sql.SortOrder
        import org.jetbrains.exposed.sql.insert
        import org.jetbrains.exposed.sql.selectAll
        import org.jetbrains.exposed.sql.transactions.TransactionManager
        import org.jetbrains.exposed.sql.transactions.transaction
        import java.time.Duration

        object DurationRoundTripDriver {
            fun run(jdbcUrl: String, driver: String, user: String, pass: String): String {
                val db = Database.connect(jdbcUrl, driver = driver, user = user, password = pass)
                return transaction(db) {
                    SchemaUtils.create(TimerTable)
                    val spans = mapOf(
                        1L to Duration.ofMinutes(30),
                        2L to Duration.ofMinutes(90),
                        3L to Duration.ofSeconds(-90, -500_000_000),
                        4L to Duration.ofHours(26),
                    )
                    for ((id, d) in spans) {
                        TimerTable.insert {
                            it[TimerTable.id] = id
                            it[TimerTable.timeout] = d
                            it[TimerTable.backoff] = listOf(d, Duration.ofNanos(1_000))
                        }
                    }
                    val longer = TimerTable.selectAll()
                        .where { TimerTable.timeout greater Duration.ofHours(1) }
                        .orderBy(TimerTable.timeout, SortOrder.DESC)
                        .map { it[TimerTable.id] }
                    val all = TimerTable.selectAll().orderBy(TimerTable.timeout, SortOrder.ASC).map { it[TimerTable.id] }
                    val r3 = TimerTable.selectAll().where { TimerTable.id eq 3L }.single()
                    val problems = mutableListOf<String>()
                    if (longer != listOf(4L, 2L)) problems += "gt + desc: " + longer
                    if (all != listOf(3L, 1L, 2L, 4L)) problems += "asc: " + all
                    if (r3[TimerTable.timeout] != spans.getValue(3L)) problems += "timeout: " + r3[TimerTable.timeout]
                    if (r3[TimerTable.backoff] != listOf(spans.getValue(3L), Duration.ofNanos(1_000))) problems += "backoff: " + r3[TimerTable.backoff]
                    if (!jdbcUrl.startsWith("jdbc:postgresql")) {
                        var kind: String? = null
                        TransactionManager.current().exec("SELECT typeof(timeout), timeout FROM timers WHERE id = 3") { rs ->
                            rs.next(); kind = rs.getString(1) + " " + rs.getString(2)
                        }
                        if (kind != "integer -90500000") problems += "stored: " + kind
                    }
                    if (problems.isEmpty()) "OK" else problems.joinToString("; ")
                }
            }
        }
    """.trimIndent()

    private fun compileDriver(): ClassLoader {
        val outDir = Files.createTempDirectory("duration-rt-")
        try {
            val loader = loadString("duration-rt", fixture)
            for (g in listOf(KotlinEntityGenerator(), KotlinExposedTableGenerator())) {
                g.setArgs(mapOf("outputDir" to outDir.toString()))
                g.execute(loader)
            }
            val sources = Files.walk(outDir).use { s ->
                s.filter { it.isRegularFile() && it.toString().endsWith(".kt") }
                    .map { SourceFile.kotlin(outDir.relativize(it).toString().replace('/', '_'), it.readText()) }
                    .toList()
            }.toMutableList()
            sources.add(SourceFile.kotlin("DurationRoundTripDriver.kt", driverSource))
            val result = KotlinCompilation().apply {
                this.sources = sources
                inheritClassPath = true
                messageOutputStream = System.out
            }.compile()
            assertEquals(KotlinCompilation.ExitCode.OK, result.exitCode, result.messages)
            return result.classLoader
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    private fun drive(cl: ClassLoader, url: String, driver: String, user: String, pass: String): String {
        val cls = cl.loadClass("durdemo.DurationRoundTripDriver")
        return cls.getMethod("run", String::class.java, String::class.java, String::class.java, String::class.java)
            .invoke(cls.getField("INSTANCE").get(null), url, driver, user, pass) as String
    }

    @Test
    fun `generated duration columns order and round-trip on SQLite`(@TempDir dir: Path) {
        assertEquals("OK", drive(compileDriver(), "jdbc:sqlite:${dir.resolve("d.db")}", "org.sqlite.JDBC", "", ""))
    }

    @Test
    fun `generated duration columns order and round-trip on Postgres`() {
        val cl = compileDriver()
        PostgresContainer().use { pg ->
            assertEquals("OK", drive(cl, pg.jdbcUrl, "org.postgresql.Driver", pg.username, pg.password))
        }
    }
}

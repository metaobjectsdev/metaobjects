package com.metaobjects.integration.kotlin.tables.jsonb

import com.metaobjects.generator.kotlin.KotlinEntityGenerator
import com.metaobjects.generator.kotlin.KotlinExposedTableGenerator
import com.metaobjects.integration.kotlin.PostgresContainer
import com.metaobjects.metadata.ktx.loadString
import com.tschuchort.compiletesting.KotlinCompilation
import com.tschuchort.compiletesting.SourceFile
import org.junit.jupiter.api.Test
import java.nio.file.Files
import kotlin.io.path.isRegularFile
import kotlin.io.path.readText
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * The gate that was missing (the hole that let the broken kotlinx `VO.serializer()` jsonb form
 * ship): a **compile + run** proof of the GENERATED typed-`field.object @storage:jsonb` Exposed
 * table against a real Testcontainers Postgres. Before this, only a string-assert snapshot gated the
 * generated form — so a codec that needs the kotlinx-serialization compiler plugin (and would break
 * every entity carrying a `UUID`/`Instant`/… field the moment that plugin is enabled) passed review.
 *
 * What this proves end-to-end:
 *  1. The generated entity/value data classes carry NO `@Serializable`, and the generated
 *     `DemoTable`'s typed jsonb columns use the shared Jackson `metaJsonbMapper` (MetaJsonbMapper.kt
 *     support file) — so the whole generated bundle **compiles via kctfork with NO serialization
 *     compiler plugin** (`inheritClassPath = true` only). That is the point: the Jackson codec has
 *     zero per-type plumbing and needs no plugin, even though the entity carries `UUID` + `Instant`
 *     scalar fields that a kotlinx serializer could not resolve.
 *  2. A single-VO jsonb column AND an array-of-VO jsonb column (`@isArray`) encode → persist → read
 *     back byte-faithfully through Exposed against real Postgres JSONB, including the empty-array
 *     (`[]` ≠ null) and null cases.
 *
 * Mechanism mirrors [com.metaobjects.integration.kotlin.api.generated] harnesses: generate → compile
 * (generated sources + a tiny type-safe round-trip driver, same package) → invoke the driver against
 * a fresh Postgres container.
 */
@OptIn(org.jetbrains.kotlin.compiler.plugin.ExperimentalCompilerApi::class)
class GeneratedTypedJsonbRoundTripTest {

    /**
     * package `demo`: two value objects (`Settings`, `Label`) + an entity `Demo` whose columns
     * include a UUID PK, an `Instant` timestamp, a single-VO jsonb (`settings`), and an
     * array-of-VO jsonb (`labels`, `@isArray`). The UUID/Instant scalars are exactly the fields a
     * kotlinx `.serializer()` could not resolve — so their presence is the compile-time proof.
     */
    private val fixture = """{
      "metadata.root": { "package": "demo", "children": [
        { "object.value": { "name": "Settings", "children": [
            { "field.string": { "name": "theme" } },
            { "field.int":    { "name": "retries" } }
        ] } },
        { "object.value": { "name": "Label", "children": [
            { "field.string": { "name": "key" } },
            { "field.int":    { "name": "weight" } }
        ] } },
        { "object.entity": { "name": "Demo", "children": [
            { "source.rdb":   { "@table": "demo" } },
            { "field.uuid":      { "name": "id", "@required": true } },
            { "field.timestamp": { "name": "createdAt", "@required": true } },
            { "field.object":    { "name": "settings", "@objectRef": "Settings", "@storage": "jsonb" } },
            { "field.object":    { "name": "labels", "@objectRef": "Label", "@storage": "jsonb", "isArray": true } },
            { "identity.primary": { "name": "id", "@fields": "id" } }
        ] } }
      ] }
    }""".trimIndent()

    /**
     * A type-safe round-trip driver compiled ALONGSIDE the generated sources (same `demo` package),
     * so it references the generated `DemoTable` / `Settings` / `Label` directly — no reflection into
     * the typed columns. Returns "OK" on a clean round-trip, else a diagnostic string.
     */
    private val driverSource = """
        package demo

        import org.jetbrains.exposed.sql.Database
        import org.jetbrains.exposed.sql.SchemaUtils
        import org.jetbrains.exposed.sql.insert
        import org.jetbrains.exposed.sql.selectAll
        import org.jetbrains.exposed.sql.transactions.transaction
        import java.time.Instant
        import java.util.UUID

        object TypedJsonbRoundTripDriver {
            fun run(jdbcUrl: String, user: String, pass: String): String {
                val db = Database.connect(jdbcUrl, driver = "org.postgresql.Driver", user = user, password = pass)
                return transaction(db) {
                    SchemaUtils.create(DemoTable)

                    val ts = Instant.parse("2020-01-02T03:04:05Z")

                    // Row 1: a 2-element array-of-VO + a single VO.
                    val id1 = UUID.randomUUID()
                    val settings1 = Settings(theme = "dark", retries = 3)
                    val labels1 = listOf(Label(key = "alpha", weight = 10), Label(key = "beta", weight = 20))
                    DemoTable.insert {
                        it[DemoTable.id] = id1
                        it[DemoTable.createdAt] = ts
                        it[DemoTable.settings] = settings1
                        it[DemoTable.labels] = labels1
                    }

                    // Row 2: an EMPTY array must round-trip as [] (distinct from null).
                    val id2 = UUID.randomUUID()
                    DemoTable.insert {
                        it[DemoTable.id] = id2
                        it[DemoTable.createdAt] = ts
                        it[DemoTable.settings] = Settings(theme = "light", retries = 0)
                        it[DemoTable.labels] = emptyList()
                    }

                    // Row 3: null jsonb columns stay null.
                    val id3 = UUID.randomUUID()
                    DemoTable.insert {
                        it[DemoTable.id] = id3
                        it[DemoTable.createdAt] = ts
                        it[DemoTable.settings] = null
                        it[DemoTable.labels] = null
                    }

                    val r1 = DemoTable.selectAll().where { DemoTable.id eq id1 }.single()
                    val r2 = DemoTable.selectAll().where { DemoTable.id eq id2 }.single()
                    val r3 = DemoTable.selectAll().where { DemoTable.id eq id3 }.single()

                    when {
                        r1[DemoTable.settings] != settings1 -> "settings mismatch: got ${'$'}{r1[DemoTable.settings]}"
                        r1[DemoTable.labels] != labels1 -> "labels mismatch: got ${'$'}{r1[DemoTable.labels]}"
                        r1[DemoTable.createdAt] != ts -> "timestamp mismatch: got ${'$'}{r1[DemoTable.createdAt]}"
                        r2[DemoTable.labels] == null -> "empty array read back as null (must stay [])"
                        r2[DemoTable.labels] != emptyList<Label>() -> "empty-array mismatch: got ${'$'}{r2[DemoTable.labels]}"
                        r3[DemoTable.labels] != null -> "null labels not null: got ${'$'}{r3[DemoTable.labels]}"
                        r3[DemoTable.settings] != null -> "null settings not null: got ${'$'}{r3[DemoTable.settings]}"
                        else -> "OK"
                    }
                }
            }
        }
    """.trimIndent()

    @Test
    fun `generated typed-jsonb table compiles without the serialization plugin and round-trips against Postgres`() {
        val outDir = Files.createTempDirectory("typed-jsonb-rt-")
        try {
            val loader = loadString("typed-jsonb-rt", fixture)
            for (g in listOf(KotlinEntityGenerator(), KotlinExposedTableGenerator())) {
                g.setArgs(mapOf("outputDir" to outDir.toString()))
                g.execute(loader)
            }

            // The generated entity/value classes must be plain (Jackson) — NO kotlinx @Serializable —
            // and the table's typed jsonb columns must use the shared Jackson metaJsonbMapper.
            val demoEntity = outDir.resolve("demo/Demo.kt").readText()
            assertFalse("@Serializable" in demoEntity, "generated entity must carry NO @Serializable:\n$demoEntity")
            val demoTable = outDir.resolve("demo/DemoTable.kt").readText()
            assertTrue("metaJsonbMapper.writeValueAsString" in demoTable,
                "generated table must use the Jackson metaJsonbMapper codec:\n$demoTable")
            assertTrue("import kotlinx.serialization.json.Json" !in demoTable,
                "typed-VO jsonb columns must NOT drag in kotlinx Json:\n$demoTable")
            assertTrue(Files.exists(outDir.resolve("demo/MetaJsonbMapper.kt")),
                "expected the per-package MetaJsonbMapper.kt support file")

            // Compile every generated source + the round-trip driver. inheritClassPath only — NO
            // serialization compiler plugin. This is the gate: the OLD `VO.serializer()` form would
            // fail here (unresolved serializer / plugin required).
            val sources = Files.walk(outDir).use { s ->
                s.filter { it.isRegularFile() && it.toString().endsWith(".kt") }
                    .map { SourceFile.kotlin(outDir.relativize(it).toString().replace('/', '_'), it.readText()) }
                    .toList()
            }.toMutableList()
            sources.add(SourceFile.kotlin("TypedJsonbRoundTripDriver.kt", driverSource))

            val result = KotlinCompilation().apply {
                this.sources = sources
                inheritClassPath = true
                messageOutputStream = System.out
            }.compile()
            assertEquals(KotlinCompilation.ExitCode.OK, result.exitCode,
                "generated typed-jsonb table (Jackson codec, no @Serializable) failed to compile " +
                    "WITHOUT the kotlinx serialization plugin:\n${result.messages}")

            // Round-trip against a real Postgres (JSONB) via the compiled driver.
            PostgresContainer().use { pg ->
                val driver = result.classLoader.loadClass("demo.TypedJsonbRoundTripDriver")
                val instance = driver.getField("INSTANCE").get(null)
                val outcome = driver
                    .getMethod("run", String::class.java, String::class.java, String::class.java)
                    .invoke(instance, pg.jdbcUrl, pg.username, pg.password) as String
                assertEquals("OK", outcome,
                    "generated Jackson typed-jsonb codec failed its Postgres round-trip: $outcome")
            }
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }
}

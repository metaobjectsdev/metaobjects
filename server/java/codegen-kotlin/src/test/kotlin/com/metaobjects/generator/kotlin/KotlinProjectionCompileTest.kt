package com.metaobjects.generator.kotlin

import com.metaobjects.metadata.ktx.loadString
import com.tschuchort.compiletesting.KotlinCompilation
import com.tschuchort.compiletesting.SourceFile
import java.nio.file.Files
import kotlin.io.path.isRegularFile
import kotlin.io.path.readText
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Cross-port guard for the projection-codegen bug class fixed in TypeScript PR #80
 * (`835d6be4` — "fix projection/driver-type codegen"). That PR's root symptom was a
 * read/write inconsistency in a projection's generated artifacts: the read-only
 * projection emitted output that referenced a write-shaped member that the read-only
 * surface never declared, so the build broke and the agent reverted to hand-rolling.
 * Its robust complement (`server/typescript/.../projection/compile.test.ts`) actually
 * COMPILES the generated projection — so any read-only/writable inconsistency that
 * produces non-compiling output is caught, not just the one symptom we already knew.
 *
 * The C# port compiles its generated projection code; TS and Python now do too. This
 * is the Kotlin equivalent: it runs an `object.projection` carrying a REQUIRED
 * pass-through id AND a NON-required derived aggregate field — the exact shape that
 * exposed the nullable-view-column vs non-null-read-type mismatch in TS — through
 * `KotlinEntityGenerator` (immutable `data class`) + `KotlinExposedTableGenerator`
 * (read-only Exposed `Table`), then COMPILES the emitted Kotlin with the real Kotlin
 * compiler (kotlin-compile-testing, as [KotlinOutputCompilesTest] does). A nullable
 * column whose data-class read type was non-null (or vice-versa), or any other
 * read/write inconsistency, fails to compile here.
 *
 * It also asserts the read-only structural contract directly — the entity is an
 * immutable `data class` (no `var`), the projection's Exposed table carries the
 * READ-ONLY VIEW guard with no `.autoIncrement()`/`.references(...)`, and the
 * write-surface generators (controller / validator / filter-allowlist) SKIP the
 * projection entirely (they only emit for `object.entity`).
 *
 * Scope of the true compile: this module's test classpath carries kotlinx.serialization
 * (so `@Serializable` data classes resolve) but NOT jetbrains-exposed, so the emitted
 * `*Table.kt` files cannot be compiled here (the existing [KotlinOutputCompilesTest]
 * likewise only compiles data-class / payload output, never an Exposed table). We
 * therefore COMPILE the read-side projection data class — which is exactly the surface
 * the PR-#80 nullable-vs-non-null read-type mismatch lives on — and assert the Exposed
 * table's read-only-ness + nullable-column/read-type consistency structurally.
 */
@OptIn(org.jetbrains.kotlin.compiler.plugin.ExperimentalCompilerApi::class)
class KotlinProjectionCompileTest {

    // Program (writable base) + Week (the to-many target) + a ProgramSummary
    // projection over a read-only view. `id` is a REQUIRED pass-through pk;
    // `weekCount` is a NON-required derived aggregate → its view column is
    // nullable, so the data-class read type must be nullable too. This is the
    // PR-#80 nullable-column-vs-non-null-read-type case.
    private val projectionFixture = """{
      "metadata.root": { "package": "acme::commerce", "children": [
        { "object.entity": { "name": "Program", "children": [
            { "field.long":   { "name": "id" } },
            { "field.string": { "name": "title", "@required": true } },
            { "source.rdb":   { "@table": "programs" } },
            { "identity.primary": { "name": "id", "@fields": "id", "@generation": "increment" } },
            { "relationship.association": { "name": "weeks", "@objectRef": "Week", "@cardinality": "many" } }
        ] } },
        { "object.entity": { "name": "Week", "children": [
            { "field.long": { "name": "id" } },
            { "field.long": { "name": "programId" } },
            { "source.rdb": { "@table": "weeks" } },
            { "identity.primary":   { "name": "id", "@fields": "id", "@generation": "increment" } },
            { "identity.reference": { "name": "ref_program", "@fields": "programId", "@references": "Program" } }
        ] } },
        { "object.projection": { "name": "ProgramSummary", "children": [
            { "source.rdb": { "@kind": "view", "@view": "v_program_summary" } },
            { "field.long":   { "name": "id",    "extends": "acme::commerce::Program.id", "@required": true } },
            { "field.string": { "name": "title", "children": [
                { "origin.passthrough": { "@from": "acme::commerce::Program.title" } }
            ] } },
            { "field.int": { "name": "weekCount", "children": [
                { "origin.aggregate": { "@agg": "count", "@of": "Week.id", "@via": "Program.weeks" } }
            ] } },
            { "identity.primary": { "name": "id", "extends": "acme::commerce::Program.id" } }
        ] } }
      ] }
    }""".trimIndent()

    @Test fun `projection entity data class plus Exposed table compile and are read-only`() {
        val outDir = Files.createTempDirectory("kproj-compile-")
        try {
            val loader = loadString("projection-compile", projectionFixture)

            // Run BOTH the entity (data class) and the Exposed table generator into one tree.
            for (gen in listOf(KotlinEntityGenerator(), KotlinExposedTableGenerator())) {
                gen.setArgs(mapOf("outputDir" to outDir.toString()))
                gen.execute(loader)
            }

            val summaryKt = outDir.resolve("acme/commerce/ProgramSummary.kt")
            val summaryTableKt = outDir.resolve("acme/commerce/ProgramSummaryTable.kt")
            assertTrue(Files.exists(summaryKt),
                "expected projection data class $summaryKt; files=${Files.walk(outDir).toList()}")
            assertTrue(Files.exists(summaryTableKt),
                "expected projection Exposed table $summaryTableKt; files=${Files.walk(outDir).toList()}")

            val summarySrc = Files.readString(summaryKt)
            val tableSrc = Files.readString(summaryTableKt)

            // --- Read-only structural contract on the data class ---
            assertTrue("data class ProgramSummary" in summarySrc,
                "projection must be an immutable data class; saw:\n$summarySrc")
            // Immutable: no mutable `var` properties anywhere in the read-only projection.
            assertFalse(Regex("""\bvar\s+\w""").containsMatchIn(summarySrc),
                "projection data class must be immutable (no `var`); saw:\n$summarySrc")
            // The NON-required derived aggregate must read as a nullable type — the
            // PR-#80 mismatch is exactly a non-null read type over a nullable view column.
            assertTrue("val weekCount: Int? = null" in summarySrc,
                "non-required derived `weekCount` must be nullable (`Int? = null`); saw:\n$summarySrc")

            // --- Read-only structural contract on the Exposed table ---
            assertTrue("READ-ONLY VIEW" in tableSrc,
                "projection table must carry the READ-ONLY VIEW guard; saw:\n$tableSrc")
            assertTrue("object ProgramSummaryTable : Table(\"v_program_summary\")" in tableSrc,
                "projection table must bind to the @view physical name; saw:\n$tableSrc")
            // Views are read-only: no auto-increment, no FK constraints on the view body.
            assertFalse(".autoIncrement()" in tableSrc,
                "projection (view) columns must NOT use .autoIncrement(); saw:\n$tableSrc")
            assertFalse(".references(" in tableSrc,
                "projection (view) must NOT emit FK .references(...); saw:\n$tableSrc")
            // The nullable view column for the non-required aggregate matches the nullable
            // read type above (the two-sided consistency PR #80 was about).
            assertTrue("val weekCount = integer(\"week_count\").nullable()" in tableSrc,
                "weekCount view column must be nullable, matching its nullable read type; saw:\n$tableSrc")

            // --- TRUE Kotlin compile of the generated projection DATA CLASSES ---
            // Exposed is not on this module's test classpath, so we compile the read-side
            // data classes (the `*.kt` entity/projection files, NOT the `*Table.kt` files).
            // The projection data class is precisely the surface the PR-#80 nullable read-type
            // mismatch lives on: a non-null read type over a nullable view column fails here.
            val dataClassPaths = Files.walk(outDir).filter { it.isRegularFile() }
                .filter { !it.fileName.toString().endsWith("Table.kt") }
                .toList()
            assertTrue(dataClassPaths.any { it.fileName.toString() == "ProgramSummary.kt" },
                "expected the projection data class to be among the compiled sources")
            val dataClassSources = dataClassPaths.map { path ->
                SourceFile.kotlin(
                    path.parent.relativize(path).toString().replace('/', '_'),
                    path.readText(),
                )
            }

            val result = KotlinCompilation().apply {
                this.sources = dataClassSources
                inheritClassPath = true   // brings kotlinx.serialization onto the classpath
                messageOutputStream = System.out
            }.compile()

            assertEquals(KotlinCompilation.ExitCode.OK, result.exitCode,
                "generated projection Kotlin data classes failed to compile:\n${result.messages}")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    @Test fun `write-surface generators skip the projection`() {
        val outDir = Files.createTempDirectory("kproj-skip-")
        try {
            val loader = loadString("projection-skip", projectionFixture)

            // Controller / validator / filter-allowlist generators only emit for
            // object.entity — they must NOT produce any artifact for the projection.
            for (gen in listOf(
                KotlinSpringControllerGenerator(),
                KotlinValidatorGenerator(),
                KotlinFilterAllowlistGenerator(),
            )) {
                // packageName is required by the validator generator (it emits a
                // package-level startup-validator stub regardless of entity count).
                gen.setArgs(mapOf(
                    "outputDir" to outDir.toString(),
                    "packageName" to "acme.commerce",
                ))
                gen.execute(loader)
            }

            val emitted = if (Files.exists(outDir)) {
                Files.walk(outDir).filter { it.isRegularFile() }
                    .map { it.fileName.toString() }.toList()
            } else emptyList()

            // No projection-named write-surface artifact may exist.
            assertFalse(emitted.any { it.startsWith("ProgramSummary") },
                "write-surface generators must SKIP the projection; emitted=$emitted")
            // Specifically: no controller / validator / filter-allowlist for the projection.
            for (suffix in listOf("Controller.kt", "Validator.kt", "FilterAllowlist.kt")) {
                assertFalse(Files.exists(outDir.resolve("acme/commerce/ProgramSummary$suffix")),
                    "must NOT emit ProgramSummary$suffix for a read-only projection; emitted=$emitted")
            }
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }
}

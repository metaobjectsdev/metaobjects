package com.metaobjects.generator.kotlin

import com.metaobjects.metadata.ktx.loadString
import com.tschuchort.compiletesting.KotlinCompilation
import com.tschuchort.compiletesting.SourceFile
import java.nio.file.Files
import java.nio.file.Paths
import kotlin.io.path.isRegularFile
import kotlin.io.path.readText
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Issue #203 — the generated Exposed repository must honor `field.timestamp @autoSet:
 * onCreate|onUpdate` so adopters stop hand-writing `now()` in every repository. The owner
 * contract (itself an adopter's Kotlin/Exposed generator):
 *
 *  - **insert** stamps EVERY onCreate AND onUpdate column with `now()` — the dto value is
 *    ignored (a fresh row's `updatedAt` equals its `createdAt`);
 *  - **update(dto)** stamps onUpdate with `now()` and SKIPS onCreate entirely — it never
 *    rewrites `createdAt` from the dto's (possibly stale) value (the latent lost-update bug);
 *  - **patch(id){…}** stamps onUpdate BEFORE the caller's block, so a partial update still
 *    bumps `updatedAt`;
 *  - **insertPreserving(dto)** — an escape hatch writing the `@autoSet` columns verbatim
 *    (import/restore/replication), emitted ONLY for entities that declare `@autoSet` fields;
 *  - `now()` is keyed off the COLUMN's temporal type, so it generalizes beyond `Instant`.
 *
 * These are the fast string gates; the last test compiles the generated repository (+ its
 * entity/table) against Exposed, so the emitted stamping is proven to be valid Kotlin.
 */
@OptIn(org.jetbrains.kotlin.compiler.plugin.ExperimentalCompilerApi::class)
class KotlinAutoSetStampingTest {

    /**
     * `Event` declares both `@autoSet` policies on `field.timestamp` columns; `Note` declares
     * none (the baseline that must stay byte-identical to the pre-#203 output).
     */
    private val autoSetFixture = """{
      "metadata.root": { "package": "acme::events", "children": [
        { "object.entity": { "name": "Event", "children": [
            { "source.rdb":      { "@table": "events" } },
            { "field.long":      { "name": "id" } },
            { "field.string":    { "name": "name", "@required": true, "@maxLength": 120 } },
            { "field.timestamp": { "name": "createdAt", "@autoSet": "onCreate" } },
            { "field.timestamp": { "name": "updatedAt", "@autoSet": "onUpdate" } },
            { "identity.primary": { "@fields": "id", "@generation": "increment" } }
        ] } },
        { "object.entity": { "name": "Note", "children": [
            { "source.rdb":      { "@table": "notes" } },
            { "field.long":      { "name": "id" } },
            { "field.string":    { "name": "title", "@required": true, "@maxLength": 200 } },
            { "field.string":    { "name": "body" } },
            { "identity.primary": { "@fields": "id", "@generation": "increment" } }
        ] } }
      ] }
    }""".trimIndent()

    /** A `field.date @autoSet: onUpdate` — proves `now()` is keyed off the column's temporal type. */
    private val dateAutoSetFixture = """{
      "metadata.root": { "package": "acme::snaps", "children": [
        { "object.entity": { "name": "Snapshot", "children": [
            { "source.rdb":      { "@table": "snapshots" } },
            { "field.long":      { "name": "id" } },
            { "field.string":    { "name": "label", "@required": true, "@maxLength": 80 } },
            { "field.date":      { "name": "takenOn", "@autoSet": "onUpdate" } },
            { "identity.primary": { "@fields": "id", "@generation": "increment" } }
        ] } }
      ] }
    }""".trimIndent()

    private fun generate(fixtureName: String, fixture: String, relPath: String): String {
        val outDir = Files.createTempDirectory("kautoset-")
        try {
            KotlinRepositoryGenerator().apply { setArgs(mapOf("outputDir" to outDir.toString())) }
                .execute(loadString(fixtureName, fixture))
            val f = outDir.resolve(relPath)
            assertTrue(Files.exists(f),
                "expected generated file $f; files=${Files.walk(outDir).toList()}")
            return Files.readString(f)
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    private fun eventRepo(): String =
        generate("autoset-event", autoSetFixture, "acme/events/EventRepositoryBase.kt")

    @Test fun `insert stamps both onCreate and onUpdate columns with now() and ignores the dto`() {
        val src = eventRepo()
        // The insert body must NOT write the @autoSet columns from the caller's dto — those are
        // owned by the stamping helper. Only the regular column (name) is a caller-value write.
        assertTrue("it[EventTable.name] = dto.name" in src,
            "insert should still write the regular caller-supplied column; saw:\n$src")
        assertTrue("it[EventTable.createdAt]" !in src,
            "@autoSet createdAt must NEVER be a caller-value (it[...]) write; saw:\n$src")
        assertTrue("it[EventTable.updatedAt]" !in src,
            "@autoSet updatedAt must NEVER be a caller-value (it[...]) write; saw:\n$src")
        // insert stamps via the shared helper (both columns → now()).
        assertTrue("open fun insert(dto: Event): Event = transaction {" in src, "no insert(); saw:\n$src")
        assertTrue("applyAutoSetColumns(it)" in src,
            "insert must stamp @autoSet columns via applyAutoSetColumns(it); saw:\n$src")
    }

    @Test fun `applyAutoSetColumns stamps now() keyed off the Instant column type`() {
        val src = eventRepo()
        assertTrue("protected open fun applyAutoSetColumns(" in src, "no stamping helper; saw:\n$src")
        assertTrue("stmt: UpdateBuilder<*>," in src, "helper must take a shared UpdateBuilder; saw:\n$src")
        // onCreate column, guarded by includeOnCreate; onUpdate column, always.
        assertTrue("if (includeOnCreate) {" in src, "onCreate write must be includeOnCreate-guarded; saw:\n$src")
        assertTrue(
            "stmt[EventTable.createdAt] = if (stampAutoSet) java.time.Instant.now() else dto!!.createdAt" in src,
            "onCreate must stamp java.time.Instant.now() (verbatim otherwise); saw:\n$src")
        assertTrue(
            "stmt[EventTable.updatedAt] = if (stampAutoSet) java.time.Instant.now() else dto!!.updatedAt" in src,
            "onUpdate must stamp java.time.Instant.now() (verbatim otherwise); saw:\n$src")
        assertTrue("import org.jetbrains.exposed.sql.statements.UpdateBuilder" in src,
            "must import UpdateBuilder for the shared stamping helper; saw:\n$src")
    }

    @Test fun `update stamps onUpdate but never rewrites the onCreate column`() {
        val src = eventRepo()
        val update = src.substringAfter("open fun update(id: Long, dto: Event)")
            .substringBefore("open fun patch(")
        assertTrue("applyAutoSetColumns(it, includeOnCreate = false)" in update,
            "update must stamp onUpdate columns with includeOnCreate = false; saw:\n$update")
        // createdAt is write-once: it appears NOWHERE in the update body (not stamped, not merged).
        assertTrue("createdAt" !in update,
            "update must never touch the onCreate column createdAt; saw:\n$update")
        assertTrue("updatedAt" !in update,
            "update must not caller-merge updatedAt — the helper owns it; saw:\n$update")
    }

    @Test fun `patch stamps onUpdate before running the caller block`() {
        val src = eventRepo()
        assertTrue("body = block" !in src,
            "an @autoSet entity's patch must not delegate straight to the block; saw:\n$src")
        assertTrue(
            "            applyAutoSetColumns(it, includeOnCreate = false)\n            this.block(it)" in src,
            "patch must stamp onUpdate BEFORE the caller's block; saw:\n$src")
    }

    @Test fun `insertPreserving writes the autoSet columns verbatim from the dto`() {
        val src = eventRepo()
        assertTrue("open fun insertPreserving(dto: Event): Event = transaction {" in src,
            "an @autoSet entity must get the insertPreserving escape hatch; saw:\n$src")
        assertTrue("applyAutoSetColumns(it, dto, stampAutoSet = false)" in src,
            "insertPreserving must write @autoSet columns verbatim (stampAutoSet = false); saw:\n$src")
    }

    @Test fun `an entity without autoSet stays byte-identical - no escape hatch, no helper`() {
        val src = generate("autoset-note", autoSetFixture, "acme/events/NoteRepositoryBase.kt")
        assertTrue("insertPreserving" !in src,
            "a non-@autoSet entity must NOT get insertPreserving; saw:\n$src")
        assertTrue("applyAutoSetColumns" !in src,
            "a non-@autoSet entity must NOT get the stamping helper; saw:\n$src")
        assertTrue("import org.jetbrains.exposed.sql.statements.UpdateBuilder" !in src,
            "a non-@autoSet repository must not import UpdateBuilder; saw:\n$src")
        // patch stays the plain body-delegating form.
        assertTrue("val n = NoteTable.update({ NoteTable.id eq id }, body = block)" in src,
            "a non-@autoSet patch must delegate straight to the block; saw:\n$src")
    }

    @Test fun `now() is keyed off the column temporal type - a date column stamps LocalDate now()`() {
        val src = generate("autoset-date", dateAutoSetFixture, "acme/snaps/SnapshotRepositoryBase.kt")
        assertTrue(
            "stmt[SnapshotTable.takenOn] = if (stampAutoSet) java.time.LocalDate.now() else dto!!.takenOn" in src,
            "a field.date @autoSet must stamp java.time.LocalDate.now(), not Instant; saw:\n$src")
        assertTrue("java.time.Instant.now()" !in src,
            "a date-only @autoSet must not emit Instant.now(); saw:\n$src")
    }

    @Test fun `the generated repository (with entity + table) compiles against Exposed`() {
        val outDir = Files.createTempDirectory("kautoset-cr-")
        try {
            val loader = loadString("autoset-compile", autoSetFixture)
            // Emit the data class, the Exposed table (+ instant column-type extension) and the
            // repository — the full set the stamping repository references.
            KotlinEntityGenerator().apply { setArgs(mapOf("outputDir" to outDir.toString())) }.execute(loader)
            KotlinExposedTableGenerator().apply { setArgs(mapOf("outputDir" to outDir.toString())) }.execute(loader)
            KotlinRepositoryGenerator().apply { setArgs(mapOf("outputDir" to outDir.toString())) }.execute(loader)

            val emitted = Files.walk(outDir).filter { it.isRegularFile() }.sorted().toList()
            assertTrue(emitted.any { it.fileName.toString() == "EventRepositoryBase.kt" },
                "expected a generated EventRepositoryBase.kt; saw $emitted")
            val sources = emitted.map { path ->
                SourceFile.kotlin(path.parent.relativize(path).toString().replace('/', '_'), path.readText())
            }

            val result = KotlinCompilation().apply {
                this.sources = sources
                inheritClassPath = true
                classpaths = exposedClasspath()
                messageOutputStream = System.out
            }.compile()
            assertEquals(KotlinCompilation.ExitCode.OK, result.exitCode,
                "generated @autoSet repository (+ entity/table) failed to compile:\n${result.messages}")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    /** Resolve exposed-core + exposed-java-time jars from the local m2 repo (populated by the build). */
    private fun exposedClasspath(): List<java.io.File> {
        val m2 = Paths.get(System.getProperty("user.home"), ".m2", "repository")
        return listOf(
            "org/jetbrains/exposed/exposed-core/0.55.0/exposed-core-0.55.0.jar",
            "org/jetbrains/exposed/exposed-java-time/0.55.0/exposed-java-time-0.55.0.jar",
        ).map { rel ->
            val p = m2.resolve(rel)
            assertTrue(Files.exists(p), "expected jar on local m2: $p (run a build that resolves exposed first)")
            p.toFile()
        }
    }
}

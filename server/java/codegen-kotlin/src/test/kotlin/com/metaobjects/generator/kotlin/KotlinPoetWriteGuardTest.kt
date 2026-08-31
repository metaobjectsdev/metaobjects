package com.metaobjects.generator.kotlin

import com.metaobjects.metadata.ktx.loadString
import com.squareup.kotlinpoet.FileSpec
import com.squareup.kotlinpoet.TypeSpec
import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The marker floor, for the half of this port that did not have one.
 *
 * <p>`docs/features/own-your-codegen.md` states that on Java and Kotlin "every generator
 * writes through one guard that refuses any existing file carrying no `GENERATED` marker,
 * so a hand-written file at a generated path is never clobbered." That was true of the
 * generators that hand-roll their bodies as strings and FALSE of the six that build a
 * KotlinPoet [FileSpec] — `FileSpec.writeTo(dir)` opens the output with
 * `Files.newOutputStream`'s defaults (CREATE, TRUNCATE_EXISTING, WRITE) and never looks at
 * what was there.
 *
 * <p>[KotlinEntityGenerator] used BOTH routes, which is why the false claim survived
 * review: its `MetaNetJson.kt` support file was guarded while `<Entity>.kt` — the file an
 * adopter is most likely to want to own — was not.
 *
 * <p>These tests assert the guarantee at RUNTIME rather than asserting that a particular
 * function is called, so they stay honest if the plumbing is refactored again. Each of the
 * six emitters is driven for real and checked on three things:
 *
 * <ol>
 *   <li>a second run REWRITES its own output — proving the emitted content actually carries
 *       the marker. Without this, guarding would freeze each artifact after its first run:
 *       written once, refused forever, build still green;</li>
 *   <li>deleting the marker line takes ownership — the edit survives regeneration;</li>
 *   <li>a hand-written, marker-less file already sitting at a generated path is never
 *       clobbered.</li>
 * </ol>
 */
class KotlinPoetWriteGuardTest {

    // === fixtures ==========================================================

    /** Entity + its enum: covers `<Entity>.kt` and the standalone enum class file. */
    private val entityFixture = """{
      "metadata.root": { "package": "acme::demo", "children": [
        { "object.entity": { "name": "Author", "children": [
            { "field.long":   { "name": "id" } },
            { "field.string": { "name": "name" } },
            { "field.enum":   { "name": "status", "@values": ["ACTIVE", "RETIRED"] } }
        ] } }
      ] }
    }""".trimIndent()

    /** FR-017 TPH: a concrete subtype emits its annotated `<Sub>Validation` shape. */
    private val tphFixture = """{
      "metadata.root": { "package": "acme::auth", "children": [
        { "object.entity": { "name": "Auth", "@discriminator": "type", "children": [
            { "source.rdb":   { "@table": "auths" } },
            { "field.long":   { "name": "id" } },
            { "field.enum":   { "name": "type", "@values": ["Bridge"] } },
            { "identity.primary": { "@fields": "id", "@generation": "increment" } }
        ] } },
        { "object.entity": { "name": "BridgeAuth", "extends": "Auth",
            "@discriminatorValue": "Bridge", "children": [
            { "field.int": { "name": "quantity", "@required": true } }
        ] } }
      ] }
    }""".trimIndent()

    /** An abstract entity emitted as an `interface` shape (opt-in arg). */
    private val abstractFixture = """{
      "metadata.root": { "package": "acme::demo", "children": [
        { "object.entity": { "name": "BaseShape", "abstract": true, "children": [
            { "field.long":   { "name": "id" } },
            { "field.string": { "name": "name", "@required": true } }
        ] } },
        { "object.entity": { "name": "Widget", "extends": "BaseShape", "children": [
            { "field.string": { "name": "sku" } }
        ] } }
      ] }
    }""".trimIndent()

    /** A prompt payload record. */
    private val payloadFixture = """{
      "metadata.root": { "package": "acme::demo", "children": [
        { "object.value": { "name": "Author", "children": [
            { "field.long":   { "name": "id" } },
            { "field.string": { "name": "name" } }
        ] } },
        { "template.prompt": { "name": "WelcomePrompt",
            "@payloadRef": "Author", "@textRef": "demo/welcome" } }
      ] }
    }""".trimIndent()

    // === the six KotlinPoet write sites ====================================

    /**
     * One emitter, the path it writes, and how to run it. [relPath] is the file this case
     * asserts on; an emitter may legitimately write others in the same run.
     */
    private data class Case(val label: String, val relPath: String, val emit: (Path) -> Unit)

    private fun cases(): List<Case> = listOf(
        Case("KotlinEntityGenerator.emit — <Entity>.kt", "acme/demo/Author.kt") { out ->
            KotlinEntityGenerator().apply { setArgs(mapOf("outputDir" to out.toString())) }
                .execute(loadString("entity", entityFixture))
        },
        Case("KotlinEnumEmitter — <Entity><Field>.kt", "acme/demo/AuthorStatus.kt") { out ->
            KotlinEntityGenerator().apply { setArgs(mapOf("outputDir" to out.toString())) }
                .execute(loadString("entity", entityFixture))
        },
        Case("KotlinEntityGenerator.emitTphSubtypeValidation", "acme/auth/BridgeAuthValidation.kt") { out ->
            KotlinEntityGenerator().apply { setArgs(mapOf("outputDir" to out.toString())) }
                .execute(loadString("tph", tphFixture))
        },
        Case("KotlinEntityGenerator.emitAbstractShape", "acme/demo/BaseShape.kt") { out ->
            KotlinEntityGenerator().apply {
                setArgs(mapOf("outputDir" to out.toString(), "emitAbstractShapes" to "true"))
            }.execute(loadString("abstract", abstractFixture))
        },
        Case("KotlinPayloadGenerator", "acme/demo/prompts/WelcomePromptPayload.kt") { out ->
            KotlinPayloadGenerator().apply { setArgs(mapOf("outputDir" to out.toString())) }
                .execute(loadString("payload", payloadFixture))
        },
        Case("KotlinSpringConfigGenerator", "acme/demo/MetadataExposedConfig.kt") { out ->
            KotlinSpringConfigGenerator().apply {
                setArgs(mapOf("outputDir" to out.toString(), "packageName" to "acme.demo"))
            }.execute(loadString("entity", entityFixture))
        },
    )

    // === helpers ===========================================================

    private fun <T> withTempDir(block: (Path) -> T): T {
        val dir = Files.createTempDirectory("kpoet-guard-")
        try {
            return block(dir)
        } finally {
            dir.toFile().deleteRecursively()
        }
    }

    /**
     * The documented ownership gesture: delete the marker line. Mirrors the guard's own
     * header shape (marker at line start, directly after comment punctuation) rather than
     * blanking the whole word, so this exercises what an adopter would actually do.
     */
    private val markerLine = Regex("""^[ \t]*(?://+|/\*+|\*+)[ \t]*GENERATED\b""")

    private fun stripMarkerLines(src: String): String =
        src.lines().filterNot { markerLine.containsMatchIn(it) }.joinToString("\n")

    // === the guarantees ====================================================

    @Test
    fun `every KotlinPoet emitter marks its output, so a second run rewrites it`() {
        // The trap this closes: guarding an emitter whose content carries NO marker makes the
        // first run write and every run after refuse — the artifact silently freezes while the
        // build stays green. Asserted by editing the file in a way that KEEPS the marker and
        // confirming regeneration restores it.
        for (case in cases()) withTempDir { out ->
            case.emit(out)
            val file = out.resolve(case.relPath)
            assertTrue(Files.exists(file),
                "${case.label}: expected $file; files=${Files.walk(out).toList()}")

            val generated = Files.readString(file)
            Files.writeString(file, generated + "\n// stale line from an earlier run\n")

            case.emit(out)
            assertEquals(generated, Files.readString(file),
                "${case.label}: a second run must overwrite this toolchain's own output. " +
                    "If it did not, the emitted content is missing the GENERATED marker and " +
                    "the guard has frozen the artifact.")
        }
    }

    @Test
    fun `deleting the marker takes ownership and the edit survives regeneration`() {
        // The whole point of the change: on this port there is no three-way merge and no hash
        // manifest, so deleting the marker line IS the ownership gesture. Before the fix these
        // six paths ignored it and overwrote the file anyway.
        for (case in cases()) withTempDir { out ->
            case.emit(out)
            val file = out.resolve(case.relPath)
            val generated = Files.readString(file)

            val owned = stripMarkerLines(generated) + "\n// hand-owned — do not regenerate\n"
            assertTrue(owned != generated, "${case.label}: fixture bug — nothing was stripped")
            Files.writeString(file, owned)

            case.emit(out)
            assertEquals(owned, Files.readString(file),
                "${case.label}: a file whose marker was deleted must be refused and left " +
                    "exactly as found.")
        }
    }

    @Test
    fun `a hand-written file already at a generated path is never clobbered`() {
        for (case in cases()) withTempDir { out ->
            val file = out.resolve(case.relPath)
            Files.createDirectories(file.parent)
            val mine = "package acme.demo\n\n// written by hand, never generated\nval x = 1\n"
            Files.writeString(file, mine)

            case.emit(out)
            assertEquals(mine, Files.readString(file),
                "${case.label}: a marker-less file at a generated path must be left untouched.")
        }
    }

    @Test
    fun `the guarded route writes the same path and bytes KotlinPoet's own writeTo would`() {
        // Guards the one thing that would show up in an adopter's diff. KotlinPoet resolves its
        // output as `directory.resolve(relativePath)` and writes `toString()` as UTF-8; the
        // guarded route uses the same two public members, so routing through the guard must
        // change WHETHER a file is written and never WHAT is written.
        val spec = FileSpec.builder("acme.demo", "Sample")
            .addType(
                TypeSpec.classBuilder("Sample")
                    .addKdoc("GENERATED — do not hand-edit. Regenerated from metadata.\n")
                    .build()
            )
            .build()

        withTempDir { native ->
            withTempDir { guarded ->
                val nativePath = spec.writeTo(native)
                KotlinPoetFileWriter.write(spec, guarded)

                assertEquals(
                    native.relativize(nativePath).toString().replace('\\', '/'),
                    "acme/demo/Sample.kt",
                    "KotlinPoet's own output path is the one the guarded route must reuse"
                )
                val guardedPath = guarded.resolve("acme/demo/Sample.kt")
                assertTrue(Files.exists(guardedPath), "guarded route wrote no file at $guardedPath")
                assertEquals(
                    Files.readAllBytes(nativePath).toList(),
                    Files.readAllBytes(guardedPath).toList(),
                    "guarded output must be byte-identical to FileSpec.writeTo"
                )
            }
        }
    }
}

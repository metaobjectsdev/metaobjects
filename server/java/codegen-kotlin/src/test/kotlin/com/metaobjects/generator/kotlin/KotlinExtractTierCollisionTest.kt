package com.metaobjects.generator.kotlin

import com.metaobjects.loader.InMemoryStringSource
import com.metaobjects.loader.MetaDataLoader
import com.metaobjects.metadata.ktx.loadDirectory
import com.tschuchort.compiletesting.KotlinCompilation
import com.tschuchort.compiletesting.SourceFile
import java.nio.file.Files
import java.nio.file.Path
import kotlin.io.path.isRegularFile
import kotlin.io.path.readText
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * #228 — the extract / output-parser tier must collision-scope its THREE naming tiers when two
 * value-objects share a bare short name across packages but are both reachable from ONE payload:
 *
 *  1. the strict `<Short>Payload` record ([KotlinPayloadGenerator]),
 *  2. the `<Short>Extracted` all-nullable mirror family ([KotlinExtractSchemaEmitter] — its OWN
 *     second naming scheme, emitted into the parser file),
 *  3. the extractor's strict-payload + mirror references ([KotlinExtractorGenerator]:
 *     `toStrict<Name>` over `<Name>Extracted`).
 *
 * ADR-0044 already scoped tier 1 (shipped 0.19.3). This test proves tiers 2 + 3 are scoped in
 * lockstep with tier 1, so the generated parser + extractor compile (no duplicate `NoteExtracted`
 * class / `fromNoteExtracted` / `toStrictNotePayload` function) and reference BOTH the
 * package-qualified strict records AND the package-qualified mirrors.
 *
 * Loads the shared `fixtures/template-output-render-conformance/xpkg-collision-json/` corpus
 * (`@format: json`, so the extract tier fires) — two `Note` VOs (`acme::alpha` / `acme::beta`)
 * reached by FQN `@objectRef` from `acme::app::Digest`, the `DigestDoc` output's `@payloadRef`.
 */
@OptIn(org.jetbrains.kotlin.compiler.plugin.ExperimentalCompilerApi::class)
class KotlinExtractTierCollisionTest {

    private val corpus: Path = run {
        var p: Path? = Path.of(System.getProperty("user.dir")).toAbsolutePath()
        while (p != null && !Files.exists(p.resolve("fixtures/template-output-render-conformance"))) {
            p = p.parent
        }
        assertTrue(p != null, "could not locate fixtures/template-output-render-conformance from user.dir")
        p!!.resolve("fixtures/template-output-render-conformance")
    }

    private fun compile(outDir: Path): KotlinCompilation.Result {
        val sources = Files.walk(outDir).filter { it.isRegularFile() }.sorted().toList()
            .map { path -> SourceFile.kotlin(path.parent.relativize(path).toString().replace('/', '_'), path.readText()) }
        return KotlinCompilation().apply {
            this.sources = sources
            inheritClassPath = true
            messageOutputStream = System.out
        }.compile()
    }

    @Test fun `extract tier collision-scopes payload, mirror and extractor refs across a cross-package Note collision`() {
        val outDir = Files.createTempDirectory("kext-xpkg-")
        try {
            val loader = loadDirectory("kext-xpkg", corpus.resolve("xpkg-collision-json"))

            // All three extract-tier generators run for one payload graph.
            for (gen in listOf(
                KotlinPayloadGenerator(),
                KotlinOutputParserGenerator(),
                KotlinExtractorGenerator(),
            )) {
                gen.setArgs(mapOf("outputDir" to outDir.toString()))
                gen.execute(loader)
            }

            val produced = Files.walk(outDir).filter { it.isRegularFile() }.toList()
            val names = produced.map { it.fileName.toString() }.toSet()

            // ---- Tier 1: strict payload records (ADR-0044, the existing guarantee) ----
            assertTrue("AcmeAlphaNotePayload.kt" in names, "expected AcmeAlphaNotePayload.kt; files=$names")
            assertTrue("AcmeBetaNotePayload.kt" in names, "expected AcmeBetaNotePayload.kt; files=$names")
            assertTrue("NotePayload.kt" !in names, "must NOT emit a clobbered bare NotePayload.kt; files=$names")

            // ---- Tier 2 + 3: the parser file (mirror family) ----
            val parserSrc = produced.first { it.fileName.toString() == "DigestDocParser.kt" }.readText()
            // Collision-scoped nested mirror declarations (their OWN naming scheme).
            assertTrue("data class AcmeAlphaNoteExtracted(" in parserSrc,
                "parser must declare AcmeAlphaNoteExtracted; saw:\n$parserSrc")
            assertTrue("data class AcmeBetaNoteExtracted(" in parserSrc,
                "parser must declare AcmeBetaNoteExtracted; saw:\n$parserSrc")
            // The bare mirror name must NOT be emitted twice (the pre-fix duplicate-class compile error).
            assertTrue("data class NoteExtracted(" !in parserSrc,
                "must NOT emit a bare (colliding) NoteExtracted; saw:\n$parserSrc")
            // The root mirror types its object fields as the collision-scoped nested mirrors.
            assertTrue("AcmeAlphaNoteExtracted?" in parserSrc && "AcmeBetaNoteExtracted?" in parserSrc,
                "root DigestDocExtracted must type fromAlpha/fromBeta as the scoped mirrors; saw:\n$parserSrc")
            // Collision-scoped mappers — never a bare (duplicated) fromNoteExtracted.
            assertTrue("fun fromAcmeAlphaNoteExtracted(" in parserSrc, parserSrc)
            assertTrue("fun fromAcmeBetaNoteExtracted(" in parserSrc, parserSrc)
            assertTrue("fun fromNoteExtracted(" !in parserSrc,
                "must NOT emit a bare (colliding) fromNoteExtracted mapper; saw:\n$parserSrc")

            // ---- Tier 3: the extractor file references BOTH strict records AND mirrors ----
            val extractorSrc = produced.first { it.fileName.toString() == "DigestDocExtractor.kt" }.readText()
            // Strict payload references (mapper name + return type).
            assertTrue("toStrictAcmeAlphaNotePayload" in extractorSrc, extractorSrc)
            assertTrue("toStrictAcmeBetaNotePayload" in extractorSrc, extractorSrc)
            assertTrue("toStrictNotePayload(" !in extractorSrc,
                "must NOT emit a bare (colliding) toStrictNotePayload; saw:\n$extractorSrc")
            // Mirror references (the mapper parameter type).
            assertTrue("AcmeAlphaNoteExtracted" in extractorSrc, extractorSrc)
            assertTrue("AcmeBetaNoteExtracted" in extractorSrc, extractorSrc)

            // ---- The whole graph COMPILES — proves the scoped classes/functions are real, distinct,
            //      and the cross-file references (payload <-> parser <-> extractor) resolve. ----
            val result = compile(outDir)
            assertEquals(KotlinCompilation.ExitCode.OK, result.exitCode, result.messages)
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    // === Checkpoint #1 — the build-time @payloadRef resolver is package-local (ADR-0042). ===
    // Two packages each declare their OWN payload VO `Report` (distinct field) AND a template
    // with a BARE @payloadRef "Report". The prior first-match/bare-tail resolver bound whichever
    // Report loaded first, so a template could emit the OTHER package's payload shape. The
    // canonical resolver binds each template's OWN package's Report — in BOTH load orders.

    private val alphaFixture = """{
      "metadata.root": { "package": "pkg::alpha", "children": [
        { "object.value": { "name": "Report", "children": [
            { "field.string": { "name": "alphaVal" } }
        ] } },
        { "template.prompt": { "name": "ReportPrompt",
            "@payloadRef": "Report", "@textRef": "alpha/x" } }
      ] }
    }""".trimIndent()

    private val betaFixture = """{
      "metadata.root": { "package": "pkg::beta", "children": [
        { "object.value": { "name": "Report", "children": [
            { "field.string": { "name": "betaVal" } }
        ] } },
        { "template.prompt": { "name": "ReportPrompt",
            "@payloadRef": "Report", "@textRef": "beta/x" } }
      ] }
    }""".trimIndent()

    private fun assertBarePayloadRefBindsOwnPackage(firstAlpha: Boolean) {
        val outDir = Files.createTempDirectory("kpay-bareref-")
        try {
            val loader = MetaDataLoader.createManual(false, "bareref-${firstAlpha}")
            loader.init()
            val sources = if (firstAlpha)
                listOf(InMemoryStringSource(alphaFixture, "alpha"), InMemoryStringSource(betaFixture, "beta"))
            else
                listOf(InMemoryStringSource(betaFixture, "beta"), InMemoryStringSource(alphaFixture, "alpha"))
            loader.load(sources)
            loader.register()

            KotlinPayloadGenerator().apply { setArgs(mapOf("outputDir" to outDir.toString())) }.execute(loader)

            val alphaPayload = outDir.resolve("pkg/alpha/prompts/ReportPromptPayload.kt").readText()
            val betaPayload = outDir.resolve("pkg/beta/prompts/ReportPromptPayload.kt").readText()

            // Each template's payload record must carry its OWN package's field — never the other's.
            assertTrue("alphaVal" in alphaPayload && "betaVal" !in alphaPayload,
                "pkg::alpha ReportPrompt must bind pkg::alpha::Report (alphaVal); saw:\n$alphaPayload")
            assertTrue("betaVal" in betaPayload && "alphaVal" !in betaPayload,
                "pkg::beta ReportPrompt must bind pkg::beta::Report (betaVal); saw:\n$betaPayload")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    @Test fun `bare payloadRef binds own package's payload — alpha loaded first`() =
        assertBarePayloadRefBindsOwnPackage(firstAlpha = true)

    @Test fun `bare payloadRef binds own package's payload — beta loaded first`() =
        assertBarePayloadRefBindsOwnPackage(firstAlpha = false)
}

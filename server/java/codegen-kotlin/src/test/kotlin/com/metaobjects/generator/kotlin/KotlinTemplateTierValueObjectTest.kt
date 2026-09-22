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
 * ADR-0056 — the template tier references a value object's OWN types and declares none.
 *
 * The value object's data class comes from [KotlinEntityGenerator], in the value object's
 * package. Its extraction mirror (`<Vo>Extracted`, with `fromMap` and `toStrict()`) comes from
 * [KotlinOutputParserGenerator], also in the value object's package, once per run. The parser,
 * extractor and render helper live in the TEMPLATE's `prompts` package and reference both by FQN.
 *
 * Two consequences are pinned here:
 *  - a value object reached from templates in two packages exists ONCE (#387 — it used to be
 *    written into whichever template's package sorted first, and referenced by a bare name from
 *    the other, where no such class existed);
 *  - two same-short-name value objects in different packages need no renaming (the ADR-0044
 *    `AcmeAlphaNotePayload` scheme is gone), because their packages already tell them apart.
 */
@OptIn(org.jetbrains.kotlin.compiler.plugin.ExperimentalCompilerApi::class)
class KotlinTemplateTierValueObjectTest {

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
            .map { path -> SourceFile.kotlin(outDir.relativize(path).toString().replace('/', '_'), path.readText()) }
        return KotlinCompilation().apply {
            this.sources = sources
            inheritClassPath = true
            messageOutputStream = System.out
        }.compile()
    }

    private fun relPaths(outDir: Path): Set<String> =
        Files.walk(outDir).filter { it.isRegularFile() }.map { outDir.relativize(it).toString() }.toList().toSet()

    // ---------------------------------------------------------------------------------------
    // #387 — one shared view, two consuming packages, one generator run.
    // ---------------------------------------------------------------------------------------

    private val sharedFixture = """{
      "metadata.root": { "package": "acme::shared", "children": [
        { "object.value": { "name": "StyleView", "children": [
            { "field.string": { "name": "tone", "@required": true } }
        ] } }
      ] }
    }""".trimIndent()

    private fun consumerFixture(pkg: String, prefix: String) = """{
      "metadata.root": { "package": "acme::$pkg", "children": [
        { "object.value": { "name": "${prefix}Payload", "children": [
            { "field.object": { "name": "style", "@objectRef": "acme::shared::StyleView" } }
        ] } },
        { "template.output": { "name": "${prefix}Doc", "@payloadRef": "${prefix}Payload",
            "@textRef": "$pkg/doc", "@format": "text" } },
        { "template.prompt": { "name": "${prefix}Ask", "@payloadRef": "${prefix}Payload",
            "@responseRef": "${prefix}Payload", "@textRef": "$pkg/doc", "@responseFormat": "json" } }
      ] }
    }""".trimIndent()

    @Test fun `a value object shared by two packages is generated once and referenced from both`() {
        val outDir = Files.createTempDirectory("kvo-shared-")
        val templateRoot = Files.createTempDirectory("kvo-shared-tmpl-")
        try {
            for (pkg in listOf("alpha", "beta")) {
                val file = templateRoot.resolve("$pkg/doc.mustache")
                Files.createDirectories(file.parent)
                Files.writeString(file, "{{style.tone}}")
            }
            val loader = MetaDataLoader.createManual(false, "kvo-shared")
            loader.init()
            loader.load(listOf(
                InMemoryStringSource(sharedFixture, "shared"),
                InMemoryStringSource(consumerFixture("alpha", "Alpha"), "alpha"),
                InMemoryStringSource(consumerFixture("beta", "Beta"), "beta"),
            ))
            loader.register()

            for (gen in listOf(KotlinEntityGenerator(), KotlinOutputParserGenerator(), KotlinExtractorGenerator())) {
                gen.setArgs(mapOf("outputDir" to outDir.toString()))
                gen.execute(loader)
            }
            KotlinRenderHelperGenerator().apply {
                setArgs(mapOf("outputDir" to outDir.toString(), "templateRoot" to templateRoot.toString()))
            }.execute(loader)

            val paths = relPaths(outDir)
            // The shared view exists exactly once, in its own package — data class and mirror.
            assertEquals(
                setOf("acme/shared/StyleView.kt", "acme/shared/StyleViewExtracted.kt"),
                paths.filter { it.contains("StyleView") }.toSet(),
                "the shared view must be generated once, in acme.shared; files=$paths")
            // Nothing value-shaped lands in a template's prompts package.
            val promptFiles = paths.filter { "/prompts/" in it }.map { it.substringAfterLast('/') }.toSet()
            assertEquals(
                setOf(
                    "AlphaAskParser.kt", "AlphaAskExtractor.kt", "AlphaDocRenderHelper.kt",
                    "BetaAskParser.kt", "BetaAskExtractor.kt", "BetaDocRenderHelper.kt",
                ),
                promptFiles,
                "the prompts packages hold only template-keyed artifacts; files=$paths")

            // Both consumers reference the one shared class by FQN.
            val alphaRender = outDir.resolve("acme/alpha/prompts/AlphaDocRenderHelper.kt").readText()
            assertTrue("payload: acme.alpha.AlphaPayload" in alphaRender, alphaRender)
            val betaParser = outDir.resolve("acme/beta/prompts/BetaAskParser.kt").readText()
            assertTrue("fun parseBetaAsk(text: String): acme.beta.BetaPayload" in betaParser, betaParser)

            val result = compile(outDir)
            assertEquals(KotlinCompilation.ExitCode.OK, result.exitCode, result.messages)
        } finally {
            outDir.toFile().deleteRecursively()
            templateRoot.toFile().deleteRecursively()
        }
    }

    // ---------------------------------------------------------------------------------------
    // Cross-package short-name collision — no renaming needed.
    // ---------------------------------------------------------------------------------------

    @Test fun `same-short-name value objects in different packages keep their own names`() {
        val outDir = Files.createTempDirectory("kvo-xpkg-")
        try {
            // Two `Note` VOs (acme::alpha / acme::beta) reached by FQN from acme::app::Digest,
            // which DigestPrompt replies with.
            val loader = loadDirectory("kvo-xpkg", corpus.resolve("xpkg-collision-json"))

            for (gen in listOf(KotlinEntityGenerator(), KotlinOutputParserGenerator(), KotlinExtractorGenerator())) {
                gen.setArgs(mapOf("outputDir" to outDir.toString()))
                gen.execute(loader)
            }

            val paths = relPaths(outDir)
            for (expected in listOf(
                "acme/alpha/Note.kt", "acme/alpha/NoteExtracted.kt",
                "acme/beta/Note.kt", "acme/beta/NoteExtracted.kt",
                "acme/app/Digest.kt", "acme/app/DigestExtracted.kt",
            )) {
                assertTrue(expected in paths, "expected $expected; files=$paths")
            }
            assertTrue(paths.none { "AcmeAlpha" in it || "AcmeBeta" in it },
                "no package-qualified renaming (ADR-0044's scheme is retired); files=$paths")

            // The Digest mirror types each field as the right package's mirror.
            val digestMirror = outDir.resolve("acme/app/DigestExtracted.kt").readText()
            assertTrue("val fromAlpha: acme.alpha.NoteExtracted? = null" in digestMirror, digestMirror)
            assertTrue("val fromBeta: acme.beta.NoteExtracted? = null" in digestMirror, digestMirror)

            val result = compile(outDir)
            assertEquals(KotlinCompilation.ExitCode.OK, result.exitCode, result.messages)
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    // ---------------------------------------------------------------------------------------
    // ADR-0042 — the RENDER-HELPER and OUTPUT-PROMPT generators resolve @payloadRef /
    // @responseRef package-locally. Two packages each declare their OWN `Report` VO (distinct
    // field) + templates with a BARE ref. Both must bind their own package's Report — in BOTH
    // load orders. (The render-helper's build-time drift gate would THROW on a wrong-package bind.)
    // ---------------------------------------------------------------------------------------

    private val alphaOutFixture = """{
      "metadata.root": { "package": "po::alpha", "children": [
        { "object.value": { "name": "Report", "children": [
            { "field.string": { "name": "alphaVal" } }
        ] } },
        { "template.output": { "name": "ReportOut",
            "@payloadRef": "Report", "@textRef": "alpha/t", "@format": "text" } },
        { "template.prompt": { "name": "ReportAsk",
            "@payloadRef": "Report", "@responseRef": "Report", "@textRef": "alpha/t", "@format": "text", "@responseFormat": "json" } }
      ] }
    }""".trimIndent()

    private val betaOutFixture = """{
      "metadata.root": { "package": "po::beta", "children": [
        { "object.value": { "name": "Report", "children": [
            { "field.string": { "name": "betaVal" } }
        ] } },
        { "template.output": { "name": "ReportOut",
            "@payloadRef": "Report", "@textRef": "beta/t", "@format": "text" } },
        { "template.prompt": { "name": "ReportAsk",
            "@payloadRef": "Report", "@responseRef": "Report", "@textRef": "beta/t", "@format": "text", "@responseFormat": "json" } }
      ] }
    }""".trimIndent()

    private fun writeTemplate(root: Path, ref: String, body: String) {
        val file = root.resolve("$ref.mustache")
        Files.createDirectories(file.parent)
        Files.writeString(file, body)
    }

    private fun assertRenderHelperAndOutputPromptBindOwnPackage(firstAlpha: Boolean) {
        val outDir = Files.createTempDirectory("krh-op-bareref-")
        val templateRoot = Files.createTempDirectory("krh-op-tmpl-")
        try {
            writeTemplate(templateRoot, "alpha/t", "{{alphaVal}}")
            writeTemplate(templateRoot, "beta/t", "{{betaVal}}")

            val loader = MetaDataLoader.createManual(false, "rhop-bareref-$firstAlpha")
            loader.init()
            val sources = if (firstAlpha)
                listOf(InMemoryStringSource(alphaOutFixture, "alpha"), InMemoryStringSource(betaOutFixture, "beta"))
            else
                listOf(InMemoryStringSource(betaOutFixture, "beta"), InMemoryStringSource(alphaOutFixture, "alpha"))
            loader.load(sources)
            loader.register()

            KotlinRenderHelperGenerator().apply {
                setArgs(mapOf("outputDir" to outDir.toString(), "templateRoot" to templateRoot.toString()))
            }.execute(loader)
            KotlinOutputPromptGenerator().apply { setArgs(mapOf("outputDir" to outDir.toString())) }.execute(loader)

            val alphaPrompt = outDir.resolve("po/alpha/prompts/ReportAskResponseFormat.kt").readText()
            val betaPrompt = outDir.resolve("po/beta/prompts/ReportAskResponseFormat.kt").readText()
            assertTrue("alphaVal" in alphaPrompt && "betaVal" !in alphaPrompt,
                "po::alpha ReportAsk output-prompt must list po::alpha::Report (alphaVal); saw:\n$alphaPrompt")
            assertTrue("betaVal" in betaPrompt && "alphaVal" !in betaPrompt,
                "po::beta ReportAsk output-prompt must list po::beta::Report (betaVal); saw:\n$betaPrompt")

            // Each render helper takes its own package's Report.
            val alphaRender = outDir.resolve("po/alpha/prompts/ReportOutRenderHelper.kt").readText()
            val betaRender = outDir.resolve("po/beta/prompts/ReportOutRenderHelper.kt").readText()
            assertTrue("payload: po.alpha.Report" in alphaRender, alphaRender)
            assertTrue("payload: po.beta.Report" in betaRender, betaRender)
        } finally {
            outDir.toFile().deleteRecursively()
            templateRoot.toFile().deleteRecursively()
        }
    }

    @Test fun `render-helper and output-prompt bind own package's payload — alpha loaded first`() =
        assertRenderHelperAndOutputPromptBindOwnPackage(firstAlpha = true)

    @Test fun `render-helper and output-prompt bind own package's payload — beta loaded first`() =
        assertRenderHelperAndOutputPromptBindOwnPackage(firstAlpha = false)
}

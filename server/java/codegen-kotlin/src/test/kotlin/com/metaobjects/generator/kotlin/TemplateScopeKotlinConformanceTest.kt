package com.metaobjects.generator.kotlin

import com.fasterxml.jackson.databind.ObjectMapper
import com.metaobjects.generator.template.ScopeWalk
import com.metaobjects.metadata.ktx.loadString
import com.metaobjects.render.FilesystemProvider
import com.metaobjects.render.templategen.TemplateGenerator
import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Proves a Kotlin consumer gets the declarative template generator for the first
 * time (codegen-kotlin depends on codegen-base): it drives the SAME byte-equivalent
 * [TemplateGenerator] + [ScopeWalk] from Kotlin over the shared
 * `fixtures/template-codegen-conformance/` corpus and asserts byte-identical output
 * to `expected/` (the TS-produced oracle).
 */
class TemplateScopeKotlinConformanceTest {

    private val json = ObjectMapper()

    private fun corpus(): Path =
        Path.of(System.getProperty("user.dir")).resolve("../../..")
            .resolve("fixtures/template-codegen-conformance").normalize()

    private fun relFiles(root: Path): List<String> =
        Files.walk(root).use { s ->
            s.filter { Files.isRegularFile(it) }
                .map { root.relativize(it).toString() }
                .sorted()
                .toList()
        }

    @Test fun `corpus renders byte-for-byte from Kotlin`() {
        val corpus = corpus()
        assertTrue(Files.exists(corpus.resolve("spec.json")), "corpus missing at $corpus")
        val spec = json.readTree(corpus.resolve("spec.json").toFile())
        val loader = loadString("shopTemplateCorpus",
            Files.readString(corpus.resolve("metadata/meta.shop.json")))
        val objects = loader.metaObjects
        val provider = FilesystemProvider(corpus.resolve("templates"))

        val out = Files.createTempDirectory("tmpl-conf-kotlin")
        for (g in spec.get("generators")) {
            val scope = g.get("scope").asText()
            val pattern = g.get("outputPattern").asText()
            val fmt = if (g.has("format")) g.get("format").asText() else "text"
            val files = TemplateGenerator.generate(
                g.get("name").asText(),
                g.get("template").asText(),
                { _ -> ScopeWalk.forScope(scope, pattern).apply(objects) },
                provider, fmt, objects)
            for (f in files) {
                val p = out.resolve(f.path())
                Files.createDirectories(p.parent ?: out)
                Files.writeString(p, f.content())
            }
        }

        val expected = corpus.resolve("expected")
        assertEquals(relFiles(expected), relFiles(out), "emitted file set must match expected/")
        for (rel in relFiles(expected)) {
            assertEquals(
                Files.readString(expected.resolve(rel)),
                Files.readString(out.resolve(rel)),
                "byte mismatch in $rel")
        }
    }
}

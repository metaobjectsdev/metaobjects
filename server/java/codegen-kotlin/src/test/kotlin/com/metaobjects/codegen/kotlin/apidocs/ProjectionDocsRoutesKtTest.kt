package com.metaobjects.codegen.kotlin.apidocs

import com.fasterxml.jackson.databind.ObjectMapper
import com.metaobjects.generator.kotlin.apidocs.ApiSymbolKind
import com.metaobjects.generator.kotlin.apidocs.KotlinApiModelBuilder
import com.metaobjects.metadata.ktx.loadString
import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * The api-contract `projection/` corpus, docs half. The REST routes a read-only projection's api
 * page lists are exactly the routes its generated surface answers with a row. Every port runs this
 * assertion over the same model and the same expected set
 * (`fixtures/api-contract-conformance/projection/docs-routes.json`):
 *
 * - a projection with a declared identity lists `GET <path>` and `GET <path>/{id}`;
 * - one with none lists `GET <path>` alone, even when it has a field named `id`;
 * - no unit lists a write verb.
 *
 * The booted-server half of the same contract is the corpus scenarios themselves
 * (`ProjectionGeneratedApiContractConformanceTest` in `integration-tests-kotlin`).
 */
class ProjectionDocsRoutesKtTest {

    /** Walk up to the repo root (the dir holding both `fixtures/` and `server/`). */
    private fun corpus(): Path {
        var p: Path? = Path.of(System.getProperty("user.dir")).toAbsolutePath().normalize()
        while (p != null) {
            if (Files.isDirectory(p.resolve("fixtures")) && Files.isDirectory(p.resolve("server"))) {
                return p.resolve("fixtures/api-contract-conformance/projection")
            }
            p = p.parent
        }
        throw IllegalStateException("could not locate the repo root from user.dir")
    }

    /** The spelling every port's expected set uses: no leading slash or api prefix, `{id}`. */
    private fun normalize(symbol: String): String {
        val space = symbol.indexOf(' ')
        return symbol.substring(0, space) + " " + symbol.substring(space + 1).replaceFirst(Regex("^/?(?:api/)?"), "")
    }

    @Test
    fun `each projection documents exactly the routes it mounts`() {
        val corpus = corpus()
        val expected = ObjectMapper().readTree(Files.readString(corpus.resolve("docs-routes.json"))).get("units")
        val loader = loadString("projectionDocs", Files.readString(corpus.resolve("meta.json")))

        val model = KotlinApiModelBuilder().build(loader, "projection-docs")

        for ((node, routes) in expected.fields().asSequence().map { it.key to it.value }) {
            val want = routes.map { it.asText() }.sorted()
            val unit = model.units.single { it.node == node }
            val documented = unit.symbols
                .filter { it.kind == ApiSymbolKind.REST }
                .map { normalize(it.name) }
                .sorted()
            assertEquals(want, documented, "$node: the routes its api page lists")
        }
    }
}

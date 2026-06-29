package com.metaobjects.integration.kotlin.api.jsonb.generated

import com.fasterxml.jackson.databind.ObjectMapper
import com.metaobjects.integration.kotlin.api.ApiContractAssertions
import com.metaobjects.integration.kotlin.api.ApiContractScenarioLoader
import com.metaobjects.integration.kotlin.api.ApiContractScenarios.ApiScenario
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.DisplayName
import org.junit.jupiter.api.assertDoesNotThrow
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.Arguments
import org.junit.jupiter.params.provider.MethodSource
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.util.stream.Stream

/**
 * jsonb open-bag api-contract conformance — Kotlin GENERATED-controller lane (issue #98).
 *
 * Where the sibling [com.metaobjects.integration.kotlin.api.jsonb.JsonbApiContractConformanceTest]
 * drives a hand-rolled reference server, this lane drives the **generated** Kotlin Spring
 * `@RestController` (emitted by `codegen-kotlin`'s `KotlinSpringControllerGenerator`) over
 * HTTP via [GeneratedDocumentControllerHarness] (generate→compile→MockMvc, Testcontainers
 * Postgres for the real JSONB column). It proves the deployed Kotlin API artifact accepts a
 * posted JSON object on the `field.string @dbColumnType=jsonb` open bag and surfaces a parsed
 * value over the wire — locking the #98 fix (`payload: JsonElement`) at the API boundary.
 *
 * Run on-demand:
 *   mvn -f server/java/integration-tests-kotlin/pom.xml \
 *     test -Dtest=JsonbGeneratedApiContractConformanceTest
 */
@DisplayName("jsonb open-bag api contract — GENERATED Kotlin Spring controller (codegen-kotlin) over MockMvc")
internal class JsonbGeneratedApiContractConformanceTest {

    @ParameterizedTest(name = "{0}")
    @MethodSource("scenarios")
    fun scenario(name: String, scenario: ApiScenario) {
        assertDoesNotThrow {
            HARNESS.reset(!scenario.truncate)
            for (req in scenario.requests) {
                val res = HARNESS.exchange(req.method, req.path, req.body)
                val parsed = HARNESS.parseBody(res.body)
                ApiContractAssertions.assertResponse(scenario.name, req, res.status, parsed)
            }
        }
    }

    companion object {
        private val MAPPER = ObjectMapper()

        /** The `jsonb/` sub-corpus root (sibling of the base single-entity corpus). */
        private val CORPUS = ApiContractScenarioLoader.findCorpusRoot().resolve("jsonb")

        @Suppress("UNCHECKED_CAST")
        private val SEED_ROWS: List<Map<String, Any?>> by lazy {
            val text = Files.readString(CORPUS.resolve("seed.json"), StandardCharsets.UTF_8)
            val parsed = MAPPER.readValue(text, Map::class.java) as Map<String, Any?>
            (parsed["rows"] as? List<Map<String, Any?>>) ?: error("jsonb/seed.json: missing 'rows' array")
        }

        /**
         * The generate→compile→load step is expensive, so the harness is built ONCE per class
         * (compiled artifacts + classloader reused). Per-scenario isolation comes from
         * [GeneratedDocumentControllerHarness.reset] rebuilding a freshly-seeded Postgres
         * container + controller + MockMvc.
         */
        private lateinit var HARNESS: GeneratedDocumentControllerHarness

        @BeforeAll
        @JvmStatic
        fun setUp() {
            val genDir = Files.createTempDirectory("jsonb-generated-kotlin-document-controller")
            HARNESS = GeneratedDocumentControllerHarness(CORPUS, genDir, SEED_ROWS)
        }

        @AfterAll
        @JvmStatic
        fun tearDown() {
            if (::HARNESS.isInitialized) HARNESS.close()
        }

        @JvmStatic
        fun scenarios(): Stream<Arguments> =
            ApiContractScenarioLoader.loadScenarios(CORPUS.resolve("scenarios")).stream()
                .map { Arguments.of(it.name, it) }
    }
}

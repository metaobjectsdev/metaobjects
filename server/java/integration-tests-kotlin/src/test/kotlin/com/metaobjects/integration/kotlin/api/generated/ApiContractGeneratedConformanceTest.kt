package com.metaobjects.integration.kotlin.api.generated

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
 * Cross-port API contract conformance — Kotlin GENERATED-controller lane (SP-F Unit 2).
 *
 * Where the sibling [com.metaobjects.integration.kotlin.api.ApiContractConformanceTest]
 * drives a hand-rolled reference server, this lane drives the **generated** Kotlin
 * Spring `@RestController` (emitted by `codegen-kotlin`'s [com.metaobjects.generator.kotlin.KotlinSpringControllerGenerator])
 * over HTTP via [GeneratedAuthorControllerHarness] (generate→compile→MockMvc). It proves
 * the deployed Kotlin API artifact — the generated controller — implements the cross-port
 * contract, not just a hand-written stand-in.
 *
 * The generated controller is hosted UNMODIFIED. The only hand-written piece is the
 * in-memory H2 (Exposed) bootstrap behind the generated `AuthorTable` (the consumer
 * persistence seam — the Kotlin controller embeds Exposed directly rather than a
 * repository interface); it is test scaffolding, not a conformance subject. Same 20
 * scenarios, same `expect` bytes, same [ApiContractAssertions] as every other port's lane.
 *
 * Run on-demand:
 *   mvn -f server/java/integration-tests-kotlin/pom.xml \
 *     test -Dtest=ApiContractGeneratedConformanceTest
 */
@DisplayName("API contract — GENERATED Kotlin Spring controller (codegen-kotlin) over MockMvc")
internal class ApiContractGeneratedConformanceTest {

    @ParameterizedTest(name = "{0}")
    @MethodSource("scenarios")
    fun scenario(name: String, scenario: ApiScenario) {
        assertDoesNotThrow {
            // Per-scenario isolation: a freshly-seeded H2 database + controller + MockMvc.
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

        @Suppress("UNCHECKED_CAST")
        private val SEED_ROWS: List<Map<String, Any?>> by lazy {
            val corpus = ApiContractScenarioLoader.findCorpusRoot()
            val text = Files.readString(corpus.resolve("seed.json"), StandardCharsets.UTF_8)
            val parsed = MAPPER.readValue(text, Map::class.java) as Map<String, Any?>
            (parsed["rows"] as? List<Map<String, Any?>>) ?: error("seed.json: missing 'rows' array")
        }

        /**
         * The generate→compile→load step is expensive, so the harness is built ONCE per
         * class (the compiled artifacts + classloader are reused). Per-scenario isolation
         * comes from [GeneratedAuthorControllerHarness.reset] rebuilding a freshly-seeded
         * H2 database + controller + MockMvc.
         */
        private lateinit var HARNESS: GeneratedAuthorControllerHarness

        @BeforeAll
        @JvmStatic
        fun setUp() {
            val corpus = ApiContractScenarioLoader.findCorpusRoot()
            val genDir = Files.createTempDirectory("sp-f-generated-kotlin-author-controller")
            HARNESS = GeneratedAuthorControllerHarness(corpus, genDir, SEED_ROWS)
        }

        @AfterAll
        @JvmStatic
        fun tearDown() {
            if (::HARNESS.isInitialized) HARNESS.close()
        }

        @JvmStatic
        fun scenarios(): Stream<Arguments> {
            val corpus = ApiContractScenarioLoader.findCorpusRoot()
            val scenarios = ApiContractScenarioLoader.loadScenarios(corpus.resolve("scenarios"))
            return scenarios.stream().map { Arguments.of(it.name, it) }
        }
    }
}

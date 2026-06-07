package com.metaobjects.integration.kotlin.api.m2m.generated

import com.metaobjects.integration.kotlin.api.m2m.M2mScenarios
import com.metaobjects.integration.kotlin.api.m2m.M2mScenarios.M2mScenario
import com.metaobjects.integration.kotlin.api.m2m.M2mSeed
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.assertDoesNotThrow
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.Arguments
import org.junit.jupiter.params.provider.MethodSource
import java.nio.file.Files
import java.util.stream.Stream

/**
 * FR-018 — cross-port M:N api-contract conformance, Kotlin GENERATED-controller lane.
 *
 * Where [com.metaobjects.integration.kotlin.api.m2m.M2mApiContractConformanceTest]
 * drives a hand-rolled reference server, this lane drives the GENERATED Kotlin Spring
 * `@RestController`s (`PostController`/`PersonController`, emitted by codegen-kotlin)
 * over HTTP via [GeneratedM2mControllerHarness] (generate→compile→MockMvc). It proves
 * the deployed Kotlin M:N traversal artifact — the generated `GET /{id}/<relation>`
 * sub-resources delegating to the emitted Exposed join helpers — implements the
 * cross-port contract.
 *
 * The generated controllers + Exposed join helpers are hosted UNMODIFIED. The only
 * hand-written piece is the in-memory H2 bootstrap (schema + seed); it is test
 * scaffolding, not a conformance subject. Same 3 scenarios, same assertions as the
 * reference lane and every other port. Docker-free (H2, per the SP-F generated-lane
 * design).
 *
 * Run on-demand:
 *   mvn -f server/java/integration-tests-kotlin/pom.xml test -Dtest=M2mGeneratedApiContractConformanceTest
 */
internal class M2mGeneratedApiContractConformanceTest {

    @ParameterizedTest(name = "{0}")
    @MethodSource("scenarios")
    fun scenario(name: String, scenario: M2mScenario) {
        assertDoesNotThrow {
            HARNESS.reset()
            for (req in scenario.requests) {
                val res = HARNESS.exchange(req.method, req.path)
                val parsed = HARNESS.parseBody(res.body)
                M2mScenarios.assertResponse(scenario.name, req, res.status, parsed)
            }
        }
    }

    companion object {
        private val CORPUS = M2mScenarios.findM2mCorpus()
        private lateinit var HARNESS: GeneratedM2mControllerHarness

        @BeforeAll
        @JvmStatic
        fun setUp() {
            val genDir = Files.createTempDirectory("fr018-generated-m2m-controllers-kt")
            HARNESS = GeneratedM2mControllerHarness(CORPUS, genDir, M2mSeed.load(CORPUS))
        }

        @AfterAll
        @JvmStatic
        fun tearDown() {
            if (::HARNESS.isInitialized) HARNESS.close()
        }

        @JvmStatic
        fun scenarios(): Stream<Arguments> =
            M2mScenarios.loadScenarios(CORPUS.resolve("scenarios")).stream()
                .map { Arguments.of(it.name, it) }
    }
}

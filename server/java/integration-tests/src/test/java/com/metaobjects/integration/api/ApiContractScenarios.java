package com.metaobjects.integration.api;

import java.util.List;
import java.util.Map;

/**
 * Typed records mirroring the YAML shape under
 * {@code fixtures/api-contract-conformance/scenarios/}. See the corpus
 * README for the supported {@code expect.body.*} vocabulary; we model it as
 * a permissive {@code Map} so this code stays decoupled from whichever
 * subset of assertion keys a given scenario happens to use.
 *
 * <p>Mirror of {@code ApiContractScenarios.kt} in
 * {@code integration-tests-kotlin}.</p>
 */
final class ApiContractScenarios {
    private ApiContractScenarios() {}

    /** A single HTTP request inside a scenario. */
    record ApiRequest(
        String id,
        String method,                  // GET | POST | PATCH | PUT | DELETE
        String path,                    // includes the query string
        Object body,                    // JSON-shaped (Map | List | scalar) or null
        int expectStatus,
        Map<String, Object> expectBody  // nullable
    ) {}

    /** A scenario file (one {@code .yaml} under {@code scenarios/}). */
    record ApiScenario(
        String name,
        String description,
        String sourcePath,
        boolean truncate,               // true when setup.truncate is set
        List<ApiRequest> requests
    ) {}
}

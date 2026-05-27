package com.metaobjects.integration.kotlin.api

/**
 * Typed records mirroring the YAML shape under
 * `fixtures/api-contract-conformance/scenarios/`. See the corpus README for
 * the supported `expect.body.*` vocabulary; we model it as a permissive
 * map so this code stays decoupled from whichever subset of assertion keys
 * a given scenario happens to use.
 */
object ApiContractScenarios {

    /** A single HTTP request inside a scenario. */
    data class ApiRequest(
        val id: String,
        val method: String,           // GET | POST | PATCH | PUT | DELETE
        val path: String,             // includes the query string
        val body: Any? = null,        // JSON-shaped (Map | List | scalar) or null
        val expectStatus: Int,
        val expectBody: Map<String, Any?>? = null,
    )

    /** A scenario file (one `.yaml` under `scenarios/`). */
    data class ApiScenario(
        val name: String,
        val description: String,
        val sourcePath: String,
        val truncate: Boolean,        // true when setup.truncate is set
        val requests: List<ApiRequest>,
    )
}

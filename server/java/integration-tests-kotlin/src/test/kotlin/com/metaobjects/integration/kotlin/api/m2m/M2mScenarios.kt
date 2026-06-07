package com.metaobjects.integration.kotlin.api.m2m

import org.yaml.snakeyaml.Yaml
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths

/**
 * FR-018 — typed model + loader + assertion engine for the shared M:N
 * api-contract corpus (`fixtures/api-contract-conformance/m2m/`). Kotlin mirror of
 * the Java `M2mScenarios`.
 *
 * The single-entity api-contract corpus uses a `rows[]` seed shape + the
 * `equals/ids/names/...` assertion vocabulary; the M:N corpus differs in two ways
 * that warrant a small dedicated harness:
 *  - its `seed.json` is keyed by physical table name (six tables), not `rows[]`;
 *  - it adds one assertion key — `namesUnordered`: the response is an array whose
 *    `name` multiset is compared order-insensitively (related-row order through a
 *    junction is not contractual).
 */
object M2mScenarios {

    private val yaml = Yaml()

    /** A single HTTP request inside an M:N scenario. */
    data class M2mRequest(
        val id: String,
        val method: String,                 // GET (M:N traversal is read-only)
        val path: String,                   // e.g. /api/posts/1/tags
        val expectStatus: Int,
        val expectBody: Map<String, Any?>?, // nullable
    )

    /** One scenario file (one `.yaml` under `m2m/scenarios/`). */
    data class M2mScenario(
        val name: String,
        val description: String,
        val requests: List<M2mRequest>,
    )

    fun loadScenarios(dir: Path): List<M2mScenario> =
        Files.list(dir).use { stream ->
            stream
                .filter { it.fileName.toString().endsWith(".yaml") }
                .sorted()
                .map { parseScenario(it, parseYamlMap(it)) }
                .toList()
        }

    /** Walk up from cwd to find `fixtures/api-contract-conformance/m2m`. */
    fun findM2mCorpus(): Path {
        var cur: Path? = Paths.get("").toAbsolutePath()
        while (cur != null) {
            val candidate = cur.resolve("fixtures/api-contract-conformance/m2m")
            if (Files.isDirectory(candidate)) return candidate
            cur = cur.parent
        }
        throw IllegalStateException(
            "Could not locate fixtures/api-contract-conformance/m2m from ${Paths.get("").toAbsolutePath()}")
    }

    @Suppress("UNCHECKED_CAST")
    private fun parseYamlMap(file: Path): Map<String, Any?> {
        val parsed = yaml.load<Any?>(Files.readString(file, StandardCharsets.UTF_8))
        require(parsed is Map<*, *>) { "$file: top-level YAML must be a mapping" }
        return parsed as Map<String, Any?>
    }

    @Suppress("UNCHECKED_CAST")
    private fun parseScenario(file: Path, root: Map<String, Any?>): M2mScenario {
        val rawRequests = (root["requests"] as? List<Map<String, Any?>>) ?: emptyList()
        return M2mScenario(
            name = root["name"]?.toString() ?: file.fileName.toString(),
            description = (root["description"] as? String) ?: "",
            requests = rawRequests.map { parseRequest(it) },
        )
    }

    @Suppress("UNCHECKED_CAST")
    private fun parseRequest(r: Map<String, Any?>): M2mRequest {
        val expect = r["expect"] as? Map<String, Any?>
            ?: error("request '${r["id"]}': missing 'expect' block")
        val status = (expect["status"] as? Number)?.toInt()
            ?: error("request '${r["id"]}': 'expect.status' must be a number")
        return M2mRequest(
            id = r["id"]?.toString() ?: "?",
            method = (r["method"] as? String ?: error("request: missing method")).uppercase(),
            path = r["path"] as? String ?: error("request: missing path"),
            expectStatus = status,
            expectBody = expect["body"] as? Map<String, Any?>,
        )
    }

    /**
     * Assert an M:N traversal response against the corpus `expect.body` vocabulary:
     * `namesUnordered` (order-insensitive `name` multiset) and `length` (array size,
     * used for the empty/orphan case).
     */
    fun assertResponse(scenarioName: String, request: M2mRequest, status: Int, body: Any?) {
        check(status == request.expectStatus) {
            "$scenarioName / ${request.id}: expected status ${request.expectStatus}, got $status; body: $body"
        }
        val want = request.expectBody ?: return

        (want["length"] as? Number)?.let { wantLen ->
            val list = body as? List<*>
                ?: throw AssertionError("$scenarioName / ${request.id}: expected array, got: $body")
            check(list.size == wantLen.toInt()) {
                "$scenarioName / ${request.id}: expected length=${wantLen.toInt()}, got ${list.size}"
            }
        }

        (want["namesUnordered"] as? List<*>)?.let { wantNames ->
            val list = body as? List<*>
                ?: throw AssertionError("$scenarioName / ${request.id}: expected array, got: $body")
            val actual = list.map { (it as? Map<*, *>)?.get("name")?.toString() }.sortedBy { it ?: "" }
            val expected = wantNames.map { it?.toString() }.sortedBy { it ?: "" }
            check(actual == expected) {
                "$scenarioName / ${request.id}: expected names (unordered) $expected, got $actual"
            }
        }
    }
}

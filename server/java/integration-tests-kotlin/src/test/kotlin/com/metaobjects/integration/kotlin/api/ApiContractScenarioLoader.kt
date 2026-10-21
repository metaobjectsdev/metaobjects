package com.metaobjects.integration.kotlin.api

import com.metaobjects.integration.kotlin.api.ApiContractScenarios.ApiRequest
import com.metaobjects.integration.kotlin.api.ApiContractScenarios.ApiScenario
import org.yaml.snakeyaml.Yaml
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths

/**
 * Parse scenario YAML files (`<corpus>/scenarios/<name>.yaml`) into typed
 * records. Mirrors the persistence-conformance ScenarioLoader shape.
 */
object ApiContractScenarioLoader {

    private val yaml = Yaml()

    fun loadScenarios(dir: Path): List<ApiScenario> =
        Files.list(dir).use { stream ->
            stream
                .filter { it.fileName.toString().endsWith(".yaml") }
                .sorted()
                .map { parseScenario(it, parseYamlMap(it)) }
                .toList()
        }

    /** Walk up from cwd to find `fixtures/api-contract-conformance`. */
    fun findCorpusRoot(): Path {
        var cur: Path? = Paths.get("").toAbsolutePath()
        while (cur != null) {
            val candidate = cur.resolve("fixtures/api-contract-conformance")
            if (Files.isDirectory(candidate)) return candidate
            cur = cur.parent
        }
        throw IllegalStateException(
            "Could not locate fixtures/api-contract-conformance from ${Paths.get("").toAbsolutePath()}"
        )
    }

    @Suppress("UNCHECKED_CAST")
    private fun parseYamlMap(file: Path): Map<String, Any?> {
        val text = Files.readString(file, StandardCharsets.UTF_8)
        val parsed = yaml.load<Any?>(text)
        require(parsed is Map<*, *>) { "$file: top-level YAML must be a mapping" }
        return parsed as Map<String, Any?>
    }

    @Suppress("UNCHECKED_CAST")
    private fun parseScenario(file: Path, root: Map<String, Any?>): ApiScenario {
        val rawRequests = (root["requests"] as? List<Map<String, Any?>>) ?: emptyList()
        val setup = root["setup"] as? Map<String, Any?>
        val truncate = (setup?.get("truncate") as? Boolean) ?: false

        return ApiScenario(
            name = root["name"]?.toString() ?: file.fileName.toString(),
            description = (root["description"] as? String) ?: "",
            sourcePath = file.toString(),
            truncate = truncate,
            requests = rawRequests.map { parseRequest(it) },
            engines = parseEngines(file, root["engines"]),
        )
    }

    private val KNOWN_ENGINES = setOf("postgres", "mysql", "sqlite", "d1")

    /** `engines:` is exact when present; a name the corpus does not know is a runner error. */
    private fun parseEngines(file: Path, raw: Any?): Set<String>? {
        if (raw == null) return null
        require(raw is List<*>) { "$file: 'engines' must be a list" }
        val names = raw.map { it.toString() }.toSet()
        val unknown = names - KNOWN_ENGINES
        require(unknown.isEmpty()) { "$file: unknown engine(s) $unknown; expected one of $KNOWN_ENGINES" }
        return names
    }

    @Suppress("UNCHECKED_CAST")
    private fun parseRequest(r: Map<String, Any?>): ApiRequest {
        val expect = r["expect"] as? Map<String, Any?>
            ?: error("request '${r["id"]}': missing 'expect' block")
        val status = (expect["status"] as? Number)?.toInt()
            ?: error("request '${r["id"]}': 'expect.status' must be a number")
        val expectBody = expect["body"] as? Map<String, Any?>

        return ApiRequest(
            id = r["id"]?.toString() ?: "?",
            method = (r["method"] as? String ?: error("request: missing method")).uppercase(),
            path = r["path"] as? String ?: error("request: missing path"),
            body = r["body"],
            expectStatus = status,
            expectBody = expectBody,
        )
    }
}

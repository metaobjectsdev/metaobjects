package com.metaobjects.integration.kotlin

import com.metaobjects.integration.kotlin.Scenarios.QueryScenario
import com.metaobjects.integration.kotlin.Scenarios.QuerySpec
import com.metaobjects.integration.kotlin.Scenarios.SortSpec
import org.yaml.snakeyaml.Yaml
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths

/**
 * Parse persistence-conformance query-scenario YAML into typed records. Shape
 * mirrors the Java port's `ScenarioLoader` semantics. Schema migrations are
 * owned by the TypeScript toolchain (ADR-0015): the canonical schema artifact
 * the query runner provisions its DB from is committed at
 * [CANONICAL_SCHEMA_RELATIVE], produced by TS from the canonical metadata.
 */
object ScenarioLoader {

    /** Canonical Postgres schema artifact, relative to the corpus root. */
    private const val CANONICAL_SCHEMA_RELATIVE = "canonical/schema.postgres.sql"

    private val yaml = Yaml()

    fun loadQueries(dir: Path): List<QueryScenario> =
        Files.list(dir).use { stream ->
            stream
                .filter { it.fileName.toString().endsWith(".yaml") }
                .sorted()
                .map { parseQuery(it, parseYamlMap(it)) }
                .toList()
        }

    /** Walk up from cwd to find the shared corpus root, regardless of where `mvn` was invoked. */
    fun findCorpusRoot(): Path {
        var cur: Path? = Paths.get("").toAbsolutePath()
        while (cur != null) {
            val candidate = cur.resolve("fixtures/persistence-conformance")
            if (Files.isDirectory(candidate)) return candidate
            cur = cur.parent
        }
        throw IllegalStateException(
            "Could not locate fixtures/persistence-conformance from ${Paths.get("").toAbsolutePath()}"
        )
    }

    /** Read the committed canonical Postgres schema DDL (executed verbatim by the query runner). */
    fun readCanonicalSchema(corpusRoot: Path): String {
        val schema = corpusRoot.resolve(CANONICAL_SCHEMA_RELATIVE)
        require(Files.isRegularFile(schema)) { "Canonical schema not found: $schema" }
        return Files.readString(schema, StandardCharsets.UTF_8)
    }

    // -----------------------------------------------------------------------
    // YAML helpers
    // -----------------------------------------------------------------------

    @Suppress("UNCHECKED_CAST")
    private fun parseYamlMap(file: Path): Map<String, Any?> {
        val text = Files.readString(file, StandardCharsets.UTF_8)
        val parsed = yaml.load<Any?>(text)
        require(parsed is Map<*, *>) { "$file: top-level YAML must be a mapping" }
        return parsed as Map<String, Any?>
    }

    // -----------------------------------------------------------------------
    // Query parsing
    // -----------------------------------------------------------------------

    @Suppress("UNCHECKED_CAST")
    private fun parseQuery(file: Path, root: Map<String, Any?>): QueryScenario {
        val rawQueries = (root["queries"] as? List<Map<String, Any?>>) ?: emptyList()
        val queries = rawQueries.map { parseQuerySpec(it) }
        return QueryScenario(
            name = requireString(file, root, "name"),
            description = (root["description"] as? String) ?: "",
            sourcePath = file.toString(),
            seedData = root["seed-data"] as? String,
            queries = queries,
        )
    }

    @Suppress("UNCHECKED_CAST")
    private fun parseQuerySpec(q: Map<String, Any?>): QuerySpec {
        val sortsRaw = q["sort"] as? List<Map<String, Any?>>
        val sorts = sortsRaw?.map { SortSpec(it["field"] as String, (it["dir"] as? String) ?: "asc") }
        return QuerySpec(
            name = q["name"] as String,
            op = q["op"] as String,
            entity = q["entity"] as String,
            by = q["by"] as? Map<String, Any?>,
            filter = q["filter"] as? Map<String, Any?>,
            sort = sorts,
            limit = (q["limit"] as? Number)?.toInt(),
            offset = (q["offset"] as? Number)?.toInt(),
            relation = q["relation"] as? String,
            insert = q["insert"] as? Map<String, Any?>,
            expect = q["expect"],
        )
    }

    // -----------------------------------------------------------------------
    // Common helpers
    // -----------------------------------------------------------------------

    private fun requireString(file: Path, map: Map<String, Any?>, key: String): String {
        val v = map[key]
        require(v is String && v.isNotEmpty()) { "$file: missing required key '$key'" }
        return v
    }
}

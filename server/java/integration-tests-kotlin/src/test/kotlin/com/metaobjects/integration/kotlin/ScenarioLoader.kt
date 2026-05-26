package com.metaobjects.integration.kotlin

import com.metaobjects.integration.kotlin.Scenarios.ApplyUpThenQuery
import com.metaobjects.integration.kotlin.Scenarios.BlockedChange
import com.metaobjects.integration.kotlin.Scenarios.MigrationExpect
import com.metaobjects.integration.kotlin.Scenarios.MigrationScenario
import com.metaobjects.integration.kotlin.Scenarios.QueryScenario
import com.metaobjects.integration.kotlin.Scenarios.QuerySpec
import com.metaobjects.integration.kotlin.Scenarios.SortSpec
import org.yaml.snakeyaml.Yaml
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths

/**
 * Parse persistence-conformance scenario YAML into typed records. Hyphenated
 * YAML keys lower to camelCase Kotlin properties by hand because SnakeYAML
 * doesn't impose a naming convention on a raw Map load. Matches the Java
 * port's ScenarioLoader semantics.
 */
object ScenarioLoader {

    private val yaml = Yaml()

    fun loadQueries(dir: Path): List<QueryScenario> =
        Files.list(dir).use { stream ->
            stream
                .filter { it.fileName.toString().endsWith(".yaml") }
                .sorted()
                .map { parseQuery(it, parseYamlMap(it)) }
                .toList()
        }

    fun loadMigrations(dir: Path): List<MigrationScenario> =
        Files.list(dir).use { stream ->
            stream
                .filter { it.fileName.toString().endsWith(".yaml") }
                .sorted()
                .map { parseMigration(it, parseYamlMap(it)) }
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
            expect = q["expect"],
        )
    }

    // -----------------------------------------------------------------------
    // Migration parsing
    // -----------------------------------------------------------------------

    @Suppress("UNCHECKED_CAST")
    private fun parseMigration(file: Path, root: Map<String, Any?>): MigrationScenario {
        val dir = file.parent
        return MigrationScenario(
            name = requireString(file, root, "name"),
            description = (root["description"] as? String) ?: "",
            sourcePath = file.toString(),
            seedMetadataDir = resolveRelative(dir, root["seed-metadata"] as? String),
            seedData = root["seed-data"] as? String,
            targetMetadataDir = resolveRelative(dir, root["target-metadata"] as? String),
            targetMetadataInline = root["target-metadata-inline"] as? String,
            expect = parseMigrationExpect((root["expect"] as? Map<String, Any?>) ?: emptyMap()),
        )
    }

    @Suppress("UNCHECKED_CAST")
    private fun parseMigrationExpect(e: Map<String, Any?>): MigrationExpect {
        val blockedRaw = (e["blocked"] as? List<Map<String, Any?>>) ?: emptyList()
        val blocked = blockedRaw.map {
            BlockedChange(it["kind"] as String, (it["reason-contains"] as? String) ?: "")
        }
        val upContains = (e["up-contains"] as? List<String>) ?: emptyList()
        val upEmpty = e["up-empty"] as? Boolean
        val auq = e["apply-up-then-query"] as? Map<String, Any?>
        val applyUpThenQuery = auq?.let {
            ApplyUpThenQuery(
                sql = (it["sql"] as? String) ?: "",
                rows = (it["rows"] as? List<Map<String, Any?>>) ?: emptyList(),
            )
        }
        return MigrationExpect(blocked, upContains, upEmpty, applyUpThenQuery)
    }

    // -----------------------------------------------------------------------
    // Common helpers
    // -----------------------------------------------------------------------

    private fun resolveRelative(scenarioDir: Path, relative: String?): String? {
        if (relative.isNullOrEmpty()) return null
        return scenarioDir.resolve(relative).normalize().toString()
    }

    private fun requireString(file: Path, map: Map<String, Any?>, key: String): String {
        val v = map[key]
        require(v is String && v.isNotEmpty()) { "$file: missing required key '$key'" }
        return v
    }
}

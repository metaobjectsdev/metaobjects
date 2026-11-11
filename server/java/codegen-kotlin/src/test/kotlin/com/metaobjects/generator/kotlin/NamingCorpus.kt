package com.metaobjects.generator.kotlin

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.metaobjects.database.NamingStrategies
import java.nio.file.Files
import java.nio.file.Path

/**
 * The shared physical-naming corpus (`fixtures/naming-conformance/physical-names/`), and its
 * application-registered strategies registered the way a Kotlin application does
 * (ADR-0058 Amendment 1): through [NamingStrategies], each a lambda delegating to the
 * built-in it names. Idempotent — registering a name again replaces it.
 */
object NamingCorpus {
    val dir: Path by lazy {
        var d: Path? = Path.of("").toAbsolutePath()
        while (d != null && !Files.isDirectory(d.resolve("fixtures"))) d = d.parent
        requireNotNull(d) { "could not locate fixtures/" }.resolve("fixtures/naming-conformance/physical-names")
    }

    val cases: JsonNode by lazy { ObjectMapper().readTree(dir.resolve("cases.json").toFile()) }

    fun registerStrategies() {
        for (s in cases.get("strategies")) {
            val name = s.get("name").asText()
            val prefix = s.get("prefix")?.asText() ?: ""
            val upper = s.get("upperCase")?.map { it.asText() }?.toSet() ?: emptySet()
            if (s.get("for").asText() == "columns") {
                val inner = NamingStrategies.column(s.get("delegate").asText())
                NamingStrategies.registerColumns(name) { n -> if (n in upper) n.uppercase() else prefix + inner.apply(n) }
            } else {
                val inner = NamingStrategies.table(s.get("delegate").asText())
                NamingStrategies.registerTables(name) { n -> if (n in upper) n.uppercase() else prefix + inner.apply(n) }
            }
        }
    }
}

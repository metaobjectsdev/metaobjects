package com.metaobjects.integration.kotlin

import com.metaobjects.integration.kotlin.Scenarios.QueryScenario

/**
 * The SQL engine a persistence scenario runs on. Postgres is the corpus' own engine: the scenario
 * YAML holds its seed SQL and its wire-form `expect`. MySQL and SQLite run the same scenarios against
 * their own TS-produced schema artifact (`canonical/schema.<engine>.sql`), with the seed re-spelled for
 * the engine where its spelling differs and the engine's spelling of a value mapped onto the corpus'
 * wire form. Spelling only: a wrong VALUE still
 * fails the comparison, and no `expect` is loosened.
 */
enum class ScenarioEngine(private val id: String) {
    POSTGRES("postgres") {
        override fun seed(scenario: QueryScenario): String? = scenario.seedData
    },
    MYSQL("mysql") {
        override fun seed(scenario: QueryScenario): String? =
            scenario.seedDataEngine?.get("mysql") ?: scenario.seedData?.let { toMysqlSeed(it) }
    },
    SQLITE("sqlite") {
        // SQLite takes the Postgres seed as written (double-quoted identifiers, ISO instants as text).
        override fun seed(scenario: QueryScenario): String? =
            scenario.seedDataEngine?.get("sqlite") ?: scenario.seedData
    };

    /** The schema artifact, relative to the corpus root. */
    val schemaArtifact: String get() = "canonical/schema.$id.sql"

    /** The scenario's seed SQL spelled for this engine, or null. */
    abstract fun seed(scenario: QueryScenario): String?

    companion object {
        private val UTC_INSTANT = Regex("'(\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?)Z'")

        /**
         * Postgres-quoted seed SQL to MySQL. Walks the text once so a double quote INSIDE a
         * single-quoted string (a JSON payload) is left alone and only a double-quoted identifier is
         * rewritten; a UTC instant literal loses its `Z` (a DATETIME holds the UTC wall clock).
         */
        internal fun toMysqlSeed(seed: String): String {
            val out = StringBuilder(seed.length)
            var inString = false
            var inIdent = false
            var i = 0
            while (i < seed.length) {
                val c = seed[i]
                if (inString) {
                    out.append(c)
                    if (c == '\'') {
                        if (i + 1 < seed.length && seed[i + 1] == '\'') { out.append('\''); i++ } else inString = false
                    }
                } else if (inIdent) {
                    if (c == '"') { out.append('`'); inIdent = false } else out.append(c)
                } else if (c == '\'') {
                    inString = true
                    out.append(c)
                } else if (c == '"') {
                    inIdent = true
                    out.append('`')
                } else {
                    out.append(c)
                }
                i++
            }
            return UTC_INSTANT.replace(out.toString(), "'$1'")
        }

        /** The statements of a script: split on a `;` at the end of a line (no body carries one mid-line). */
        internal fun splitStatements(script: String): List<String> {
            val sb = StringBuilder()
            for (line in script.split("\n")) {
                if (!line.trim().startsWith("--")) sb.append(line).append('\n')
            }
            return sb.toString().split(Regex(";[ \\t]*(?:\\n|$)")).filter { it.isNotBlank() }.map { it.trim() }
        }
    }
}

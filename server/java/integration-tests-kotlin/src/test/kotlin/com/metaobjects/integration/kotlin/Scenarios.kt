package com.metaobjects.integration.kotlin

/**
 * Typed records for the persistence-conformance scenario YAML files. Shape
 * mirrors Java's `Scenarios.java`, C#'s `Scenarios.cs`, and the TS scenario
 * types so the same fixture files load cleanly into every port.
 */
object Scenarios {

    data class SortSpec(val field: String, val dir: String)

    data class QuerySpec(
        val name: String,
        val op: String,                          // list | get | count | relate | update | delete | roundtrip
        val entity: String,
        val by: Map<String, Any?>? = null,
        val filter: Map<String, Any?>? = null,
        val sort: List<SortSpec>? = null,
        val limit: Int? = null,
        val offset: Int? = null,
        val relation: String? = null,            // op:relate — the M:N relationship name to traverse
        val insert: Map<String, Any?>? = null,   // op:roundtrip — the field-keyed row to WRITE
        val data: Map<String, Any?>? = null,     // op:create / op:update — the field-keyed row/patch to WRITE
        val expect: Any? = null,
        val expectError: Boolean = false,        // when true, the op MUST throw (cross-subtype write rejection)
    )

    data class QueryScenario(
        val name: String,
        val description: String,
        val sourcePath: String,
        val seedData: String? = null,
        val queries: List<QuerySpec>,
    )
}

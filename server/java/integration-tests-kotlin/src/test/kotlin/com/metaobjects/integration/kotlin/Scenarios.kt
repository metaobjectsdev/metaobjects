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
        val op: String,                          // list | get | count
        val entity: String,
        val by: Map<String, Any?>? = null,
        val filter: Map<String, Any?>? = null,
        val sort: List<SortSpec>? = null,
        val limit: Int? = null,
        val offset: Int? = null,
        val expect: Any? = null,
    )

    data class QueryScenario(
        val name: String,
        val description: String,
        val sourcePath: String,
        val seedData: String? = null,
        val queries: List<QuerySpec>,
    )

    data class BlockedChange(val kind: String, val reasonContains: String)

    data class ApplyUpThenQuery(val sql: String, val rows: List<Map<String, Any?>>)

    data class MigrationExpect(
        val blocked: List<BlockedChange> = emptyList(),
        val upContains: List<String> = emptyList(),
        val upEmpty: Boolean? = null,
        val applyUpThenQuery: ApplyUpThenQuery? = null,
    )

    data class MigrationScenario(
        val name: String,
        val description: String,
        val sourcePath: String,
        val seedMetadataDir: String? = null,
        val seedData: String? = null,
        val targetMetadataDir: String? = null,
        val targetMetadataInline: String? = null,
        val expect: MigrationExpect,
    )
}

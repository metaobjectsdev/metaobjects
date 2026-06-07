package com.metaobjects.generator.kotlin.runtime

/**
 * FR-018 Unit 13 — generic M:N junction-traversal helper for the generated Kotlin
 * runtime. Substrate-agnostic: it operates purely on junction rows already loaded
 * by the consumer's persistence layer (Exposed / plain JDBC / any), so it carries
 * no Exposed / JDBC dependency and stays a tiny dependency-free helper on the same
 * runtime classpath the generated controller + relations helpers compile against.
 *
 * Kotlin port of the Java [codegen-spring `M2mJoinResolver`] and the cross-port
 * TS `n2m-resolver`. Given the derived junction FK field names
 * (`sourceField` / `targetField`, derived once at codegen time via the shared JVM
 * `com.metaobjects.relationship.M2MFields.derive`) and the symmetric flag, it
 * returns the DISTINCT related target keys for a source id. The three resolution
 * modes collapse to a single algorithm here because FK-field derivation has
 * already disambiguated direction:
 *
 *  1. **Hetero / directed self-join** (not symmetric): the consumer queries the
 *     junction `WHERE sourceField = :id`; for each row the related key is
 *     `targetField`.
 *  2. **Symmetric self-join**: the consumer queries the junction
 *     `WHERE sourceField = :id OR targetField = :id`; for each row the related key
 *     is whichever FK column is NOT the source id (union-on-read, single-row
 *     storage).
 *
 * Keys are compared by string-coerced identity so a `BIGINT` surfaced as a
 * different numeric type by the driver still matches the in-process source id —
 * the same bridge the cross-port resolvers use.
 */
object M2mJoinResolver {

    /**
     * A loaded junction row, reduced to its two derived FK column values.
     *
     * @property sourceKey value of the source-side FK column on this junction row
     * @property targetKey value of the target-side FK column on this junction row
     */
    data class JunctionRow(val sourceKey: Any?, val targetKey: Any?)

    /**
     * Collect the DISTINCT related target keys for [sourceId] from the
     * already-fetched junction [rows], in first-seen order.
     *
     * For the non-symmetric modes the consumer is expected to have filtered the
     * junction to `sourceField = sourceId`, so every row contributes its
     * `targetKey`. For the symmetric mode the consumer fetches both directions
     * (`sourceField = id OR targetField = id`) and this helper returns, per row,
     * the column that is NOT the source id.
     *
     * @param sourceId  the source entity's key
     * @param rows      junction rows (already filtered for the source id)
     * @param symmetric `true` for an undirected self-join
     * @return the distinct related target keys (empty when none)
     */
    fun relatedKeys(sourceId: Any?, rows: List<JunctionRow>, symmetric: Boolean): List<Any?> {
        val out = LinkedHashSet<Any?>()
        for (row in rows) {
            val related: Any? = if (symmetric) {
                if (keyEquals(row.sourceKey, sourceId)) row.targetKey else row.sourceKey
            } else {
                row.targetKey
            }
            if (related != null) out.add(related)
        }
        return out.toList()
    }

    /** String-coerced key identity — bridges driver-numeric vs in-process-numeric mismatches. */
    fun keyEquals(a: Any?, b: Any?): Boolean {
        if (a == null || b == null) return a === b
        return a.toString() == b.toString()
    }
}

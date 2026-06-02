package com.metaobjects.integration.kotlin

import com.metaobjects.MetaData
import com.metaobjects.MetaRoot
import com.metaobjects.`object`.MetaObject
import com.metaobjects.relationship.M2MFields
import com.metaobjects.relationship.MetaRelationship
import java.sql.Connection

/**
 * Generic, metadata-driven M:N query resolver for the Kotlin/Exposed runtime.
 *
 * Kotlin port of the TS reference (`runtime-ts/src/n2m-resolver.ts`) and the Java
 * OMDB `M2MResolver`. Given a source entity and an M:N relationship
 * (`@cardinality: "many"` + `@objectRef: <target>` + `@through: <junction>`),
 * resolve the related target rows by traversing the junction. The junction FK
 * columns are NOT restated on the relationship — they are DERIVED from the
 * junction entity's two `identity.reference` children via the shared JVM
 * [M2MFields.derive] helper (the cross-port SSOT for FK direction), exactly as
 * the Java OMDB resolver does.
 *
 * The Exposed substrate here uses raw JDBC against the open transaction
 * connection rather than typed `Table` objects: the M:N corpus entities (Post /
 * Tag / Person / Follow / Friendship / PostTag) carry no hand-written Exposed
 * `Table`, and the physical table + column + PK names are fully described by the
 * loaded metadata — so the resolver reads them from the metadata and addresses
 * the DB generically (no per-entity Exposed mapping needed).
 *
 * Three modes (mirroring TS / Java):
 *  1. **Hetero** (source != target): query the junction `WHERE sourceFK = sourceId`,
 *     collect `targetFK`, load the targets by PK.
 *  2. **Directed self-join** (`@sourceRefField`): identical traversal;
 *     [M2MFields.derive] has already picked which junction FK is the source side,
 *     so direction is honored.
 *  3. **Symmetric self-join** (`@symmetric: true`): single-row storage, union on
 *     read — query `WHERE sourceFK = id OR targetFK = id`; for each junction row the
 *     related id is whichever FK column is NOT the source id (a self-pair row `(a,a)`
 *     yields the source id itself).
 */
object M2MResolver {

    /**
     * Resolve the related target rows for an M:N relationship.
     *
     * @param conn       the open JDBC connection (from the Exposed transaction)
     * @param sourceMeta the source entity's metadata
     * @param sourceId   the source row's primary-key value (from the scenario `by:`)
     * @param rel        the M:N relationship declared on [sourceMeta]
     * @param root       the loaded model root (to find junction + target entities)
     * @return the related target rows as column-name-keyed maps (empty when none)
     */
    fun resolve(
        conn: Connection,
        sourceMeta: MetaObject,
        sourceId: Any?,
        rel: MetaRelationship,
        root: MetaRoot,
    ): List<Map<String, Any?>> {
        if (sourceId == null) return emptyList()

        val fields = M2MFields.derive(rel, sourceMeta, root)
        val junction = mustGetEntity(root, rel.through)
        val target = mustGetEntity(root, rel.objectRef)

        val junctionTable = tableName(junction)
        val sourceFk = fields.sourceField
        val targetFk = fields.targetField

        // 1. Query the junction for matching rows.
        //    hetero / directed: sourceFK = sourceId
        //    symmetric:         sourceFK = sourceId OR targetFK = sourceId (union-on-read)
        val whereSql = if (rel.isSymmetric) {
            "\"$sourceFk\" = ? OR \"$targetFk\" = ?"
        } else {
            "\"$sourceFk\" = ?"
        }
        val params = if (rel.isSymmetric) listOf(sourceId, sourceId) else listOf(sourceId)

        // 2. Collect the distinct related target ids (preserve first-seen order).
        val targetIds = LinkedHashSet<Any?>()
        conn.prepareStatement(
            "SELECT \"$sourceFk\", \"$targetFk\" FROM \"$junctionTable\" WHERE $whereSql"
        ).use { ps ->
            params.forEachIndexed { i, v -> ps.setObject(i + 1, v) }
            ps.executeQuery().use { rs ->
                while (rs.next()) {
                    val a = rs.getObject(sourceFk)
                    val b = rs.getObject(targetFk)
                    val relatedId = if (rel.isSymmetric) {
                        // The related id is whichever FK column is NOT the source id.
                        if (keyEquals(a, sourceId)) b else a
                    } else {
                        b
                    }
                    if (relatedId != null) targetIds.add(relatedId)
                }
            }
        }
        if (targetIds.isEmpty()) return emptyList()

        // 3. Load the targets by PK.
        val targetTable = tableName(target)
        val targetPk = primaryKeyField(target)
        val targetCols = columnNames(target)
        val placeholders = targetIds.joinToString(",") { "?" }
        val rows = ArrayList<Map<String, Any?>>(targetIds.size)
        conn.prepareStatement(
            "SELECT * FROM \"$targetTable\" WHERE \"$targetPk\" IN ($placeholders)"
        ).use { ps ->
            targetIds.forEachIndexed { i, id -> ps.setObject(i + 1, id) }
            ps.executeQuery().use { rs ->
                while (rs.next()) {
                    val row = LinkedHashMap<String, Any?>(targetCols.size)
                    for (col in targetCols) row[col] = rs.getObject(col)
                    rows.add(row)
                }
            }
        }
        return rows
    }

    // --- helpers -----------------------------------------------------------

    /** The physical table name of an entity (`source.rdb @table`). */
    private fun tableName(mc: MetaObject): String =
        mc.primaryRdbTableName
            ?: error("Entity '${mc.shortName}' has no source.rdb @table — required for M:N resolution")

    /** The single primary-key field name of an entity. */
    private fun primaryKeyField(mc: MetaObject): String {
        val pk = mc.primaryIdentity
            ?: error("Entity '${mc.shortName}' has no identity.primary")
        val fields = pk.fields
        require(!fields.isNullOrEmpty()) { "identity.primary on '${mc.shortName}' declares no @fields" }
        return fields[0]
    }

    /** Physical column names of an entity (metadata field names; the corpus declares no @column renames). */
    private fun columnNames(mc: MetaObject): List<String> = mc.metaFields.map { it.name }

    /**
     * Compare two key values by string-coerced identity. The source id comes from
     * the scenario `by:` (e.g. an Int) while the junction FK value comes straight
     * off the driver (which may surface a BIGINT key as a different numeric type);
     * comparing by toString() bridges that the same way the TS / Java resolvers do.
     */
    private fun keyEquals(a: Any?, b: Any?): Boolean {
        if (a == null || b == null) return a === b
        return a.toString() == b.toString()
    }

    private fun mustGetEntity(root: MetaRoot, name: String?): MetaObject {
        val bare = stripPackage(name)
        for (child in root.getChildren(MetaObject::class.java, false)) {
            if (bare == child.shortName) return child
        }
        error("Entity '$name' not found in model root")
    }

    private fun stripPackage(name: String?): String? {
        if (name == null) return null
        val idx = name.lastIndexOf(MetaData.PKG_SEPARATOR)
        return if (idx >= 0) name.substring(idx + MetaData.PKG_SEPARATOR.length) else name
    }
}

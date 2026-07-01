package com.metaobjects.generator.kotlin

import com.metaobjects.loader.MetaDataLoader
import com.metaobjects.`object`.MetaObject
import com.metaobjects.relationship.M2MFields
import com.metaobjects.relationship.MetaRelationship

/**
 * FR-018 Unit 13 M:N codegen support — resolves the many-to-many relationships
 * declared on an entity into the data the Kotlin generators need to emit
 * navigation (the Exposed junction-join query helper + the controller traversal
 * endpoint).
 *
 * A M:N relationship is a `relationship.*` child with `@cardinality: "many"` that
 * declares `@through` (the junction entity). The junction FK columns are NOT
 * restated on the relationship — they are DERIVED from the junction entity's two
 * `identity.reference` children via the cross-port SSOT [M2MFields.derive]. This
 * helper is the Kotlin mirror of the Java codegen-spring `SpringM2mSupport`: it
 * surfaces the same derived `(sourceField, targetField, symmetric)` so the emitted
 * Exposed join + controller route traverse the junction with identical semantics
 * to the runtime resolver and the cross-port REST contract.
 *
 * Cross-port REST contract (see `fixtures/api-contract-conformance/m2m/README.md`):
 * ```
 *   GET {prefix}/<source-plural>/:id/<relationName>  ->  the related target rows
 * ```
 * The source URL segment is the source entity name pluralized
 * ([com.metaobjects.object.MetaObject.getShortName] → lowercase + "s", e.g.
 * `Person` → `persons`); the relation segment is the relationship `name`;
 * related-row order is not contractual.
 */
object KotlinM2mSupport {

    /**
     * One resolved M:N navigation on a source entity.
     *
     * @property relationName     the relationship `name` (URL relation segment + helper stem)
     * @property targetShortName  the target entity short name (e.g. `Tag`)
     * @property targetTableObj   the target Exposed `Table` object name (e.g. `TagTable`)
     * @property junctionTableObj the junction (through) Exposed `Table` object name (e.g. `PostTagTable`)
     * @property junctionShortName the junction (through) entity short name (e.g. `PostTag`)
     * @property sourceField      the junction FK field holding the source key (derived)
     * @property targetField      the junction FK field holding the target key (derived)
     * @property targetPkField    the target entity's single primary-key field name
     * @property targetPackage    the target entity's Kotlin package (for cross-package data-class qualification)
     * @property targetScalarFields the target entity's scalar (non-object) field names, in declaration order
     * @property symmetric        `true` for an undirected self-join (union-on-read)
     */
    data class M2mNav(
        val relationName: String,
        val targetShortName: String,
        val targetTableObj: String,
        val junctionTableObj: String,
        val junctionShortName: String,
        val sourceField: String,
        val targetField: String,
        val targetPkField: String,
        val targetPackage: String,
        val targetScalarFields: List<String>,
        val symmetric: Boolean,
    )

    /**
     * Resolve every M:N relationship declared on [entity]. Returns an empty list
     * when the entity declares none. Each entry's junction FK fields are derived
     * from the junction's `identity.reference` children.
     *
     * @param entity the source entity
     * @param loader the loader (for the model root, to find junction + target entities)
     * @return the resolved M:N navigations, in declaration order
     */
    fun resolve(entity: MetaObject, loader: MetaDataLoader): List<M2mNav> {
        val root = loader.root
        val out = ArrayList<M2mNav>()
        for (rel in entity.relationships) {
            if (rel.cardinality != MetaRelationship.CARDINALITY_MANY) continue
            val through = rel.through
            if (through.isNullOrEmpty()) continue

            val fields = M2MFields.derive(rel, entity, root)
            val target = KotlinGenUtil.resolveObjectByShortOrFqn(loader, rel.objectRef ?: continue) ?: continue
            val junction = KotlinGenUtil.resolveObjectByShortOrFqn(loader, through) ?: continue

            val (targetPkg, targetShort) = PackageMapping.splitFqn(target.name)
            val junctionShort = PackageMapping.splitFqn(junction.name).second
            val targetScalars = target.metaFields
                .filterNot { it is com.metaobjects.field.ObjectField || it is com.metaobjects.field.MapField }
                .map { it.name }

            out.add(
                M2mNav(
                    relationName = rel.shortName ?: rel.name,
                    targetShortName = targetShort,
                    targetTableObj = targetShort + "Table",
                    junctionTableObj = junctionShort + "Table",
                    junctionShortName = junctionShort,
                    sourceField = fields.sourceField,
                    targetField = fields.targetField,
                    targetPkField = primaryKeyField(target),
                    targetPackage = targetPkg,
                    targetScalarFields = targetScalars,
                    symmetric = rel.isSymmetric,
                )
            )
        }
        return out
    }

    /** The single primary-key field name of an entity (defaults to `id`). */
    private fun primaryKeyField(entity: MetaObject): String {
        // ADR-0039: identities are inheritable — RESOLVE via getIdentities(true);
        // entity.children (own-only) would miss an inherited primary identity.
        val pk = entity.getIdentities(true)
            .filterIsInstance<com.metaobjects.identity.MetaIdentity>()
            .firstOrNull { it.isPrimary }
        return pk?.fields?.firstOrNull() ?: "id"
    }
}

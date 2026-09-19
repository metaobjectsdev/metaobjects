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
     * FW-3 — the target of an M:N is a TPH subtype: its rows live in the discriminator base's
     * shared table, so a stage-2 select against that table must be narrowed back to just this
     * subtype's rows, or a sibling subtype's row (e.g. a Copay reached through `Auth`'s shared
     * table) comes back tagged as this one.
     *
     * @property column   the discriminator field's physical column name (on the STORAGE object)
     * @property valueExpr the ready-to-splice Kotlin expression for the subtype's discriminator
     *                     value (e.g. `"AuthType.Bridge"` when the discriminator is a materialized
     *                     enum) — computed once here so neither call site (the Exposed join query
     *                     nor the controller) needs to re-resolve the enum type itself.
     */
    data class TargetDiscriminator(val column: String, val valueExpr: String)

    /**
     * One resolved M:N navigation on a source entity.
     *
     * @property relationName     the relationship `name` (URL relation segment + helper stem)
     * @property targetShortName  the target's short name — the DECLARED target's own name (e.g.
     *                            `BridgeAuth`) is preserved here for diagnostics/naming even when
     *                            [targetTableObj] is redirected to the storage object
     * @property targetTableObj   the STORAGE object's Exposed `Table` object name (e.g. `TagTable`,
     *                            or `AuthTable` when the declared target is the `BridgeAuth` TPH
     *                            subtype — see [KotlinTphPlan.storageObjectOf])
     * @property junctionTableObj the junction (through) Exposed `Table` object name (e.g. `PostTagTable`)
     * @property junctionShortName the junction (through) entity short name (e.g. `PostTag`)
     * @property sourceField      the junction FK field holding the source key (derived)
     * @property targetField      the junction FK field holding the target key (derived)
     * @property targetPkField    the STORAGE object's single primary-key field name
     * @property targetPackage    the STORAGE object's Kotlin package (for cross-package data-class qualification)
     * @property targetType       the Kotlin data-class type name rows are mapped into — the STORAGE
     *                            object's short name (e.g. `Auth`, the union type, when the declared
     *                            target is a TPH subtype; otherwise same as [targetShortName])
     * @property targetScalarFields the STORAGE object's scalar (non-object) field names, in
     *                            declaration order (the union's full column set when redirected —
     *                            exactly what `rowTo<Base>` maps, so the mapping here matches)
     * @property targetDiscriminator non-null when the declared target is a TPH subtype: the
     *                            column + value the stage-2 select must additionally filter on
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
        val targetType: String,
        val targetScalarFields: List<String>,
        val targetDiscriminator: TargetDiscriminator?,
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
            val declaredTarget = KotlinGenUtil.resolveObjectByShortOrFqn(loader, rel.objectRef ?: continue) ?: continue
            val junction = KotlinGenUtil.resolveObjectByShortOrFqn(loader, through) ?: continue

            // FW-3: a TPH subtype (e.g. `BridgeAuth`) has no Exposed Table object and no data
            // class of its own — its rows live in, and are shaped like, the discriminator base's
            // (`AuthTable` / `Auth`). Redirect the target's PHYSICAL identity to that storage
            // object; `targetShortName` above keeps naming the DECLARED target for diagnostics.
            val target = KotlinTphPlan.storageObjectOf(declaredTarget)
            val junctionShort = PackageMapping.splitFqn(junction.name).second
            val (targetPkg, targetShort) = PackageMapping.splitFqn(target.name)
            val declaredShort = PackageMapping.splitFqn(declaredTarget.name).second
            // The STORAGE object's full column set — base + folded subtype columns when it is a
            // TPH base (empty fold for a plain entity) — because that is what a row selected from
            // its table actually carries, and what `rowTo<Base>` maps it into elsewhere.
            val targetScalars = (target.metaFields + KotlinTphPlan.collectSubtypeFields(target, loader))
                .filterNot { it is com.metaobjects.field.ObjectField || it is com.metaobjects.field.MapField }
                .map { it.name }
                .distinct()

            // `target !== declaredTarget` means the declared target WAS a TPH subtype (redirected
            // to its storage object by KotlinTphPlan.storageObjectOf above) — so narrowing back to
            // just the declared target's own rows IS required here; every step below MUST resolve.
            // A step that can't (e.g. an ABSTRACT mid-level `@objectRef` with no own
            // @discriminatorValue of its own to filter by) is NOT silently left unfiltered —
            // that would silently WIDEN the query to every sibling subtype's rows sharing the
            // storage table, the exact "silently dropping target narrowing" defect this loud
            // failure replaces — but a hard M2MDerivationException, matching this port's (and the
            // Java/Python ports') stance on an underivable M:N: fail the build, don't skip.
            val targetDiscriminator = if (target !== declaredTarget) {
                val relLabel = "${entity.shortName}.${rel.shortName ?: rel.name}"
                val discField = KotlinTphPlan.discriminatorFieldOf(target)
                    ?: throw M2MFields.M2MDerivationException(
                        "M:N relationship \"$relLabel\": target \"${declaredTarget.name}\" is a TPH " +
                            "subtype folded into storage object \"${target.name}\", but no " +
                            "@discriminator field could be resolved on it — target narrowing cannot " +
                            "be derived."
                    )
                val discValue = KotlinTphPlan.discriminatorValueOf(declaredTarget)
                    ?: throw M2MFields.M2MDerivationException(
                        "M:N relationship \"$relLabel\": target \"${declaredTarget.name}\" declares no " +
                            "own @discriminatorValue — target narrowing cannot be derived."
                    )
                val discMetaField = target.metaFields.firstOrNull { it.name == discField }
                    ?: throw M2MFields.M2MDerivationException(
                        "M:N relationship \"$relLabel\": discriminator field \"$discField\" does not " +
                            "resolve to a field on storage object \"${target.name}\" — target narrowing " +
                            "cannot be derived."
                    )
                val enumSimple = runCatching { KotlinTypeMapper.enumTypeName(discMetaField, target)?.simpleName }
                    .getOrNull()
                    ?: throw M2MFields.M2MDerivationException(
                        "M:N relationship \"$relLabel\": discriminator field \"$discField\" on " +
                            "\"${target.name}\" is not a materialized enum — target narrowing cannot " +
                            "be derived."
                    )
                TargetDiscriminator(discField, "$enumSimple.$discValue")
            } else null

            out.add(
                M2mNav(
                    relationName = rel.shortName ?: rel.name,
                    targetShortName = declaredShort,
                    targetTableObj = targetShort + "Table",
                    junctionTableObj = junctionShort + "Table",
                    junctionShortName = junctionShort,
                    sourceField = fields.sourceField,
                    targetField = fields.targetField,
                    targetPkField = primaryKeyField(target),
                    targetPackage = targetPkg,
                    targetType = targetShort,
                    targetScalarFields = targetScalars,
                    targetDiscriminator = targetDiscriminator,
                    symmetric = rel.isSymmetric,
                )
            )
        }
        return out
    }

    /**
     * A resolved [M2mNav] paired with the Exposed query-helper function name it must be
     * emitted/called under — see [tphQueryFnNames]. [defaultQueryFnName] in the common case
     * (no TPH shadow); disambiguated when one is present.
     */
    data class NamedM2mNav(val nav: M2mNav, val queryFnName: String)

    /** The DEFAULT Exposed query-helper function name for a relation name: `<name>Query`. */
    fun defaultQueryFnName(relationName: String): String = "${relationName}Query"

    /**
     * FW-8 follow-up — TPH-group-wide M:N query-helper NAME assignment, keyed by the resolved
     * [M2mNav] VALUE (structural/data-class equality) so [KotlinRelationsGenerator] (which
     * computes this once per discriminator base, to decide both WHICH distinct navs need a
     * helper and what to NAME each) and [KotlinSpringControllerGenerator] (which independently
     * re-resolves each subtype's own navs for its return type + row mapping, and needs to call
     * the SAME helper by name) land on the IDENTICAL name for the identical nav, with no shared
     * mutable state between the two generators.
     *
     * Per relation NAME, the FIRST [M2mNav] shape encountered — walking [base]'s own navs, then
     * each subtype's own navs in [plan]'s (already name-sorted) subtype order — wins the plain
     * [defaultQueryFnName]. That is EXACTLY the pre-existing dedup-by-name behaviour for the
     * overwhelming common case where every mount of a name resolves to the identical nav (an
     * inherited relationship resolves unchanged through every subtype it folds into), so that
     * case stays byte-identical to pre-existing generated output.
     *
     * A subtype may legally SHADOW a name with a genuinely different [M2mNav] — own children
     * shadow super on `(type, name)` (ADR-0039's resolving-accessor contract), so the loader
     * accepts a subtype redeclaring a relationship name onto a different `@objectRef`/`@through`.
     * That shadowing shape is a DISTINCT mount and must not collapse into the first shape's
     * helper (doing so silently reused a wrong-target/wrong-junction query — see
     * `KotlinTphM2mShadowedCodegenTest`). It gets its OWN helper, suffixed by the
     * `@discriminatorValue` of the subtype that first introduces it (mirrors the Java port's
     * per-subtype finder shape, `SpringRepositoryGenerator.m2mFinderNameForSubtype` /
     * `findTagsForBridge`): `<name><Suffix>Query`. A LATER mount whose nav resolves to that SAME
     * shape (structural equality) reuses that same helper rather than minting another — so two
     * subtypes shadowing a name identically still share one helper, matching the plain-name case.
     */
    fun tphQueryFnNames(base: MetaObject, plan: KotlinTphPlan.Plan, loader: MetaDataLoader): Map<M2mNav, String> {
        val names = LinkedHashMap<M2mNav, String>()
        val firstShapePerName = HashMap<String, M2mNav>()
        fun visit(navs: List<M2mNav>, suffixSource: String?) {
            for (nav in navs) {
                if (nav in names) continue
                val firstShape = firstShapePerName[nav.relationName]
                if (firstShape == null) {
                    firstShapePerName[nav.relationName] = nav
                    names[nav] = defaultQueryFnName(nav.relationName)
                } else {
                    val suffix = suffixSource?.let { KotlinNaming.capitalizeFirst(it) }.orEmpty()
                    names[nav] = "${nav.relationName}${suffix}Query"
                }
            }
        }
        visit(resolve(base, loader), null)
        for (st in plan.subtypes) visit(resolve(st.entity, loader), st.value)
        return names
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

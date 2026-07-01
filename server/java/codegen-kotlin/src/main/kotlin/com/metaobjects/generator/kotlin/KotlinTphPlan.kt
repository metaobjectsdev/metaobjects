package com.metaobjects.generator.kotlin

import com.metaobjects.field.MetaField
import com.metaobjects.loader.MetaDataLoader
import com.metaobjects.`object`.MetaObject
import java.util.Locale

/**
 * FR-017 Tier 4 — codegen-side descriptor for a table-per-hierarchy (TPH) base, for the Kotlin
 * generators. Mirrors the Java `TphPlan` / C# `TphPlanBuilder` / Python `tph_plan.py`.
 *
 * An `object.entity` carrying `@discriminator` is the TPH base; concrete entities that `extends`
 * it and declare `@discriminatorValue` are its subtypes, all sharing ONE physical table
 * (single-table inheritance). This plan is the single source of truth the TPH-aware Kotlin
 * generators (Exposed table / entity / controller) read, so the route-segment rule + subtype set
 * never drift. The per-subtype REST route segment is the `@discriminatorValue` lowercased — derived
 * in exactly one place ([routeSegment]).
 */
object KotlinTphPlan {

    /** One concrete subtype bound to a TPH base. */
    data class Subtype(val entity: MetaObject, val value: String, val routeSegment: String)

    /** The polymorphic shape of a TPH base: discriminator field + name-sorted subtypes. */
    data class Plan(val base: MetaObject, val discriminatorField: String, val subtypes: List<Subtype>)

    /** The per-subtype REST route segment for a discriminator value — the value lowercased. */
    fun routeSegment(discriminatorValue: String): String = discriminatorValue.lowercase(Locale.ROOT)

    /**
     * The nearest `@discriminator`-bearing ancestor (or self), walking `extends`.
     * ADR-0039: this IS the super-resolution walk — `@discriminator`/`@discriminatorValue`
     * are declaration-layer TPH markers (never inherited into an effective form), so each
     * hop is read own-only while the loop does the resolving.
     */
    private fun discriminatorRoot(obj: MetaObject): MetaObject? {
        var cursor: MetaObject? = obj
        while (cursor != null) {
            if (cursor.hasMetaAttr(MetaObject.ATTR_DISCRIMINATOR, false)) return cursor
            cursor = cursor.superObject
        }
        return null
    }

    /**
     * True when [obj] is a concrete TPH subtype: it declares `@discriminatorValue` (own attr) and
     * (transitively) extends a `@discriminator`-bearing base. Such an entity emits NO standalone
     * table/controller — it is folded into the base's single table.
     */
    fun isTphSubtype(obj: MetaObject): Boolean {
        // ADR-0039: @discriminatorValue is declaration-layer — each subtype declares its
        // own; never inherited. KEPT own-only.
        if (!obj.hasMetaAttr(MetaObject.ATTR_DISCRIMINATOR_VALUE, false)) return false
        val root = discriminatorRoot(obj)
        return root != null && root !== obj
    }

    /**
     * The [Plan] for a discriminator base, or null when [base] is not a discriminator base
     * (no `@discriminator`, or no concrete subtypes extending it).
     */
    fun planFor(base: MetaObject, loader: MetaDataLoader): Plan? {
        // ADR-0039: @discriminator/@discriminatorValue are declaration-layer TPH markers,
        // never inherited into an effective form — read own-only. (`base` is already the
        // discriminator-bearing node resolved via discriminatorRoot's super walk.)
        if (!base.hasMetaAttr(MetaObject.ATTR_DISCRIMINATOR, false)) return null
        val discField = base.getMetaAttr(MetaObject.ATTR_DISCRIMINATOR, false).valueAsString
        if (discField.isNullOrEmpty()) return null

        val subtypes = mutableListOf<Subtype>()
        for (obj in loader.metaObjects) {
            if (obj === base) continue
            if (obj.subType != MetaObject.SUBTYPE_ENTITY) continue
            if (KotlinGenUtil.isAbstractEntity(obj)) continue
            // ADR-0039: @discriminatorValue is declaration-layer — each subtype declares
            // its own; never inherited. KEPT own-only.
            if (!obj.hasMetaAttr(MetaObject.ATTR_DISCRIMINATOR_VALUE, false)) continue
            val value = obj.getMetaAttr(MetaObject.ATTR_DISCRIMINATOR_VALUE, false).valueAsString
            if (value.isNullOrEmpty()) continue
            // Walk the extends chain looking for `base`.
            var cursor: MetaObject? = obj.superObject
            var found = false
            while (cursor != null) {
                if (cursor === base) { found = true; break }
                cursor = cursor.superObject
            }
            if (!found) continue
            subtypes.add(Subtype(obj, value, routeSegment(value)))
        }
        if (subtypes.isEmpty()) return null
        subtypes.sortBy { it.entity.name }
        return Plan(base, discField, subtypes)
    }

    /** True when [obj] carries `@discriminator` AND has at least one concrete subtype. */
    fun isTphBase(obj: MetaObject, loader: MetaDataLoader): Boolean = planFor(obj, loader) != null

    /**
     * The subtype-only fields folded into the base's single TPH table, deduplicated by name across
     * subtypes in name-sorted subtype order. Each is emitted by the caller as a NULLABLE (no-
     * validation) column/property — a row of any other subtype stores null there, even when the
     * field is `@required`. Base fields are excluded. Mirrors C# `CollectSubtypeFields`.
     */
    fun collectSubtypeFields(base: MetaObject, loader: MetaDataLoader): List<MetaField<*>> {
        val plan = planFor(base, loader) ?: return emptyList()
        return collectSubtypeFields(base, plan)
    }

    /** [collectSubtypeFields] from an already-resolved [Plan] (the generators that hold one). */
    fun collectSubtypeFields(base: MetaObject, plan: Plan): List<MetaField<*>> {
        val baseNames = base.metaFields.map { it.name }.toHashSet()
        val seen = hashSetOf<String>()
        val out = mutableListOf<MetaField<*>>()
        for (st in plan.subtypes) {
            for (f in st.entity.metaFields) {
                if (f.name in baseNames) continue   // base column — already emitted
                if (!seen.add(f.name)) continue      // shared subtype column — emit once
                out.add(f)
            }
        }
        return out
    }
}

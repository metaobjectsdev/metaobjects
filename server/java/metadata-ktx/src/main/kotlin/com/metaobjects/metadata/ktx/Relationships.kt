package com.metaobjects.metadata.ktx

import com.metaobjects.`object`.MetaObject
import com.metaobjects.relationship.MetaRelationship

/**
 * Typed nullable enum + reference resolution for [MetaRelationship].
 *
 * Java exposes `@cardinality` as a raw String drawn from a closed set
 * ([MetaRelationship.CARDINALITY_ONE], [MetaRelationship.CARDINALITY_MANY]).
 * Java does NOT ship a `getTargetObject()` — only `getObjectRef()` returning
 * the raw `@objectRef` string (bare or FQN). This module resolves it against
 * the owning loader, accepting either form.
 */
enum class Cardinality { ONE, MANY }

/** Typed view of [MetaRelationship.getCardinality]; null on absent or unrecognized value. */
val MetaRelationship.cardinalityType: Cardinality?
    get() = when (cardinality?.lowercase()) {
        MetaRelationship.CARDINALITY_ONE -> Cardinality.ONE
        MetaRelationship.CARDINALITY_MANY -> Cardinality.MANY
        else -> null
    }

/**
 * The object `@objectRef` names; null if absent or unresolved. Reads the target the loader
 * bound once (ADR-0059 R7); a short name never matches a packaged object.
 */
val MetaRelationship.targetObjectOrNull: MetaObject?
    get() = com.metaobjects.loader.References.refTarget(this, "objectRef")

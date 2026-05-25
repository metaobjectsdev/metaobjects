package com.metaobjects.metadata.ktx

import com.metaobjects.MetaData
import com.metaobjects.MetaDataNotFoundException
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
 * Resolve `@objectRef` against this relationship's owning loader; null if absent or unresolved.
 *
 * Tries the value as an FQN first ([com.metaobjects.loader.MetaDataLoader.getMetaObjectByName]);
 * falls back to a short-name scan of the loader's root, mirroring what the validation phase
 * does for origin `@via` path resolution (origin/relationship attrs accept bare entity names).
 */
val MetaRelationship.targetObjectOrNull: MetaObject?
    get() {
        val ref = objectRef ?: return null
        val loader = loader ?: return null
        try {
            return loader.getMetaObjectByName(ref)
        } catch (_: MetaDataNotFoundException) {
            // fall through to short-name scan
        }
        return loader.root.getChildren(MetaData::class.java, false)
            .asSequence()
            .filterIsInstance<MetaObject>()
            .firstOrNull { it.shortName == ref || it.name == ref }
    }

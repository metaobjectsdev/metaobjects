package com.metaobjects.generator.kotlin

import com.metaobjects.field.MetaField
import com.metaobjects.loader.MetaDataLoader
import com.metaobjects.`object`.MetaObject

/**
 * Internal helpers shared by the codegen-kotlin generators. Extracted to keep
 * the three generators (entity / exposed-table / payload) from carrying near-identical
 * private copies of the same lookups.
 */
internal object KotlinGenUtil {

    /**
     * Resolve a MetaObject (entity OR value) by exact FQN match or by short-name match
     * (the trailing segment after the last `::`). Returns null when neither matches.
     */
    fun resolveObjectByShortOrFqn(loader: MetaDataLoader, ref: String): MetaObject? {
        for (child in loader.metaObjects) {
            if (child.name == ref || child.name.substringAfterLast("::") == ref) return child
        }
        return null
    }

    /**
     * Split `"A.b"` into `("A","b")`; null if the ref isn't a single-dot ref
     * (no dot, leading dot, or trailing dot).
     */
    fun splitDottedRef(ref: String): Pair<String, String>? {
        val dot = ref.indexOf('.')
        if (dot <= 0 || dot >= ref.length - 1) return null
        return ref.substring(0, dot) to ref.substring(dot + 1)
    }

    /**
     * Required iff explicit `@required: true` attribute is set on the field (inheritance
     * allowed); otherwise nullable. MVP heuristic — refined when richer required-detection
     * lands (see fr-003 spec).
     */
    fun isRequiredField(field: MetaField<*>): Boolean {
        if (!field.hasMetaAttr(MetaField.ATTR_REQUIRED, true)) return false
        val raw = runCatching { field.getMetaAttr(MetaField.ATTR_REQUIRED, true).value }.getOrNull()
        return when (raw) {
            is Boolean -> raw
            is String -> raw.equals("true", ignoreCase = true)
            else -> false
        }
    }
}

package com.metaobjects.generator.kotlin

import com.metaobjects.MetaData
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
     * True if [obj] has an own `@isAbstract` attribute set to boolean-true. Reads only the
     * own attribute (not inherited) — matches the ValidationPhase convention so concrete
     * subtypes extending an abstract base still emit. Shared by every instance/write
     * generator so the "never emit write artifacts for an abstract entity" invariant has a
     * single definition.
     */
    fun isAbstractEntity(obj: MetaObject): Boolean {
        if (!obj.hasMetaAttr(MetaData.ATTR_IS_ABSTRACT, false)) return false
        val v = runCatching { obj.getMetaAttr(MetaData.ATTR_IS_ABSTRACT, false).value }.getOrNull()
        return when (v) {
            is Boolean -> v
            is String -> v.equals("true", ignoreCase = true)
            else -> false
        }
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

    /**
     * Convert a camelCase identifier to snake_case for use as a physical SQL column name.
     *
     * Used by [KotlinExposedTableGenerator] so the column-name string argument matches the
     * snake_case convention nearly every Postgres schema uses, while the Kotlin property name
     * stays camelCase (Kotlin convention). Examples:
     * ```
     * camelToSnake("displayName") == "display_name"
     * camelToSnake("htmlContent") == "html_content"
     * camelToSnake("id")          == "id"
     * camelToSnake("userId")      == "user_id"
     * camelToSnake("URLPath")     == "url_path"   // leading run of caps treated as one word
     * ```
     *
     * The algorithm inserts `_` before any uppercase letter that is preceded by either a
     * lowercase letter OR by another uppercase letter immediately followed by a lowercase
     * letter (the second rule splits "URLPath" into "url_path" rather than "u_r_l_path").
     * The whole result is then lowercased. Non-ASCII letters are passed through unchanged.
     */
    fun camelToSnake(name: String): String {
        if (name.isEmpty()) return name
        val sb = StringBuilder(name.length + 4)
        for (i in name.indices) {
            val c = name[i]
            if (i > 0 && c.isUpperCase()) {
                val prev = name[i - 1]
                val next = if (i + 1 < name.length) name[i + 1] else null
                // Insert underscore between [lower|digit][Upper] (standard camelCase boundary)
                // OR between [Upper][Upper][lower] (acronym → word boundary, e.g. URLPath → URL_Path)
                if (prev.isLowerCase() || prev.isDigit() ||
                    (prev.isUpperCase() && next != null && next.isLowerCase())) {
                    sb.append('_')
                }
            }
            sb.append(c.lowercaseChar())
        }
        return sb.toString()
    }
}

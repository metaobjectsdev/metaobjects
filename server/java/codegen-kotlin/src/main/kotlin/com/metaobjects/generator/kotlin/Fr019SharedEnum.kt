package com.metaobjects.generator.kotlin

import com.metaobjects.MetaRoot
import com.metaobjects.field.EnumField
import com.metaobjects.field.MetaField
import com.metaobjects.generator.GeneratorException
import com.metaobjects.generator.util.GeneratorUtil
import com.squareup.kotlinpoet.ClassName

/**
 * FR-019 — shared + externally-provided enum resolution (Kotlin port of the TS reference
 * `enum-shared.ts`, the C# `Fr019SharedEnum`, and the Java `Fr019SharedEnum`).
 *
 * Kotlin already materializes a package-level abstract `field.enum` ONCE as a standalone
 * `enum class` ([KotlinEnumEmitter] + [KotlinTypeMapper.enumTypeName], deduped by FQN), so the
 * shared-materialize half of FR-019 is already satisfied. This object adds the `@provided` arm:
 * detecting a `@provided` shared enum (skip materialization) and resolving its reference to a
 * per-port-configured namespace (ADR-0001 — never an FQN in metadata). The namespace binds to the
 * enum's declaring metadata package via a package→namespace map + a single fallback, both
 * generator args.
 */
internal object Fr019SharedEnum {

    /** Per-port config for resolving a `@provided` enum's Kotlin namespace. Generator args only. */
    data class ProvidedEnumConfig(val fallbackNamespace: String?, val packageNamespaces: Map<String, String>) {
        companion object {
            fun of(fallback: String?, packageMapArg: String?): ProvidedEnumConfig =
                ProvidedEnumConfig(fallback?.trim()?.takeIf { it.isNotEmpty() }, parsePackageMap(packageMapArg))
        }
    }

    /**
     * Parse the `providedEnumPackages` generator arg — a `;`-delimited list of
     * `<metaPackage>=<namespace>` entries (metadata package in `::` form), e.g.
     * `"acme::shop=com.acme.ext;acme::billing=com.acme.money"`. Empty map for null/blank.
     */
    fun parsePackageMap(arg: String?): Map<String, String> {
        if (arg.isNullOrBlank()) return emptyMap()
        val map = LinkedHashMap<String, String>()
        for (entry in arg.split(";")) {
            val eq = entry.indexOf('=')
            if (eq <= 0) continue
            val key = entry.substring(0, eq).trim()
            val value = entry.substring(eq + 1).trim()
            if (key.isNotEmpty() && value.isNotEmpty()) map[key] = value
        }
        return map
    }

    /**
     * The package-level abstract `field.enum` a concrete enum field resolves to via `extends`, or
     * `null` for an inline enum. Qualifies only when the immediate super is (a) an [EnumField],
     * (b) abstract, AND (c) a direct child of the metadata root ([MetaRoot]) — a sibling of
     * `object.entity`, not an abstract field nested inside an object.
     */
    fun resolveSharedEnumDecl(field: MetaField<*>): EnumField? {
        if (field !is EnumField) return null
        val sup = field.superField as? EnumField ?: return null
        if (!GeneratorUtil.isAbstract(sup)) return null
        if (sup.parent !is MetaRoot) return null
        return sup
    }

    /** Own-only read of `@provided` on an enum declaration. */
    fun isProvided(decl: EnumField): Boolean {
        if (!decl.hasMetaAttr(EnumField.ATTR_PROVIDED, false)) return false
        val raw = runCatching { decl.getMetaAttr(EnumField.ATTR_PROVIDED, false).value }.getOrNull()
        return when (raw) {
            is Boolean -> raw
            else -> raw?.toString()?.toBoolean() ?: false
        }
    }

    /** True iff [field] resolves to a `@provided` shared enum (its type is referenced, not emitted). */
    fun isProvidedEnumField(field: MetaField<*>): Boolean {
        val decl = resolveSharedEnumDecl(field) ?: return false
        return isProvided(decl)
    }

    /**
     * The [ClassName] a consuming property emits for a `@provided` shared enum — `<ns>.<Name>`, with
     * `ns` resolved from the package map (keyed by the enum's declaring metadata package) then the
     * single fallback. Throws a codegen-time [GeneratorException] naming the enum + package when
     * unresolved. Returns `null` when [field] is NOT a `@provided` shared enum, so the caller falls
     * back to the normal materialized [KotlinTypeMapper.enumTypeName].
     */
    fun providedClassName(field: MetaField<*>, config: ProvidedEnumConfig): ClassName? {
        val decl = resolveSharedEnumDecl(field) ?: return null
        if (!isProvided(decl)) return null
        val (_, shortRaw) = PackageMapping.splitFqn(decl.name)
        val simple = shortRaw.replaceFirstChar { it.uppercase() }
        val metaPackage = metaPackageOf(decl.name)
        val ns = config.packageNamespaces[metaPackage]?.takeIf { it.isNotBlank() } ?: config.fallbackNamespace
        if (ns.isNullOrBlank()) {
            throw GeneratorException(
                "provided enum \"$simple\" (declared in package \"$metaPackage\") is marked @provided " +
                "but no Kotlin namespace is configured to reference it from. Map its package via the " +
                "providedEnumPackages generator arg (\"$metaPackage=your.app.enums\") or set the single " +
                "providedEnumNamespace fallback, so the generated code can reference \"$simple\"."
            )
        }
        return ClassName(ns, simple)
    }

    /** The declaration's metadata package in `::` form, stripped of the trailing `::Name`. */
    private fun metaPackageOf(fqn: String): String {
        val idx = fqn.lastIndexOf("::")
        return if (idx < 0) "" else fqn.substring(0, idx)
    }
}

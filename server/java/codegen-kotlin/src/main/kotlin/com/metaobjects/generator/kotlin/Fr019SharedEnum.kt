package com.metaobjects.generator.kotlin

import com.metaobjects.field.EnumField
import com.metaobjects.field.MetaField
import com.metaobjects.generator.GeneratorException
import com.squareup.kotlinpoet.ClassName

/**
 * FR-019 — shared + externally-provided enum resolution (Kotlin port of the TS reference
 * `enum-shared.ts`, the C# `Fr019SharedEnum`, and the Java `Fr019SharedEnum`).
 *
 * Kotlin already materializes a package-level abstract `field.enum` ONCE as a standalone
 * `enum class` ([KotlinEnumEmitter] + [KotlinTypeMapper.enumTypeName], deduped by FQN), so the
 * shared-materialize half of FR-019 is already satisfied — [KotlinTypeMapper.enumTypeName] and
 * [resolveSharedEnumDecl] below both delegate to the SAME cross-generator authority,
 * `EnumField.resolveSharedEnumDeclaration` (metadata module), so the two can never disagree. This
 * object holds the `@provided` arm [KotlinTypeMapper.enumTypeName] applies: detecting a
 * `@provided` shared enum (skip materialization) and resolving its reference to a
 * per-port-configured namespace (ADR-0001 — never an FQN in metadata). The namespace binds to
 * the enum's declaring metadata package via a package→namespace map + a single fallback, both
 * generator args every generator that types an enum reads through [ProvidedEnumConfig.fromArgs].
 */
object Fr019SharedEnum {

    /** Generator arg: the single fallback namespace every `@provided` enum is referenced from. */
    const val ARG_PROVIDED_ENUM_NAMESPACE: String = "providedEnumNamespace"

    /** Generator arg: the `;`-delimited `<metaPackage>=<namespace>` map (see [parsePackageMap]). */
    const val ARG_PROVIDED_ENUM_PACKAGES: String = "providedEnumPackages"

    /** Per-port config for resolving a `@provided` enum's Kotlin namespace. Generator args only. */
    data class ProvidedEnumConfig(val fallbackNamespace: String?, val packageNamespaces: Map<String, String>) {
        companion object {
            /**
             * The config a generator's args declare — the ONE place the two arg names are read, so
             * every generator that types an enum resolves a `@provided` one from the same input.
             * Absent args give a config under which a `@provided` enum is a [GeneratorException].
             */
            @JvmStatic
            fun fromArgs(args: Map<String, String>?): ProvidedEnumConfig =
                ProvidedEnumConfig(
                    args?.get(ARG_PROVIDED_ENUM_NAMESPACE)?.trim()?.takeIf { it.isNotEmpty() },
                    parsePackageMap(args?.get(ARG_PROVIDED_ENUM_PACKAGES)),
                )
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
     * The shared-enum declaration [field] resolves to via `extends`, or `null` when the field is
     * an inline enum. Delegates entirely to the single cross-generator authority,
     * `EnumField.resolveSharedEnumDeclaration` (metadata module) — the SAME function
     * [KotlinTypeMapper.enumTypeName], the Java/Spring port, and the loader's #246 validator call,
     * so no two of them can disagree about what "shared" means. See that method's Javadoc for the
     * full rule (nearest-declaration-wins, an own-`@values`/`@intValueMap` node stops the walk, no
     * hop limit, no hosting-object-subtype condition).
     */
    fun resolveSharedEnumDecl(field: MetaField<*>): EnumField? =
        EnumField.resolveSharedEnumDeclaration(field) as? EnumField

    /**
     * Read `@provided` on an enum declaration. ADR-0039: `@provided` is a
     * declaration-layer marker (like `@isAbstract`) — describes THIS declaration,
     * never inherited through extends. KEPT own-only.
     */
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
     * The [ClassName] of the `@provided` shared enum [decl] — `<ns>.<Name>`, with `ns` resolved
     * from the package map (keyed by the enum's declaring metadata package) then the single
     * fallback. Throws a codegen-time [GeneratorException] naming the enum, its package and the
     * two args when neither resolves, so no generator can emit a reference to a class nothing
     * writes. Called only by [KotlinTypeMapper.enumTypeName].
     */
    fun providedClassName(decl: EnumField, config: ProvidedEnumConfig): ClassName {
        val (_, shortRaw) = PackageMapping.splitFqn(decl.name)
        val simple = shortRaw.replaceFirstChar { it.uppercase() }
        val metaPackage = metaPackageOf(decl.name)
        val ns = config.packageNamespaces[metaPackage]?.takeIf { it.isNotBlank() } ?: config.fallbackNamespace
        if (ns.isNullOrBlank()) {
            throw GeneratorException(
                "provided enum \"$simple\" (declared in package \"$metaPackage\") is marked @provided " +
                "but no Kotlin namespace is configured to reference it from. Map its package via the " +
                "$ARG_PROVIDED_ENUM_PACKAGES generator arg (\"$metaPackage=your.app.enums\") or set the single " +
                "$ARG_PROVIDED_ENUM_NAMESPACE fallback, so the generated code can reference \"$simple\"."
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

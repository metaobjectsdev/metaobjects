package com.metaobjects.generator.kotlin

// Eject note (ADR-0034 Amendment 8): `mvn metaobjects:eject` copies this file with the generator
// that calls it. The engine siblings stay in com.metaobjects.generator.kotlin, so each is imported
// by name — a bare same-package reference would not resolve from the copy.
import com.metaobjects.generator.kotlin.Fr019SharedEnum
import com.metaobjects.generator.kotlin.KotlinTypeMapper
import com.metaobjects.generator.kotlin.writer.KotlinClassName
import com.metaobjects.generator.kotlin.writer.KotlinWriter

import com.metaobjects.field.EnumField
import com.metaobjects.generator.util.GeneratedFileWriter
import com.metaobjects.`object`.MetaObject
import java.nio.file.Path

/**
 * Shared emitter for the standalone `@Serializable enum class <Name>` file backing a
 * `field.enum`. Used by [KotlinEntityGenerator] for every value-shaped and entity object, so the
 * enum class — its name (via [KotlinTypeMapper.enumTypeName]) and its members (the `@values`
 * verbatim) — is emitted by exactly one piece of code, owned by the object that declares the field
 * (the template tier references these enums and emits none, ADR-0056).
 *
 * <p>Cross-port parity: the Kotlin sibling of the C# `EntityGenerator` enum emission,
 * the TS union emitter, and the Python `Literal` emitter — all of which reuse the entity
 * enum naming/members for the payload path.</p>
 */
object KotlinEnumEmitter {

    /**
     * Emit a top-level `@Serializable enum class` for an [field.enum] hung off [owner] into
     * [outRoot] (package directories created under it), laid out by [KotlinWriter]. Members come from the
     * field's required `@values` string-array attr — emitted verbatim to preserve case
     * (typically SCREAMING_SNAKE_CASE per spec). No-op (returns false) when [field] is not an
     * enum or has no `@values` (defensive — the loader's ValidationPhase already requires
     * non-empty `@values`).
     *
     * <p>Deduped by enum-class FQN via [emittedFqns]: two fields that share an abstract enum
     * super resolve (via [KotlinTypeMapper.enumTypeName]) to the SAME class name and emit ONE
     * file. Returns true iff a file was written.</p>
     */
    fun emitEnumFile(
        owner: MetaObject,
        field: EnumField,
        outRoot: Path,
        emittedFqns: MutableSet<String>,
        provided: Fr019SharedEnum.ProvidedEnumConfig,
    ): Boolean {
        // FR-019: a @provided shared enum is referenced externally, never materialized.
        if (!provided.providedInDeclarationPackage && Fr019SharedEnum.isProvidedEnumField(field)) return false
        val enumClassName = KotlinTypeMapper.enumTypeName(field, owner, provided) ?: return false
        if (!emittedFqns.add(enumClassName.canonicalName)) return false // dedupe by enum FQN
        // Read members from the DECLARATION (FR-019: EnumField.resolveSharedEnumDeclaration — the
        // same authority enumTypeName just resolved), never from whichever consuming field is
        // visited first, so output cannot depend on visit order. For an inline field (no reachable
        // declaration) the field itself IS the declaration-equivalent — its own resolving read.
        val declaration = EnumField.resolveSharedEnumDeclaration(field) as? EnumField ?: field
        val members = readEnumValues(declaration)
        if (members.isNullOrEmpty()) {
            // #259: a field.enum must resolve to a NON-EMPTY @values set — the loader's ValidationPhase
            // guarantees it (a root enum owns @values or fails ERR_MISSING_REQUIRED_ATTR; a field with a
            // super inherits it, resolved multi-hop). Reaching here with none means a loader gap or a
            // genuinely value-less enum; FAIL LOUDLY at generate-time instead of silently emitting no file
            // (which surfaces only later as a downstream "unresolved reference" compile error — the exact
            // failure #259 reported).
            error(
                "field.enum '${field.name}' on '${owner.name}' resolved to no @values — cannot emit enum " +
                    "class ${enumClassName.canonicalName}. A field.enum must declare or inherit a non-empty " +
                    "@values set."
            )
        }
        GeneratedFileWriter.write(enumFile(enumClassName, outRoot), enumSource(enumClassName, members))
        // Returns true for "this emitter handled the FQN", which is what the caller's dedupe
        // set means — deliberately NOT "bytes hit the disk". A refused (hand-owned) enum file
        // must still consume its FQN, or a second field sharing the enum super would re-emit
        // and re-refuse, turning one WARN into one per referencing field.
        return true
    }

    /**
     * [emitEnumFile] with no provided-enum config. It does not skip a `@provided` enum: as before
     * the config existed, the caller decides that with [Fr019SharedEnum.isProvidedEnumField].
     */
    @Deprecated(
        "Pass the generator's Fr019SharedEnum.ProvidedEnumConfig.fromArgs(args) as a fifth argument; that form " +
            "skips a @provided enum itself.",
    )
    fun emitEnumFile(
        owner: MetaObject,
        field: EnumField,
        outRoot: Path,
        emittedFqns: MutableSet<String>,
    ): Boolean = emitEnumFile(owner, field, outRoot, emittedFqns, Fr019SharedEnum.ProvidedEnumConfig.DECLARATION_PACKAGE)

    /** The `enum class` file for [enumClassName] with [members], in declaration order. */
    private fun enumSource(enumClassName: KotlinClassName, members: List<String>): String {
        val w = KotlinWriter().packageName(enumClassName.packageName)
        w.doc("GENERATED — do not hand-edit. Regenerated from metadata.")
        w.line("@", w.use("kotlinx.serialization.Serializable"))
        w.block("enum class ${KotlinWriter.escapeName(enumClassName.simpleName)} {") {
            for (member in members) w.line(KotlinWriter.escapeName(member), ",")
        }
        return w.toString()
    }

    /** Where [enumClassName]'s file goes under [outRoot]: its package directory, `<Name>.kt`. */
    private fun enumFile(enumClassName: KotlinClassName, outRoot: Path): Path {
        val dir = if (enumClassName.packageName.isEmpty()) outRoot
            else outRoot.resolve(enumClassName.packageName.replace('.', '/'))
        return dir.resolve("${enumClassName.simpleName}.kt")
    }

    /**
     * Read the `@values` string-array attr, INCLUDING inherited values — a field that
     * `extends` an abstract enum super (e.g. `currentPriority extends Priority`) carries no own
     * `@values`; the members live on the super. Reads `getMetaAttr(ATTR_VALUES)` with parent data
     * (inheritance-aware). Null/empty when absent.
     */
    private fun readEnumValues(field: EnumField): List<String>? {
        if (!field.hasMetaAttr(EnumField.ATTR_VALUES)) return null
        val raw = runCatching { field.getMetaAttr(EnumField.ATTR_VALUES).value }.getOrNull()
        return when (raw) {
            is List<*> -> raw.mapNotNull { it?.toString() }
            else -> null
        }
    }
}

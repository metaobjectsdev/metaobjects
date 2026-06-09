package com.metaobjects.generator.kotlin

import com.metaobjects.field.EnumField
import com.squareup.kotlinpoet.ClassName
import com.squareup.kotlinpoet.FileSpec
import com.squareup.kotlinpoet.TypeSpec
import com.metaobjects.`object`.MetaObject
import java.nio.file.Path

/**
 * Shared emitter for the standalone `@Serializable enum class <Name>` file backing a
 * `field.enum`. Used by BOTH [KotlinEntityGenerator] (entity enums) and
 * [KotlinPayloadGenerator] (typed payload enums) so the enum class — its name (via
 * [KotlinTypeMapper.enumTypeName]) and its members (the `@values` verbatim) — is emitted
 * by exactly one piece of code. Keeps the entity and payload enum types byte-identical.
 *
 * <p>Cross-port parity: the Kotlin sibling of the C# `PayloadCodegen.CollectEnumDecls`,
 * the TS union emitter, and the Python `Literal` emitter — all of which reuse the entity
 * enum naming/members for the payload path.</p>
 */
internal object KotlinEnumEmitter {

    /**
     * Emit a top-level `@Serializable enum class` for an [field.enum] hung off [owner] into
     * [outRoot] (KotlinPoet package directories created under it). Members come from the
     * field's required `@values` string-array attr — emitted verbatim to preserve case
     * (typically SCREAMING_SNAKE_CASE per spec). No-op (returns false) when [field] is not an
     * enum or has no `@values` (defensive — the loader's ValidationPhase already requires
     * non-empty `@values`).
     *
     * <p>Deduped by enum-class FQN via [emittedFqns]: two fields that share an abstract enum
     * super resolve (via [KotlinTypeMapper.enumTypeName]) to the SAME ClassName and emit ONE
     * file. Returns true iff a file was written.</p>
     */
    fun emitEnumFile(
        owner: MetaObject,
        field: EnumField,
        outRoot: Path,
        emittedFqns: MutableSet<String>,
    ): Boolean {
        val enumClassName = KotlinTypeMapper.enumTypeName(field, owner) ?: return false
        if (!emittedFqns.add(enumClassName.canonicalName)) return false // dedupe by enum FQN
        val members = readEnumValues(field)
        if (members.isNullOrEmpty()) return false
        val serializable = ClassName("kotlinx.serialization", "Serializable")
        val enumBuilder = TypeSpec.enumBuilder(enumClassName.simpleName)
            .addAnnotation(serializable)
            .addKdoc("GENERATED — do not hand-edit. Regenerated from metadata.\n")
        for (member in members) {
            enumBuilder.addEnumConstant(member)
        }
        FileSpec.builder(enumClassName.packageName, enumClassName.simpleName)
            .addType(enumBuilder.build())
            .build()
            .writeTo(outRoot)
        return true
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

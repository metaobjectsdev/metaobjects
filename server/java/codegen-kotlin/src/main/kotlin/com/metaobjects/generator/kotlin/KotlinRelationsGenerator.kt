package com.metaobjects.generator.kotlin

import com.metaobjects.generator.GeneratorIOWriter
import com.metaobjects.generator.direct.MultiFileDirectGeneratorBase
import com.metaobjects.identity.MetaIdentity
import com.metaobjects.identity.ReferenceIdentity
import com.metaobjects.loader.MetaDataLoader
import com.metaobjects.`object`.MetaObject
import com.metaobjects.relationship.CompositionRelationship
import com.metaobjects.relationship.MetaRelationship
import com.squareup.kotlinpoet.LONG
import com.squareup.kotlinpoet.TypeName
import java.io.OutputStream
import java.io.PrintWriter
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths

/**
 * Generator: one `<Entity>Relations.kt` per `object.entity` carrying at least
 * one `relationship.composition @cardinality: many` child. Emits an ergonomic
 * Kotlin extension function per to-many declaration so consumers can write
 * `AuthorTable.postsQuery(author.id).toList()` instead of hand-rolling the
 * `selectAll().where { ... }` JOIN every time.
 *
 * <p>Pairs with {@link KotlinExposedTableGenerator}, which emits the SCHEMA
 * side (the inferred FK column on the many entity's table). This generator
 * owns the QUERY side — the inverse fetch from parent → children — and stays
 * separate from the table emitter so the two concerns don't get tangled.
 *
 * <p>The returned {@link org.jetbrains.exposed.sql.Query} keeps the helper
 * compositional: consumers can chain `.where { ... }`, `.orderBy(...)`,
 * `.limit(...)` etc. before materialising.
 *
 * <p>Convention (matches the inferred FK column emitted by
 * {@link KotlinExposedTableGenerator#buildInverseFkSpec}):
 * <ul>
 *   <li>FK column on the target table = {@code <ownerShort.lowercased()>Id}
 *       (e.g. {@code Author} → {@code authorId} on {@code PostTable}).</li>
 *   <li>Helper fn name = {@code <relShortName>Query} (e.g. {@code postsQuery}).</li>
 *   <li>Helper fn parameter = the parent's primary-key field type
 *       (resolved via {@code identity.primary.@fields[0]} + KotlinTypeMapper).</li>
 * </ul>
 *
 * <p>Skips silently when:
 * <ul>
 *   <li>The entity has no {@code source.rdb} child (no persistence layer).</li>
 *   <li>The entity has no to-many composition relationships.</li>
 *   <li>The target entity's short name cannot be resolved (defensive).</li>
 * </ul>
 *
 * <p>Args:
 * <ul>
 *   <li>{@code outputDir} (required): output directory root.</li>
 * </ul>
 */
open class KotlinRelationsGenerator : MultiFileDirectGeneratorBase<MetaObject>() {

    override fun getFilterClass(): Class<MetaObject> = MetaObject::class.java

    override fun execute(loader: MetaDataLoader) {
        parseArgs()
        val outRoot = Paths.get(outDir.absolutePath)

        for (entity in loader.metaObjects) {
            if (entity.subType != MetaObject.SUBTYPE_ENTITY) continue
            // Abstract entities are inheritance scaffolding — never emit relation helpers.
            if (KotlinGenUtil.isAbstractEntity(entity)) continue
            // No source.rdb → no persistence layer → no FK column to query against.
            // ADR-0039: resolving (an inherited source.rdb still means the entity is persisted).
            if (!KotlinGenUtil.hasRdbSource(entity)) continue

            val manyRels = entity.children
                .filterIsInstance<MetaRelationship>()
                .filter {
                    it.subType == CompositionRelationship.SUBTYPE_COMPOSITION &&
                        it.cardinality == MetaRelationship.CARDINALITY_MANY
                }
            // FR-018: M:N navs (any subtype, @cardinality:"many" + @through). Derived
            // junction FK fields via the cross-port SSOT (KotlinM2mSupport → M2MFields).
            val m2mNavs = KotlinM2mSupport.resolve(entity, loader)
            // ADR-0038: reverse navigation — one finder pair per FK this entity holds
            // (each single-field identity.reference).
            val reverseFks = reverseFksFor(entity)
            if (manyRels.isEmpty() && m2mNavs.isEmpty() && reverseFks.isEmpty()) continue

            emit(entity, manyRels, m2mNavs, reverseFks, outRoot, loader)
        }
    }

    protected open fun emit(
        entity: MetaObject,
        manyRels: List<MetaRelationship>,
        m2mNavs: List<KotlinM2mSupport.M2mNav>,
        reverseFks: List<ReverseFk>,
        outRoot: Path,
        loader: MetaDataLoader,
    ) {
        val (pkg, ownerShort) = PackageMapping.splitFqn(entity.name)
        val ownerTable = ownerShort + "Table"
        // TypeName.toString() yields the FQN (`kotlin.Long`, `java.util.UUID`, ...);
        // grab the trailing simple name for the generated source.
        val pkParamSimpleName = primaryKeyKotlinType(entity).toString().substringAfterLast('.')
        // FK column matches KotlinExposedTableGenerator.buildInverseFkSpec: <ownerShortLowercased>Id.
        val fkColName = ownerShort.replaceFirstChar { it.lowercaseChar() } + "Id"

        // Resolve each to-many composition target → (relShortName, targetShort). Skip
        // relationships whose @objectRef cannot be resolved (defensive — the loader's
        // validation phase already gates the attr being present).
        data class Helper(val relShortName: String, val targetTable: String)
        val helpers = manyRels.mapNotNull { rel ->
            val ref = rel.objectRef ?: return@mapNotNull null
            val target = KotlinGenUtil.resolveObjectByShortOrFqn(loader, ref) ?: return@mapNotNull null
            val targetShort = PackageMapping.splitFqn(target.name).second
            val relShort = rel.shortName ?: rel.name
            Helper(relShort, targetShort + "Table")
        }
        if (helpers.isEmpty() && m2mNavs.isEmpty() && reverseFks.isEmpty()) return

        val source = buildString {
            if (pkg.isNotEmpty()) {
                append("package $pkg\n\n")
            }
            append("import org.jetbrains.exposed.sql.Query\n")
            if (m2mNavs.isNotEmpty()) {
                append("import org.jetbrains.exposed.sql.JoinType\n")
                append("import org.jetbrains.exposed.sql.SqlExpressionBuilder.eq\n")
                // and / or are only used by the symmetric union-on-read branch's directional
                // ON clause (which keeps the self endpoint — no neq exclusion).
                if (m2mNavs.any { it.symmetric }) {
                    append("import org.jetbrains.exposed.sql.and\n")
                    append("import org.jetbrains.exposed.sql.or\n")
                }
            }
            append("import org.jetbrains.exposed.sql.selectAll\n")
            append("\n")
            append("/** GENERATED — extension fns for `$ownerShort` to-many relationships. Do not hand-edit. */\n")
            var first = true
            for (h in helpers) {
                if (!first) append("\n")
                first = false
                append("/** Query `$ownerShort.${h.relShortName}` (cardinality=many) on the ${h.targetTable.removeSuffix("Table")} side. */\n")
                append("fun $ownerTable.${h.relShortName}Query($fkColName: $pkParamSimpleName): Query =\n")
                append("    ${h.targetTable}.selectAll().where { ${h.targetTable}.$fkColName eq $fkColName }\n")
            }

            // FR-018 M:N junction-join query helpers. Each emits an Exposed Query that
            // INNER-JOINs the target table to the junction on the derived target-side FK,
            // returning the target rows whose junction row matches the source id. The
            // junction FK columns are derived (KotlinM2mSupport → M2MFields), never restated.
            //   * hetero / directed self-join: WHERE junction.<sourceField> = :id
            //   * symmetric self-join:         WHERE junction.<sourceField> = :id
            //                                     OR junction.<targetField> = :id (union-on-read)
            // The join keys the target by its PRIMARY KEY against the junction's target-side
            // FK; the source filter uses the junction's source-side FK. Related-row order is
            // not contractual.
            for (nav in m2mNavs) {
                if (!first) append("\n")
                first = false
                val symMarker = if (nav.symmetric) " (symmetric — union on read)" else ""
                append("/** Query `$ownerShort.${nav.relationName}` (M:N via ${nav.junctionShortName})$symMarker — the related ${nav.targetShortName} rows. */\n")
                append("fun $ownerTable.${nav.relationName}Query(sourceId: $pkParamSimpleName): Query =\n")
                if (nav.symmetric) {
                    // Symmetric storage is single-row; a friend appears via EITHER FK column.
                    // Union-on-read: for each junction row touching the source, the related id is
                    // the FK column that is NOT the source. We encode that directly in the join ON
                    // clause as two directional disjuncts:
                    //   * the target PK = sourceField  WHEN  targetField = sourceId   (source on B side)
                    //   * the target PK = targetField  WHEN  sourceField = sourceId   (source on A side)
                    // so each junction row contributes exactly its NON-source endpoint — and a
                    // self-pair row (a,a) KEEPS the self endpoint (both disjuncts bind target.pk = a
                    // when the source = a), matching the runtime M2mJoinResolver + every other port
                    // (Alice is her own friend). No `neq sourceId` exclusion (that would drop (a,a)),
                    // and the directional ON clause already constrains to junction rows touching the
                    // source, so no extra WHERE is needed.
                    append("    ${nav.targetTableObj}.join(${nav.junctionTableObj}, JoinType.INNER) {\n")
                    append("        ((${nav.junctionTableObj}.${nav.sourceField} eq ${nav.targetTableObj}.${nav.targetPkField}) and (${nav.junctionTableObj}.${nav.targetField} eq sourceId)) or\n")
                    append("            ((${nav.junctionTableObj}.${nav.targetField} eq ${nav.targetTableObj}.${nav.targetPkField}) and (${nav.junctionTableObj}.${nav.sourceField} eq sourceId))\n")
                    append("    }.selectAll()\n")
                } else {
                    // Hetero / directed self-join: join the target by its PK to the junction's
                    // target-side FK, filter the junction on the derived source-side FK.
                    append("    ${nav.targetTableObj}.join(${nav.junctionTableObj}, JoinType.INNER) { ${nav.targetTableObj}.${nav.targetPkField} eq ${nav.junctionTableObj}.${nav.targetField} }\n")
                    append("        .selectAll()\n")
                    append("        .where { ${nav.junctionTableObj}.${nav.sourceField} eq sourceId }\n")
                }
            }

            // ADR-0038 reverse navigation — one finder PAIR per FK this entity holds
            // (each single-field identity.reference). The referenced entity T navigates to
            // its referencing E rows by calling these with a T id. The fn name derives from
            // the FK FIELD (PascalCased, trailing `Id` dropped), unique within E by
            // construction — so same-pair FKs (GameSession → Scene ×3) yield DISTINCT finders
            // (findByCurrentScene / findByLastOpeningNarrativeScene /
            // findByTransitioningFromScene), never colliding, with no @reverseName vocabulary.
            // NOT a lazy Exposed `referrersOn` reverse collection (N+1 + needs an open
            // transaction): each is a plain single indexed query (WHERE fk = ?), with a
            // batched variant (WHERE fk IN (…)) for anti-N+1 loading of many parents. The
            // returned Query stays compositional (chain .orderBy/.limit before materialising).
            for (fk in reverseFks) {
                if (!first) append("\n")
                first = false
                val col = KotlinNaming.safeColumnProperty(fk.fkField)
                val single = KotlinNaming.reverseFinderName(fk.fkField)
                val batched = KotlinNaming.reverseFinderInName(fk.fkField)
                append("/** Reverse nav: the $ownerShort rows whose `${fk.fkField}` FK points at the given ${fk.targetShortName} id (single indexed query). */\n")
                append("fun $ownerTable.$single(${fk.fkField}: ${fk.valueType}): Query =\n")
                append("    $ownerTable.selectAll().where { $ownerTable.$col eq ${fk.fkField} }\n")
                append("\n")
                append("/** Reverse nav (batched, anti-N+1): the $ownerShort rows whose `${fk.fkField}` FK is IN the given ${fk.targetShortName} ids. */\n")
                append("fun $ownerTable.$batched(${fk.fkField}s: List<${fk.valueType}>): Query =\n")
                append("    $ownerTable.selectAll().where { $ownerTable.$col inList ${fk.fkField}s }\n")
            }
        }

        val outFile = outRoot.resolve(pkg.replace('.', '/')).resolve(ownerShort + "Relations.kt")
        outFile.parent?.let { Files.createDirectories(it) }
        Files.writeString(outFile, source)
    }

    /**
     * One reverse FK an entity holds (ADR-0038), derived from an `identity.reference`:
     * the FK field name, the target entity short name, and the Kotlin value type of the
     * FK (the type a `findBy<FkField>` arg / element takes — the FK column's own Kotlin type).
     */
    protected data class ReverseFk(val fkField: String, val targetShortName: String, val valueType: String)

    /**
     * Collect every reverse FK [entity] declares, in declaration order — one per
     * single-field [ReferenceIdentity] child. Compound references (multi-field FKs) are
     * skipped (no single-column finder shape). The value type is the FK field's own Kotlin
     * simple type via [KotlinTypeMapper.kotlinTypeName], falling back to `Long`.
     */
    protected open fun reverseFksFor(entity: MetaObject): List<ReverseFk> {
        val out = mutableListOf<ReverseFk>()
        for (child in entity.children) {
            if (child !is ReferenceIdentity) continue
            val fields = child.fields
            if (fields.size != 1) continue // single-column FKs only
            val fkField = fields.first()
            val targetShort = child.targetEntity?.let { PackageMapping.splitFqn(it).second } ?: ""
            val valueType = entity.metaFields.firstOrNull { it.name == fkField }?.let { f ->
                runCatching { KotlinTypeMapper.kotlinTypeName(f).toString().substringAfterLast('.') }
                    .getOrDefault("Long")
            } ?: "Long"
            out.add(ReverseFk(fkField, targetShort, valueType))
        }
        return out
    }

    /**
     * Resolve the Kotlin type of [entity]'s primary key. Falls back to [LONG] when
     * the primary identity is missing, multi-field, or its field can't be resolved
     * — Long matches the dominant convention (entities almost always have a single
     * `field.long` PK; KotlinExposedTableGenerator's FK columns hard-code
     * `long("…").references(...)`). Same lossy-tolerant policy as the table
     * generator: defensive defaults rather than throwing on partially-formed
     * metadata.
     */
    protected open fun primaryKeyKotlinType(entity: MetaObject): TypeName {
        val primary = entity.children
            .filterIsInstance<MetaIdentity>()
            .firstOrNull { it.isPrimary } ?: return LONG
        val pkFieldName = primary.fields.firstOrNull() ?: return LONG
        val pkField = entity.metaFields.firstOrNull { it.name == pkFieldName } ?: return LONG
        return runCatching { KotlinTypeMapper.kotlinTypeName(pkField) }.getOrDefault(LONG)
    }

    // === MultiFileDirectGeneratorBase abstract-method stubs ====================
    override fun writeSingleFile(md: MetaObject, writer: GeneratorIOWriter<*>?) { /* unused */ }
    override fun <T : GeneratorIOWriter<*>?> getSingleWriter(
        loader: MetaDataLoader?, md: MetaObject?, pw: PrintWriter?
    ): T? = null
    override fun <T : GeneratorIOWriter<*>?> getFinalWriter(
        loader: MetaDataLoader?, out: OutputStream?
    ): T? = null
    override fun writeFinalFile(metadata: MutableCollection<MetaObject>?, writer: GeneratorIOWriter<*>?) { /* none */ }
    override fun getSingleOutputFilePath(md: MetaObject): String =
        PackageMapping.splitFqn(md.name).first.replace('.', '/')
    override fun getSingleOutputFilename(md: MetaObject): String =
        PackageMapping.splitFqn(md.name).second + "Relations.kt"
}

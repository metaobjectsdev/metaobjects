package com.metaobjects.generator.kotlin

// Eject note (ADR-0034, JVM eject design): these siblings stay in
// com.metaobjects.generator.kotlin when this generator is copied out via
// `mvn metaobjects:eject` and its own package is renamed — an explicit import, not
// same-package bare-name resolution, is what keeps the ejected copy compiling.
import com.metaobjects.generator.kotlin.ExposedApi
import com.metaobjects.generator.util.GeneratorUtil
import com.metaobjects.generator.kotlin.ExposedImports
import com.metaobjects.generator.kotlin.KotlinGenUtil
import com.metaobjects.generator.kotlin.KotlinTphPlan
import com.metaobjects.generator.kotlin.PackageMapping
import com.metaobjects.generator.kotlin.writer.KotlinWriter

import com.metaobjects.generator.GeneratorException
import com.metaobjects.generator.GeneratorIOWriter
import com.metaobjects.generator.direct.MultiFileDirectGeneratorBase
import com.metaobjects.loader.MetaDataLoader
import com.metaobjects.`object`.MetaObject
import java.io.OutputStream
import java.io.PrintWriter
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import com.metaobjects.generator.util.GeneratedFileWriter

/**
 * Generator: emits two files per project:
 *  - MetadataStartupValidator.kt — registry of (FQN, Table) pairs + a validate(loader) entry point
 *  - ExposedTableValidator.kt — substrate-specific helper that compares one MetaObject to one Table
 *
 * <p>Output is laid out by [KotlinWriter] (ADR-0063), not KotlinPoet.
 *
 * <p>Args:
 * <ul>
 *   <li>{@code outputDir} (required)</li>
 *   <li>{@code packageName} (required) — the Kotlin package both files live in</li>
 * </ul>
 */
open class KotlinValidatorGenerator : MultiFileDirectGeneratorBase<MetaObject>() {

    /** See [KotlinExposedTableGenerator.exposedApi] — same arg, same default (issue #390). */
    protected fun exposedApi(): ExposedApi = ExposedApi.parse(getArg(ExposedApi.ARG_EXPOSED_API))

    override fun getFilterClass(): Class<MetaObject> = MetaObject::class.java

    override fun execute(loader: MetaDataLoader) {
        parseArgs()
        val api = exposedApi()
        val pkg = getArg("packageName")
            ?: throw GeneratorException("KotlinValidatorGenerator (\"validator\"): packageName is required")
        val outRoot = Paths.get(outDir.absolutePath)

        // One registry of every table, so it is built from the whole model: <filters> narrow it,
        // the run's entity selection does not (a narrowed run would drop the other tables).
        val entries = GeneratorUtil.ownMetaObjects(loader)
            .filter { passesFilters(it) }
            .filter { it.subType == MetaObject.SUBTYPE_ENTITY }
            // Abstract entities are inheritance scaffolding — never register a validator for them.
            .filter { !KotlinGenUtil.isAbstractEntity(it) }
            // FR-017 TPH: a subtype folds into its base's single table — never register a per-
            // subtype table (it no longer exists). Mirror the table/controller skip.
            .filter { !KotlinTphPlan.isTphSubtype(it) }
            // ADR-0039: resolving source lookup (inherited source.rdb via extends).
            .filter { KotlinGenUtil.hasRdbSource(it) }
            .map { entity ->
                val (tablePkg, shortName) = PackageMapping.splitFqn(entity.name)
                // (metadata FQN, Table object name, Table's Kotlin package)
                Triple(entity.name, "${shortName}Table", tablePkg)
            }

        emitValidator(pkg, entries, outRoot, api)
        emitHelper(pkg, outRoot, api)
    }

    protected open fun emitValidator(
        pkg: String,
        entries: List<Triple<String, String, String>>,
        outRoot: Path,
        exposedApi: ExposedApi = ExposedApi.V0,
    ) {
        val w = KotlinWriter().packageName(pkg)
        w.use("com.metaobjects.loader.MetaDataLoader")
        w.use("com.metaobjects.metadata.ktx.metaObjectOrNull")
        w.use(ExposedImports.core(exposedApi, "Table"))
        // The Table objects live in their entity's own package; the writer imports any that are
        // NOT in this validator's package, or the bare reference would not resolve.
        val registry = entries.map { (fqn, table, tablePkg) ->
            val ref = if (tablePkg.isEmpty()) table else w.use("$tablePkg.$table")
            listOf(KotlinWriter.str(fqn), " to ", ref)
        }
        w.doc(
            "GENERATED — runtime drift gate. Call [validate] from a Spring `@PostConstruct` or",
            "`ApplicationReadyEvent` listener to fail-fast when generated Tables drift from metadata.",
        )
        w.block("object MetadataStartupValidator {") {
            w.line("private val tablesToValidate: List<Pair<String, Table>> = ", KotlinWriter.call("listOf", *registry.toTypedArray()))
            w.blank()
            w.block("fun validate(loader: MetaDataLoader) {") {
                w.line("val errors = mutableListOf<String>()")
                w.block("for ((fqn, table) in tablesToValidate) {") {
                    w.line("val obj = loader.metaObjectOrNull(fqn)")
                    w.block("if (obj == null) {") {
                        w.line("errors.add(\"metadata missing \$fqn (generated table: \${table.tableName})\")")
                        w.line("continue")
                    }
                    w.line("ExposedTableValidator.check(obj, table, errors)")
                }
                w.block("check(errors.isEmpty()) {") {
                    w.line("\"MetadataStartupValidator: \${errors.size} drift(s):\\n  - \" +")
                    w.indented { w.line("errors.joinToString(\"\\n  - \")") }
                }
            }
        }

        val outFile = outRoot.resolve(pkg.replace('.', '/')).resolve("MetadataStartupValidator.kt")
        GeneratedFileWriter.write(outFile, w.toString())
    }

    protected open fun emitHelper(pkg: String, outRoot: Path, exposedApi: ExposedApi = ExposedApi.V0) {
        val w = KotlinWriter().packageName(pkg)
        w.use("com.metaobjects.`object`.MetaObject")
        w.use("com.metaobjects.field.MetaField")
        w.use(ExposedImports.core(exposedApi, "Table"))
        w.doc(
            "GENERATED — compares a [MetaObject]'s field set vs an Exposed [Table]'s column set",
            "and records any discrepancies into the supplied `errors` list.",
        )
        w.block("object ExposedTableValidator {") {
            w.block("fun check(obj: MetaObject, table: Table, errors: MutableList<String>) {") {
                w.line("val expectedCols = obj.metaFields.map { it.name }.toSet()")
                w.line("val actualCols = table.columns.map { it.name }.toSet()")
                w.line("val missing = expectedCols - actualCols")
                w.line("val extra = actualCols - expectedCols")
                w.block("if (missing.isNotEmpty()) {") {
                    w.line("errors.add(\"\${obj.name}: metadata declares fields not in generated table: \$missing\")")
                }
                w.block("if (extra.isNotEmpty()) {") {
                    w.line("errors.add(\"\${obj.name}: generated table has columns not in metadata: \$extra\")")
                }
            }
        }

        val outFile = outRoot.resolve(pkg.replace('.', '/')).resolve("ExposedTableValidator.kt")
        GeneratedFileWriter.write(outFile, w.toString())
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
    override fun getSingleOutputFilePath(md: MetaObject): String = ""
    override fun getSingleOutputFilename(md: MetaObject): String = ""
}

package com.metaobjects.generator.kotlin

// Eject note (ADR-0034, JVM eject design): these siblings stay in
// com.metaobjects.generator.kotlin when this generator is copied out via
// `mvn metaobjects:eject` and its own package is renamed — an explicit import, not
// same-package bare-name resolution, is what keeps the ejected copy compiling.
import com.metaobjects.generator.kotlin.KotlinGenUtil
import com.metaobjects.generator.kotlin.KotlinNaming
import com.metaobjects.generator.kotlin.PackageMapping

import com.metaobjects.field.DecimalField
import com.metaobjects.field.EnumField
import com.metaobjects.field.InetField
import com.metaobjects.field.MapField
import com.metaobjects.field.MetaField
import com.metaobjects.field.StringField
import com.metaobjects.field.UriField
import com.metaobjects.config.WireFormat
import com.metaobjects.generator.EmitsReportExport
import com.metaobjects.generator.GeneratorException
import com.metaobjects.generator.GeneratorIOWriter
import com.metaobjects.generator.direct.MultiFileDirectGeneratorBase
import com.metaobjects.generator.util.GeneratedFileWriter
import com.metaobjects.generator.util.GeneratorUtil
import com.metaobjects.generator.util.RestSurfaceGate
import com.metaobjects.loader.MetaDataLoader
import com.metaobjects.`object`.MetaObject
import java.io.OutputStream
import java.io.PrintWriter
import java.nio.file.Path
import java.nio.file.Paths

/**
 * Generator `report-export`: the export modules behind a served report's
 * `?format=csv|json|xml` (the "Report export" section of `docs/features/api-contract.md`).
 * Standalone: a catalog generator, never implied by a library, and a project that does not wire
 * it gets no export module and no `format` branch in any route.
 *
 * Emits, for a project:
 *  - ONE shared `ReportExportWriter` (in `writerPackage`): CSV quoting, CRLF, the
 *    `EXPORT_CSV_BOM` constant, the formula-injection guard (string-valued cells only), XML
 *    escaping and the root/row writing over the JDK's StAX writer (no third-party XML
 *    dependency), and the request-side rules (which formats are wired, the three 400 envelopes,
 *    the headers). The Kotlin controllers import nothing from MetaObjects, so those rules are
 *    generated here rather than shipped in a runtime package.
 *  - per served report `<R>`, one `<R>Export` beside its controller: the column list in
 *    derived-field order, the wire-form conversion of each cell, the cap (`MAX_ROWS`) and
 *    `csv(rows)` / `xml(rows)` calling the shared writer.
 *
 * Being in the run is what turns the `format` branch on: the `routes` generator sees this
 * generator through [EmitsReportExport] and its handler reads `<R>Export.MAX_ROWS`, so the cap
 * is set once, here. A decimal cell is written as the project's `wire.decimals` setting spells
 * it, the same as the list route and the JSON export.
 *
 * Args:
 *  - `outputDir` (required): output directory root.
 *  - `maxRows` (default 100000): the most rows one export answers; one more is
 *    `400 export_too_large`, nothing is truncated.
 *  - `xmlNulls` (`empty` | `nil`; default `empty`): a null field is an empty element
 *    (`<f/>`, what Jackson's XML mapper writes for a null and so the JVM standard), or an empty
 *    element with `xsi:nil="true"` and `xmlns:xsi` declared on the root.
 *  - `csvBom` (default false): write a UTF-8 byte order mark first, emitted as the constant
 *    `EXPORT_CSV_BOM`.
 *  - `writerPackage` (default: the package prefix the served reports share, else `export`):
 *    where the shared writer is written.
 *
 * Registered as the cross-port stable name `report-export`
 * (`fixtures/generator-registry-conformance/registry.json`).
 */
open class KotlinReportExportGenerator : MultiFileDirectGeneratorBase<MetaObject>(), EmitsReportExport {

    override fun getFilterClass(): Class<MetaObject> = MetaObject::class.java

    override fun execute(loader: MetaDataLoader) {
        parseArgs()
        val maxRows = (getArg(ARG_MAX_ROWS)?.toInt()) ?: DEFAULT_MAX_ROWS
        if (maxRows < 1) throw GeneratorException("$ARG_MAX_ROWS must be at least 1, got $maxRows")
        val xmlNulls = getArg(ARG_XML_NULLS) ?: XML_NULLS_EMPTY
        if (xmlNulls != XML_NULLS_EMPTY && xmlNulls != XML_NULLS_NIL) {
            throw GeneratorException("$ARG_XML_NULLS must be \"$XML_NULLS_EMPTY\" or \"$XML_NULLS_NIL\", got \"$xmlNulls\"")
        }
        val csvBom = getArg(ARG_CSV_BOM)?.toBoolean() ?: false
        val outRoot = Paths.get(outDir.absolutePath)

        val served = mutableListOf<MetaObject>()
        for (declared in loader.metaObjects) {
            // A served report is emitted from its read model; any other report has no shape.
            val entity = RestSurfaceGate.restShapeOf(declared) ?: continue
            if (!GeneratorUtil.isReport(entity)) continue
            if (KotlinGenUtil.isAbstractEntity(entity)) continue
            if (!RestSurfaceGate.emitsRestSurface(entity)) continue
            served.add(entity)
        }
        if (served.isEmpty()) return

        val writerPackage = getArg(ARG_WRITER_PACKAGE) ?: sharedPackage(served)
        val decimalsAsString = WireFormat.of(loader.root).decimalsAsString()
        write(outRoot, writerPackage, WRITER_NAME, writerSource(writerPackage, xmlNulls, csvBom, decimalsAsString))
        for (entity in served) {
            val (pkg, shortName) = PackageMapping.splitFqn(entity.name)
            write(outRoot, pkg, "${shortName}Export", exportSource(entity, pkg, shortName, writerPackage, maxRows))
        }
    }

    /** The package prefix every served report shares, or `export` when they share none. */
    private fun sharedPackage(served: List<MetaObject>): String {
        var prefix: List<String>? = null
        for (entity in served) {
            val pkg = PackageMapping.splitFqn(entity.name).first
            val parts = if (pkg.isEmpty()) emptyList() else pkg.split('.')
            prefix = if (prefix == null) parts else prefix.zip(parts).takeWhile { (a, b) -> a == b }.map { it.first }
        }
        return if (prefix.isNullOrEmpty()) "export" else prefix.joinToString(".")
    }

    private fun write(outRoot: Path, pkg: String, className: String, source: String) {
        GeneratedFileWriter.write(outRoot.resolve(pkg.replace('.', '/')).resolve("$className.kt"), source)
    }

    // -----------------------------------------------------------------------
    // <R>Export
    // -----------------------------------------------------------------------

    private fun exportSource(
        entity: MetaObject, pkg: String, shortName: String, writerPackage: String, maxRows: Int,
    ): String {
        val className = "${shortName}Export"
        val fields = entity.metaFields
        val segment = KotlinNaming.controllerPath(shortName).substringAfterLast('/')
        val w = WRITER_NAME
        return buildString {
            if (pkg.isNotEmpty()) append("package $pkg\n\n")
            if (writerPackage != pkg) append("import $writerPackage.$w\n\n")
            append("/**\n")
            append(" * GENERATED — the export of the $shortName report: its columns in derived-field order,\n")
            append(" * each cell's wire form, and the CSV and XML bodies. The route reads [MAX_ROWS] and\n")
            append(" * the request-side answers below; the shared [$w] writes the bytes.\n")
            append(" */\n")
            append("object $className {\n\n")
            append("    /** The most rows one export answers; one more is 400 export_too_large. */\n")
            append("    const val MAX_ROWS: Int = $maxRows\n\n")
            append("    /** The XML root element: the report's name. */\n")
            append("    const val ROOT: String = \"$shortName\"\n\n")
            append("    /** The route's last path segment, the stem of the download's file name. */\n")
            append("    const val SEGMENT: String = \"$segment\"\n\n")
            append("    /** The derived fields, in order: the CSV header row and the XML element names. */\n")
            append("    val FIELDS: List<String> = listOf(${fields.joinToString(", ") { "\"${it.name}\"" }})\n\n")
            append("    /** One row's cells in wire form: currency as integer minor units, a date as YYYY-MM-DD,\n")
            append("     *  a decimal as the wire setting writes it, a boolean as true/false, null as null. */\n")
            append("    fun cells(row: $shortName): List<$w.Cell> = listOf(\n")
            for (f in fields) append("        $w.${cellFactory(f)}(row.${f.name}),\n")
            append("    )\n\n")
            append("    /** The rows as RFC 4180 CSV bytes (UTF-8). */\n")
            append("    fun csv(rows: List<$shortName>): ByteArray = $w.csv(FIELDS, rows.map { cells(it) })\n\n")
            append("    /** The rows as XML bytes (UTF-8, no declaration). */\n")
            append("    fun xml(rows: List<$shortName>): ByteArray = $w.xml(ROOT, FIELDS, rows.map { cells(it) })\n\n")
            append("    /** Whether [format] names a wired format. Case-sensitive; null and empty are not. */\n")
            append("    fun isFormat(format: String?): Boolean = $w.isFormat(format)\n\n")
            append("    /** `withCount` as an export request spells a truthy flag: 1 or true. */\n")
            append("    fun isTruthy(flag: String?): Boolean = $w.isTruthy(flag)\n\n")
            append("    /** The 400 body for a format this route does not wire. */\n")
            append("    fun invalidFormat(): Map<String, Any> = $w.invalidFormat()\n\n")
            append("    /** The 400 body for withCount on a CSV or XML export. */\n")
            append("    fun withCountRefused(): Map<String, Any> = $w.withCountRefused()\n\n")
            append("    /** The 400 body for an export of more than [MAX_ROWS] rows. */\n")
            append("    fun tooLarge(): Map<String, Any> = $w.tooLarge(MAX_ROWS)\n\n")
            append("    /** The Content-Disposition of a successful export in [format]. */\n")
            append("    fun contentDisposition(format: String): String = $w.contentDisposition(SEGMENT, format)\n\n")
            append("    /** The Content-Type of a successful export in [format]. */\n")
            append("    fun contentType(format: String): String = $w.contentType(format)\n")
            append("}\n")
        }
    }

    /** Which `ReportExportWriter` factory turns this field's value into a cell. */
    private fun cellFactory(f: MetaField<*>): String {
        if (f.isArrayType || f is MapField) return "json"
        return when {
            f is StringField || f is EnumField || f is UriField || f is InetField -> "text"
            f is DecimalField -> "decimal"
            else -> "raw"
        }
    }

    // -----------------------------------------------------------------------
    // The shared writer
    // -----------------------------------------------------------------------

    private fun writerSource(pkg: String, xmlNulls: String, csvBom: Boolean, decimalsAsString: Boolean): String =
        WRITER_TEMPLATE
            .replace("@PACKAGE@", if (pkg.isEmpty()) "" else "package $pkg\n\n")
            .replace("@BOM@", csvBom.toString())
            .replace("@NIL@", (xmlNulls == XML_NULLS_NIL).toString())
            .replace("@DECIMALS_AS_STRING@", decimalsAsString.toString())

    private companion object {
        const val ARG_MAX_ROWS = "maxRows"
        const val ARG_XML_NULLS = "xmlNulls"
        const val ARG_CSV_BOM = "csvBom"
        const val ARG_WRITER_PACKAGE = "writerPackage"

        /** The most rows one export answers when no [ARG_MAX_ROWS] is given. */
        const val DEFAULT_MAX_ROWS = 100_000

        const val XML_NULLS_EMPTY = "empty"
        const val XML_NULLS_NIL = "nil"

        /** The simple name of the shared writer. */
        const val WRITER_NAME = "ReportExportWriter"

        /**
         * The shared writer, verbatim but for the four substitutions in [writerSource]. A raw
         * string with no Kotlin templates: the emitted code concatenates with `+`.
         */
        const val WRITER_TEMPLATE: String = """@PACKAGE@import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.databind.SerializationFeature
import java.io.ByteArrayOutputStream
import java.math.BigDecimal
import java.time.LocalDateTime
import java.time.LocalTime
import java.time.format.DateTimeFormatter
import javax.xml.stream.XMLOutputFactory

/**
 * GENERATED — the one writer every report export shares: CSV quoting, CRLF, the byte order
 * mark constant, the formula-injection guard, XML over the JDK's StAX writer, and the
 * request-side answers (which formats are wired, the 400 envelopes, the headers).
 *
 * The guard applies to string-valued cells only (a string, an enum symbol, a uri): a value
 * starting with =, +, -, @, TAB or CR gets a leading ', then the cell is quoted if it holds a
 * quote, comma, CR or LF. A number, a decimal, a date or a boolean is never guarded, so a
 * negative number stays a number.
 */
object ReportExportWriter {

    /** Write a UTF-8 byte order mark before the CSV (Excel on Windows wants one). */
    const val EXPORT_CSV_BOM: Boolean = @BOM@

    /** Write a null field as an empty element with xsi:nil="true" (true) or as an empty element (false). */
    const val EXPORT_XML_NIL: Boolean = @NIL@

    /** The project's wire.decimals: the canonical string (true, "string") or as Jackson writes a
     *  BigDecimal number (false, "native"), so a decimal cell matches the list route. */
    const val DECIMALS_AS_STRING: Boolean = @DECIMALS_AS_STRING@

    private const val XSI_NS = "http://www.w3.org/2001/XMLSchema-instance"

    const val CSV = "csv"
    const val JSON = "json"
    const val XML = "xml"

    /** The wired formats, in the order the invalid_format envelope lists them. */
    val FORMATS: List<String> = listOf(CSV, JSON, XML)

    private val JSON_MAPPER: ObjectMapper = ObjectMapper()
        .findAndRegisterModules()
        .disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS)

    // -----------------------------------------------------------------------
    // The request side
    // -----------------------------------------------------------------------

    /** Whether [format] names a wired format. Case-sensitive; null and empty are not. */
    fun isFormat(format: String?): Boolean = format != null && format in FORMATS

    /** withCount as an export request spells a truthy flag: 1 or true. */
    fun isTruthy(flag: String?): Boolean = flag == "1" || flag.equals("true", ignoreCase = true)

    /** The 400 body for a format this route does not wire. */
    fun invalidFormat(): Map<String, Any> = linkedMapOf("error" to "invalid_format", "expected" to FORMATS)

    /** The 400 body for withCount on a CSV or XML export: only JSON carries the { rows, total } envelope. */
    fun withCountRefused(): Map<String, Any> = linkedMapOf(
        "error" to "export_with_count",
        "message" to "withCount is not supported with format=csv or format=xml: only JSON carries the { rows, total } envelope.",
    )

    /** The 400 body for an export of more than [maxRows] rows. */
    fun tooLarge(maxRows: Int): Map<String, Any> = linkedMapOf("error" to "export_too_large", "maxRows" to maxRows)

    /** attachment; filename="<segment>.<format>". */
    fun contentDisposition(segment: String, format: String): String =
        "attachment; filename=\"" + segment + "." + format + "\""

    /** The Content-Type of a successful export. */
    fun contentType(format: String): String = when (format) {
        CSV -> "text/csv; charset=utf-8"
        XML -> "application/xml"
        JSON -> "application/json"
        else -> throw IllegalArgumentException("not an export format: " + format)
    }

    // -----------------------------------------------------------------------
    // Cells
    // -----------------------------------------------------------------------

    /** One cell in wire form: its text, or null for a null; [guarded] marks a string-valued cell. */
    class Cell(val text: String?, val guarded: Boolean)

    private val NULL = Cell(null, false)

    /** A string-valued cell (string, enum symbol, uri): subject to the formula-injection guard. */
    fun text(value: Any?): Cell = if (value == null) NULL else Cell(value.toString(), true)

    /** A cell that is never guarded (number, date, time, timestamp, uuid, boolean, currency).
     *  A time and a zone-less timestamp keep their seconds, as Jackson's JSR-310 serializers write them. */
    fun raw(value: Any?): Cell = when (value) {
        null -> NULL
        is LocalTime -> Cell(value.format(DateTimeFormatter.ISO_LOCAL_TIME), false)
        is LocalDateTime -> Cell(value.format(DateTimeFormatter.ISO_LOCAL_DATE_TIME), false)
        else -> Cell(value.toString(), false)
    }

    /** A decimal as the wire setting writes it: under "string" canonical plain notation (no
     *  exponent, no trailing fraction zeros, zero as 0), under "native" as Jackson writes it. */
    fun decimal(value: BigDecimal?): Cell {
        if (value == null) return NULL
        if (!DECIMALS_AS_STRING) return Cell(value.toString(), false)
        return Cell(if (value.signum() == 0) "0" else value.stripTrailingZeros().toPlainString(), false)
    }

    /** An array or a map, as compact JSON text. */
    fun json(value: Any?): Cell = if (value == null) NULL else Cell(JSON_MAPPER.writeValueAsString(value), false)

    // -----------------------------------------------------------------------
    // CSV
    // -----------------------------------------------------------------------

    /** RFC 4180 CSV: a header row, then one record per row, CRLF after every record. */
    fun csv(names: List<String>, rows: List<List<Cell>>): ByteArray {
        val out = StringBuilder()
        if (EXPORT_CSV_BOM) out.append('﻿')
        out.append(names.joinToString(",") { quote(it) }).append("\r\n")
        for (row in rows) out.append(row.joinToString(",") { csvCell(it) }).append("\r\n")
        return out.toString().toByteArray(Charsets.UTF_8)
    }

    /** One cell: null is empty, a guarded string is prefixed with an apostrophe when it starts
     *  like a formula, then the text is quoted when it needs to be. */
    internal fun csvCell(cell: Cell): String {
        var value = cell.text ?: return ""
        if (cell.guarded && value.isNotEmpty()) {
            val first = value[0]
            if (first == '=' || first == '+' || first == '-' || first == '@' || first == '\t' || first == '\r') {
                value = "'" + value
            }
        }
        return quote(value)
    }

    private fun quote(value: String): String =
        if (value.any { it == '"' || it == ',' || it == '\r' || it == '\n' }) {
            "\"" + value.replace("\"", "\"\"") + "\""
        } else {
            value
        }

    // -----------------------------------------------------------------------
    // XML
    // -----------------------------------------------------------------------

    /** <root><row><field>value</field>...</row>...</root>: UTF-8, no declaration, no indentation. */
    fun xml(root: String, names: List<String>, rows: List<List<Cell>>): ByteArray {
        val bytes = ByteArrayOutputStream()
        val w = XMLOutputFactory.newFactory().createXMLStreamWriter(bytes, "UTF-8")
        w.writeStartElement(root)
        if (EXPORT_XML_NIL) w.writeNamespace("xsi", XSI_NS)
        for (row in rows) {
            w.writeStartElement("row")
            for (i in names.indices) {
                val value = row[i].text
                if (value == null) {
                    w.writeEmptyElement(names[i])
                    if (EXPORT_XML_NIL) w.writeAttribute("xsi", XSI_NS, "nil", "true")
                } else {
                    w.writeStartElement(names[i])
                    w.writeCharacters(xmlText(value))
                    w.writeEndElement()
                }
            }
            w.writeEndElement()
        }
        w.writeEndElement()
        w.close()
        return bytes.toByteArray()
    }

    /** A character XML 1.0 cannot hold becomes U+FFFD; the writer escapes & < >. */
    private fun xmlText(value: String): String {
        if (value.all { xmlOk(it) }) return value
        return value.map { if (xmlOk(it)) it else '�' }.joinToString("")
    }

    private fun xmlOk(c: Char): Boolean =
        c == '\t' || c == '\n' || c == '\r' || (c in ' '..'퟿') || (c in ''..'�') || c.isSurrogate()
}
"""
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
        PackageMapping.splitFqn(md.name).second + "Export.kt"
}

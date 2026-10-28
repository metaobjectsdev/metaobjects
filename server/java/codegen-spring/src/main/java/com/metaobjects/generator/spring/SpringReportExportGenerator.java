package com.metaobjects.generator.spring;

// Eject note (ADR-0034, JVM eject design): these siblings stay in
// com.metaobjects.generator.spring when this generator is copied out via
// `mvn metaobjects:eject` and its own package is renamed — an explicit import, not
// same-package bare-name resolution, is what keeps the ejected copy compiling.
import com.metaobjects.generator.spring.SpringGeneratorSupport;
import com.metaobjects.generator.spring.SpringNaming;

import com.metaobjects.field.DecimalField;
import com.metaobjects.field.EnumField;
import com.metaobjects.field.InetField;
import com.metaobjects.field.MapField;
import com.metaobjects.field.MetaField;
import com.metaobjects.field.StringField;
import com.metaobjects.field.UriField;
import com.metaobjects.generator.GeneratorException;
import com.metaobjects.generator.GeneratorIOWriter;
import com.metaobjects.generator.direct.MultiFileDirectGeneratorBase;
import com.metaobjects.generator.util.GeneratedFileWriter;
import com.metaobjects.generator.util.GeneratorUtil;
import com.metaobjects.generator.util.JavaIdentifiers;
import com.metaobjects.generator.util.RestSurfaceGate;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.MetaObject;

import java.io.IOException;
import java.io.OutputStream;
import java.io.PrintWriter;
import java.util.Collection;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;

/**
 * Generator {@code report-export}: the export modules behind a served report's
 * {@code ?format=csv|json|xml} (the "Report export" section of
 * {@code docs/features/api-contract.md}). Standalone: it is a catalog generator, never implied
 * by a library, and a project that does not wire it gets no export module and no {@code format}
 * branch in any route.
 *
 * <p>Emits, for a project:</p>
 * <ul>
 *   <li>ONE shared {@code ReportExportWriter} (in {@code writerPackage}): CSV quoting, CRLF, the
 *       {@code EXPORT_CSV_BOM} constant, the formula-injection guard (string-valued cells only),
 *       XML escaping and the root/row writing over JDK StAX. No third-party XML dependency.</li>
 *   <li>per served report {@code <R>}, one {@code <R>Export} beside its controller: the column
 *       list in derived-field order, the wire-form conversion of each cell, the cap
 *       ({@code MAX_ROWS}) and {@code csv(rows)} / {@code xml(rows)} calling the shared writer.</li>
 * </ul>
 *
 * <p>To turn the {@code format} branch on, give the {@code routes} generator the arg
 * {@code reportExport=true}; its handler reads {@code <R>Export.MAX_ROWS}, so the cap is set
 * once, here.</p>
 *
 * <p>Args:</p>
 * <ul>
 *   <li>{@code outputDir} (required): output directory root.</li>
 *   <li>{@code maxRows} (default 100000): the most rows one export answers; one more is
 *       {@code 400 export_too_large}, nothing is truncated.</li>
 *   <li>{@code xmlNulls} ({@code empty} | {@code nil}; default {@code empty}): a null field is an
 *       empty element ({@code <f/>}, what Jackson's XML mapper writes for a null and so this
 *       port's standard), or an empty element with {@code xsi:nil="true"} and
 *       {@code xmlns:xsi} declared on the root.</li>
 *   <li>{@code csvBom} (default false): write a UTF-8 byte order mark first, emitted as the
 *       constant {@code EXPORT_CSV_BOM}.</li>
 *   <li>{@code writerPackage} (default: the package prefix the served reports share, else
 *       {@code export}): where the shared writer is written.</li>
 * </ul>
 *
 * <p>Registered as the cross-port stable name {@code report-export}
 * ({@code fixtures/generator-registry-conformance/registry.json}).</p>
 */
public class SpringReportExportGenerator extends MultiFileDirectGeneratorBase<MetaObject> {

    /** This generator's cross-port stable name. */
    public static final String STABLE_NAME = "report-export";

    public static final String ARG_MAX_ROWS = "maxRows";
    public static final String ARG_XML_NULLS = "xmlNulls";
    public static final String ARG_CSV_BOM = "csvBom";
    public static final String ARG_WRITER_PACKAGE = "writerPackage";

    /** The most rows one export answers when no {@link #ARG_MAX_ROWS} is given. */
    public static final int DEFAULT_MAX_ROWS = 100_000;

    public static final String XML_NULLS_EMPTY = "empty";
    public static final String XML_NULLS_NIL = "nil";

    /** The simple name of the shared writer. */
    public static final String WRITER_NAME = "ReportExportWriter";

    @Override
    protected Class<MetaObject> getFilterClass() {
        return MetaObject.class;
    }

    @Override
    protected String getSingleOutputFilename(MetaObject md) {
        return SpringNaming.splitFqn(md.getName())[1] + "Export.java";
    }

    // === MultiFileDirectGeneratorBase abstract-method stubs ====================
    @Override
    protected void writeSingleFile(MetaObject md, GeneratorIOWriter<?> writer) { /* unused */ }

    @Override
    @SuppressWarnings({ "unchecked", "rawtypes" })
    protected <T extends GeneratorIOWriter> T getSingleWriter(
            MetaDataLoader loader, MetaObject md, PrintWriter pw) {
        return null;
    }

    @Override
    @SuppressWarnings({ "unchecked", "rawtypes" })
    protected <T extends GeneratorIOWriter> T getFinalWriter(
            MetaDataLoader loader, OutputStream out) {
        return null;
    }

    @Override
    protected void writeFinalFile(Collection<MetaObject> metadata, GeneratorIOWriter<?> writer) { /* none */ }

    @Override
    protected String getSingleOutputFilePath(MetaObject md) {
        return SpringNaming.splitFqn(md.getName())[0].replace('.', '/');
    }

    @Override
    public void execute(MetaDataLoader loader) {
        parseArgs();
        int maxRows = Integer.parseInt(getArg(ARG_MAX_ROWS, String.valueOf(DEFAULT_MAX_ROWS)));
        if (maxRows < 1) {
            throw new GeneratorException(ARG_MAX_ROWS + " must be at least 1, got " + maxRows);
        }
        String xmlNulls = getArg(ARG_XML_NULLS, XML_NULLS_EMPTY);
        if (!XML_NULLS_EMPTY.equals(xmlNulls) && !XML_NULLS_NIL.equals(xmlNulls)) {
            throw new GeneratorException(ARG_XML_NULLS + " must be \"" + XML_NULLS_EMPTY + "\" or \""
                + XML_NULLS_NIL + "\", got \"" + xmlNulls + "\"");
        }
        boolean csvBom = Boolean.parseBoolean(getArg(ARG_CSV_BOM, "false"));
        Path outRoot = Paths.get(outDir.getAbsolutePath());

        List<MetaObject> served = new ArrayList<>();
        for (MetaObject declared : loader.getMetaObjects()) {
            // A served report is emitted from its read model; any other report has no shape.
            MetaObject entity = RestSurfaceGate.restShapeOf(declared);
            if (entity == null || !GeneratorUtil.isReport(entity)) continue;
            if (GeneratorUtil.isAbstract(entity)) continue;
            if (!RestSurfaceGate.emitsRestSurface(entity)) continue;
            served.add(entity);
        }
        if (served.isEmpty()) return;

        String writerPackage = getArg(ARG_WRITER_PACKAGE, sharedPackage(served));
        write(outRoot, writerPackage, WRITER_NAME, writerSource(writerPackage, xmlNulls, csvBom));
        for (MetaObject entity : served) {
            String[] split = SpringNaming.splitFqn(entity.getName());
            write(outRoot, split[0], split[1] + "Export",
                exportSource(entity, split[0], split[1], writerPackage, maxRows));
        }
    }

    /** The package prefix every served report shares, or {@code export} when they share none. */
    static String sharedPackage(List<MetaObject> served) {
        String[] prefix = null;
        for (MetaObject entity : served) {
            String pkg = SpringNaming.splitFqn(entity.getName())[0];
            String[] parts = pkg.isEmpty() ? new String[0] : pkg.split("\\.");
            if (prefix == null) {
                prefix = parts;
                continue;
            }
            int n = 0;
            while (n < prefix.length && n < parts.length && prefix[n].equals(parts[n])) n++;
            prefix = java.util.Arrays.copyOf(prefix, n);
        }
        return prefix == null || prefix.length == 0 ? "export" : String.join(".", prefix);
    }

    private static void write(Path outRoot, String pkg, String className, String source) {
        try {
            Path outFile = outRoot.resolve(pkg.replace('.', '/')).resolve(className + ".java");
            GeneratedFileWriter.write(outFile, source);
        } catch (IOException e) {
            throw new GeneratorException("failed writing " + className + ".java: " + e, e);
        }
    }

    // -----------------------------------------------------------------------
    // <R>Export
    // -----------------------------------------------------------------------

    private static String exportSource(MetaObject entity, String pkg, String shortName,
                                       String writerPackage, int maxRows) {
        String dto = SpringNaming.dtoName(shortName);
        String className = shortName + "Export";
        List<MetaField> fields = SpringGeneratorSupport.dtoComponentFields(entity);
        StringBuilder src = new StringBuilder();
        if (!pkg.isEmpty()) src.append("package ").append(pkg).append(";\n\n");
        if (!writerPackage.equals(pkg)) {
            src.append("import ").append(writerPackage).append('.').append(WRITER_NAME).append(";\n");
        }
        src.append("import java.util.List;\n\n");
        src.append("/**\n");
        src.append(" * GENERATED — the export of the ").append(shortName).append(" report: its columns in\n");
        src.append(" * derived-field order, each cell's wire form, and the CSV and XML bodies. The\n");
        src.append(" * route reads {@link #MAX_ROWS}; the shared {@link ").append(WRITER_NAME)
           .append("} writes the bytes.\n");
        src.append(" */\n");
        src.append("public final class ").append(className).append(" {\n\n");
        src.append("    private ").append(className).append("() {}\n\n");
        src.append("    /** The most rows one export answers; one more is 400 export_too_large. */\n");
        src.append("    public static final int MAX_ROWS = ").append(maxRows).append(";\n\n");
        src.append("    /** The XML root element and the report's name. */\n");
        src.append("    public static final String ROOT = \"").append(shortName).append("\";\n\n");
        src.append("    /** The derived fields, in order: the CSV header row and the XML element names. */\n");
        src.append("    public static final List<String> FIELDS = List.of(");
        for (int i = 0; i < fields.size(); i++) {
            if (i > 0) src.append(", ");
            src.append('"').append(fields.get(i).getName()).append('"');
        }
        src.append(");\n\n");
        src.append("    /** One row's cells in wire form: currency as integer minor units, a date as YYYY-MM-DD,\n");
        src.append("     *  a decimal in canonical plain notation, a boolean as true/false, null as null. */\n");
        src.append("    public static List<").append(WRITER_NAME).append(".Cell> cells(").append(dto).append(" row) {\n");
        src.append("        return List.of(");
        for (int i = 0; i < fields.size(); i++) {
            MetaField f = fields.get(i);
            src.append(i == 0 ? "\n" : ",\n").append("                ").append(WRITER_NAME).append('.')
               .append(cellFactory(f)).append("(row.").append(JavaIdentifiers.escapeMember(f.getName())).append("())");
        }
        src.append(");\n");
        src.append("    }\n\n");
        src.append("    /** The rows as RFC 4180 CSV bytes (UTF-8). */\n");
        src.append("    public static byte[] csv(List<").append(dto).append("> rows) {\n");
        src.append("        return ").append(WRITER_NAME).append(".csv(FIELDS, rows.stream().map(")
           .append(className).append("::cells).toList());\n");
        src.append("    }\n\n");
        src.append("    /** The rows as XML bytes (UTF-8, no declaration). */\n");
        src.append("    public static byte[] xml(List<").append(dto).append("> rows) {\n");
        src.append("        return ").append(WRITER_NAME).append(".xml(ROOT, FIELDS, rows.stream().map(")
           .append(className).append("::cells).toList());\n");
        src.append("    }\n");
        src.append("}\n");
        return src.toString();
    }

    /** Which {@code ReportExportWriter} factory turns this field's value into a cell. */
    private static String cellFactory(MetaField f) {
        if (f.isArrayType() || f instanceof MapField) return "json";
        String sub = f.getSubType();
        if (StringField.SUBTYPE_STRING.equals(sub) || EnumField.SUBTYPE_ENUM.equals(sub)
                || UriField.SUBTYPE_URI.equals(sub) || InetField.SUBTYPE_INET.equals(sub)) {
            return "text";
        }
        if (DecimalField.SUBTYPE_DECIMAL.equals(sub)) return "decimal";
        return "raw";
    }

    // -----------------------------------------------------------------------
    // The shared writer
    // -----------------------------------------------------------------------

    private static String writerSource(String pkg, String xmlNulls, boolean csvBom) {
        String text = WRITER_TEMPLATE
            .replace("@PACKAGE@", pkg.isEmpty() ? "" : "package " + pkg + ";\n\n")
            .replace("@BOM@", String.valueOf(csvBom))
            .replace("@NIL@", String.valueOf(XML_NULLS_NIL.equals(xmlNulls)));
        return text;
    }

    /** The shared writer, verbatim but for the three substitutions in {@link #writerSource}. */
    private static final String WRITER_TEMPLATE = """
@PACKAGE@import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import java.io.ByteArrayOutputStream;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.util.List;
import javax.xml.stream.XMLOutputFactory;
import javax.xml.stream.XMLStreamException;
import javax.xml.stream.XMLStreamWriter;

/**
 * GENERATED — the one writer every report export shares: CSV quoting, CRLF, the byte order
 * mark constant, the formula-injection guard, and XML over the JDK's StAX writer.
 *
 * <p>The guard applies to string-valued cells only (a string, an enum symbol, a uri): a value
 * starting with {@code =}, {@code +}, {@code -}, {@code @}, TAB or CR gets a leading
 * {@code '}, then the cell is quoted if it holds a quote, comma, CR or LF. A number, a
 * decimal, a date or a boolean is never guarded, so a negative number stays a number.
 */
public final class ReportExportWriter {

    private ReportExportWriter() {}

    /** Write a UTF-8 byte order mark before the CSV (Excel on Windows wants one). */
    public static final boolean EXPORT_CSV_BOM = @BOM@;

    /** Write a null field as an empty element with xsi:nil="true" (true) or as an empty element (false). */
    public static final boolean EXPORT_XML_NIL = @NIL@;

    private static final String XSI_NS = "http://www.w3.org/2001/XMLSchema-instance";

    private static final ObjectMapper JSON = new ObjectMapper()
        .findAndRegisterModules()
        .disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS);

    /** One cell in wire form: its text, or null for a null; {@code guarded} marks a string-valued cell. */
    public static final class Cell {
        private final String text;
        private final boolean guarded;

        private Cell(String text, boolean guarded) {
            this.text = text;
            this.guarded = guarded;
        }

        public String text() {
            return text;
        }

        public boolean guarded() {
            return guarded;
        }
    }

    private static final Cell NULL = new Cell(null, false);

    /** A string-valued cell (string, enum symbol, uri): subject to the formula-injection guard. */
    public static Cell text(Object value) {
        return value == null ? NULL : new Cell(String.valueOf(value), true);
    }

    /** A cell that is never guarded (number, date, time, timestamp, uuid, boolean, currency). */
    public static Cell raw(Object value) {
        return value == null ? NULL : new Cell(String.valueOf(value), false);
    }

    /** A decimal in canonical plain notation: no exponent, no trailing fraction zeros, zero as 0. */
    public static Cell decimal(BigDecimal value) {
        if (value == null) return NULL;
        return new Cell(value.signum() == 0 ? "0" : value.stripTrailingZeros().toPlainString(), false);
    }

    /** An array or a map, as compact JSON text. */
    public static Cell json(Object value) {
        if (value == null) return NULL;
        try {
            return new Cell(JSON.writeValueAsString(value), false);
        } catch (com.fasterxml.jackson.core.JsonProcessingException e) {
            throw new IllegalStateException("cannot write a report cell as JSON: " + e.getMessage(), e);
        }
    }

    // -----------------------------------------------------------------------
    // CSV
    // -----------------------------------------------------------------------

    /** RFC 4180 CSV: a header row, then one record per row, CRLF after every record. */
    public static byte[] csv(List<String> names, List<List<Cell>> rows) {
        StringBuilder out = new StringBuilder();
        if (EXPORT_CSV_BOM) out.append('\\uFEFF');
        for (int i = 0; i < names.size(); i++) {
            if (i > 0) out.append(',');
            out.append(quote(names.get(i)));
        }
        out.append("\\r\\n");
        for (List<Cell> row : rows) {
            for (int i = 0; i < row.size(); i++) {
                if (i > 0) out.append(',');
                out.append(csvCell(row.get(i)));
            }
            out.append("\\r\\n");
        }
        return out.toString().getBytes(StandardCharsets.UTF_8);
    }

    /** One cell: null is empty, a guarded string is prefixed with an apostrophe when it starts
     *  like a formula, then the text is quoted when it needs to be. */
    static String csvCell(Cell cell) {
        String value = cell.text();
        if (value == null) return "";
        if (cell.guarded() && !value.isEmpty()) {
            char first = value.charAt(0);
            if (first == '=' || first == '+' || first == '-' || first == '@' || first == '\\t' || first == '\\r') {
                value = "'" + value;
            }
        }
        return quote(value);
    }

    private static String quote(String value) {
        boolean needs = false;
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (c == '"' || c == ',' || c == '\\r' || c == '\\n') {
                needs = true;
                break;
            }
        }
        return needs ? "\\"" + value.replace("\\"", "\\"\\"") + "\\"" : value;
    }

    // -----------------------------------------------------------------------
    // XML
    // -----------------------------------------------------------------------

    /** {@code <root><row><field>value</field>...</row>...</root>}: UTF-8, no declaration, no indentation. */
    public static byte[] xml(String root, List<String> names, List<List<Cell>> rows) {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try {
            XMLStreamWriter w = XMLOutputFactory.newFactory().createXMLStreamWriter(bytes, "UTF-8");
            w.writeStartElement(root);
            if (EXPORT_XML_NIL) w.writeNamespace("xsi", XSI_NS);
            for (List<Cell> row : rows) {
                w.writeStartElement("row");
                for (int i = 0; i < names.size(); i++) {
                    String value = row.get(i).text();
                    if (value == null) {
                        w.writeEmptyElement(names.get(i));
                        if (EXPORT_XML_NIL) w.writeAttribute("xsi", XSI_NS, "nil", "true");
                    } else {
                        w.writeStartElement(names.get(i));
                        w.writeCharacters(xmlText(value));
                        w.writeEndElement();
                    }
                }
                w.writeEndElement();
            }
            w.writeEndElement();
            w.close();
        } catch (XMLStreamException e) {
            throw new IllegalStateException("cannot write the report as XML: " + e.getMessage(), e);
        }
        return bytes.toByteArray();
    }

    /** A character XML 1.0 cannot hold becomes U+FFFD; the writer escapes {@code & < >}. */
    private static String xmlText(String value) {
        StringBuilder out = null;
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            boolean ok = c == '\\t' || c == '\\n' || c == '\\r' || (c >= 0x20 && c <= 0xD7FF)
                || (c >= 0xE000 && c <= 0xFFFD) || Character.isSurrogate(c);
            if (!ok && out == null) {
                out = new StringBuilder(value.length()).append(value, 0, i);
            }
            if (out != null) out.append(ok ? c : '\\uFFFD');
        }
        return out == null ? value : out.toString();
    }
}
""";
}

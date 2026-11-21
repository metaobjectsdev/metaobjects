package acme.shop;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import java.io.ByteArrayOutputStream;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.time.LocalDateTime;
import java.time.LocalTime;
import java.time.format.DateTimeFormatter;
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
    public static final boolean EXPORT_CSV_BOM = false;

    /** Write a null field as an empty element with xsi:nil="true" (true) or as an empty element (false). */
    public static final boolean EXPORT_XML_NIL = false;

    /** The project's wire.decimals: the canonical string (true, "string") or as Jackson writes a
     *  BigDecimal number (false, "native"), so a decimal cell matches the list route. */
    public static final boolean DECIMALS_AS_STRING = false;

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

    /** A cell that is never guarded (number, date, time, timestamp, uuid, boolean, currency).
     *  A time and a zone-less timestamp keep their seconds, as Jackson's JSR-310 serializers write them. */
    public static Cell raw(Object value) {
        if (value == null) return NULL;
        if (value instanceof LocalTime) {
            return new Cell(((LocalTime) value).format(DateTimeFormatter.ISO_LOCAL_TIME), false);
        }
        if (value instanceof LocalDateTime) {
            return new Cell(((LocalDateTime) value).format(DateTimeFormatter.ISO_LOCAL_DATE_TIME), false);
        }
        return new Cell(String.valueOf(value), false);
    }

    /** A decimal as the wire setting writes it: under "string" canonical plain notation (no
     *  exponent, no trailing fraction zeros, zero as 0), under "native" as Jackson writes it. */
    public static Cell decimal(BigDecimal value) {
        if (value == null) return NULL;
        if (!DECIMALS_AS_STRING) return new Cell(value.toString(), false);
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
        if (EXPORT_CSV_BOM) out.append('\uFEFF');
        for (int i = 0; i < names.size(); i++) {
            if (i > 0) out.append(',');
            out.append(quote(names.get(i)));
        }
        out.append("\r\n");
        for (List<Cell> row : rows) {
            for (int i = 0; i < row.size(); i++) {
                if (i > 0) out.append(',');
                out.append(csvCell(row.get(i)));
            }
            out.append("\r\n");
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
            if (first == '=' || first == '+' || first == '-' || first == '@' || first == '\t' || first == '\r') {
                value = "'" + value;
            }
        }
        return quote(value);
    }

    private static String quote(String value) {
        boolean needs = false;
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (c == '"' || c == ',' || c == '\r' || c == '\n') {
                needs = true;
                break;
            }
        }
        return needs ? "\"" + value.replace("\"", "\"\"") + "\"" : value;
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
            boolean ok = c == '\t' || c == '\n' || c == '\r' || (c >= 0x20 && c <= 0xD7FF)
                || (c >= 0xE000 && c <= 0xFFFD) || Character.isSurrogate(c);
            if (!ok && out == null) {
                out = new StringBuilder(value.length()).append(value, 0, i);
            }
            if (out != null) out.append(ok ? c : '\uFFFD');
        }
        return out == null ? value : out.toString();
    }
}

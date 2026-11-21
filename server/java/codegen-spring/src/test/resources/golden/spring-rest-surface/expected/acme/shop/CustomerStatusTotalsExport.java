package acme.shop;

import java.util.List;

/**
 * GENERATED — the export of the CustomerStatusTotals report: its columns in
 * derived-field order, each cell's wire form, and the CSV and XML bodies. The
 * route reads {@link #MAX_ROWS}; the shared {@link ReportExportWriter} writes the bytes.
 */
public final class CustomerStatusTotalsExport {

    private CustomerStatusTotalsExport() {}

    /** The most rows one export answers; one more is 400 export_too_large. */
    public static final int MAX_ROWS = 100000;

    /** The XML root element and the report's name. */
    public static final String ROOT = "CustomerStatusTotals";

    /** The derived fields, in order: the CSV header row and the XML element names. */
    public static final List<String> FIELDS = List.of("status", "customers", "activeCustomers");

    /** One row's cells in wire form: currency as integer minor units, a date as YYYY-MM-DD,
     *  a decimal as the wire setting writes it, a boolean as true/false, null as null. */
    public static List<ReportExportWriter.Cell> cells(CustomerStatusTotalsDto row) {
        return List.of(
                ReportExportWriter.text(row.status()),
                ReportExportWriter.raw(row.customers()),
                ReportExportWriter.raw(row.activeCustomers()));
    }

    /** The rows as RFC 4180 CSV bytes (UTF-8). */
    public static byte[] csv(List<CustomerStatusTotalsDto> rows) {
        return ReportExportWriter.csv(FIELDS, rows.stream().map(CustomerStatusTotalsExport::cells).toList());
    }

    /** The rows as XML bytes (UTF-8, no declaration). */
    public static byte[] xml(List<CustomerStatusTotalsDto> rows) {
        return ReportExportWriter.xml(ROOT, FIELDS, rows.stream().map(CustomerStatusTotalsExport::cells).toList());
    }
}

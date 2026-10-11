package com.metaobjects.integration.api;

import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

/**
 * Locates the FR-044 view-backed-report sub-corpus
 * ({@code fixtures/api-contract-conformance/report/}) and loads its seed rows.
 *
 * <p>{@code seed.json} has two halves. Every top-level key but {@code reports} is a base
 * table ({@code invoices}, {@code products}, {@code sales}), used by the full-stack lanes.
 * This lane is a SEAM lane: its in-memory repository stands in for the view, so it is
 * seeded from {@code reports} alone, which is what the served views return for those rows.
 * No SQL for a report is produced or run here (ADR-0015: view SQL is TypeScript's). A
 * TypeScript test holds the two halves together.</p>
 */
final class ReportCorpus {
    private ReportCorpus() {}

    private static final ObjectMapper MAPPER = new ObjectMapper();

    /** The served reports, in declaration order. {@code ProductRevenue} declares
     *  {@code @spine} and a measure with {@code @default}; {@code InvoiceCalendar} lists one
     *  time dimension at two grains; {@code SalesByCategory} reaches a dimension through two
     *  references. */
    static final List<String> SERVED =
        List.of("InvoiceStatusTotals", "InvoicesByMonth", "InvoiceTotals", "InvoiceCalendar", "InvoiceDisputes",
            "ProductRevenue", "SalesByCategory", "SalesBySku");

    /** The report that declares no view and must generate nothing. */
    static final String SOURCELESS = "InvoiceDays";

    static Path root() {
        return ApiContractScenarioLoader.findCorpusRoot().resolve("report");
    }

    static Path scenariosDir() {
        return root().resolve("scenarios");
    }

    /**
     * The seed's {@code reports} half, parsed ONCE: a per-report reader would re-read and
     * re-parse the whole file once per served report. Sibling corpus classes in this package
     * parse once into a static; this keeps the whole {@code reports} map as the index.
     */
    private static final Map<String, List<Map<String, Object>>> REPORT_ROWS = readReportRows();

    @SuppressWarnings("unchecked")
    private static Map<String, List<Map<String, Object>>> readReportRows() {
        try {
            String text = Files.readString(root().resolve("seed.json"), StandardCharsets.UTF_8);
            Map<String, Object> parsed = MAPPER.readValue(text, Map.class);
            if (!(parsed.get("reports") instanceof Map<?, ?> reports))
                throw new IllegalStateException("report/seed.json: missing 'reports' object");
            Map<String, List<Map<String, Object>>> out = new java.util.LinkedHashMap<>();
            reports.forEach((name, rows) -> {
                if (!(rows instanceof List<?> list))
                    throw new IllegalStateException("report/seed.json: 'reports." + name + "' is not an array");
                out.put(String.valueOf(name), (List<Map<String, Object>>) list);
            });
            return out;
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    /** The rows {@code report}'s view returns: {@code reports.<report>} from {@code report/seed.json}. */
    static List<Map<String, Object>> seedRows(String report) {
        List<Map<String, Object>> rows = REPORT_ROWS.get(report);
        if (rows == null)
            throw new IllegalStateException("report/seed.json: missing 'reports." + report + "' array");
        return rows;
    }
}

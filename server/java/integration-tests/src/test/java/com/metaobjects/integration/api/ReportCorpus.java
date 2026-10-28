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
 * ({@code fixtures/api-contract-conformance/report/}), its committed schema and its base-table seed.
 *
 * <p>{@code seed.json} has two halves. Every top-level key but {@code reports} is a base table
 * ({@code invoices}, {@code products}, {@code sales}); the OMDB lane inserts them into a real
 * database that has executed {@code schema.<engine>.sql}, and the views derive the report rows.
 * No SQL for a report is produced here (ADR-0015: view SQL is TypeScript's).</p>
 */
final class ReportCorpus {
    private ReportCorpus() {}

    private static final ObjectMapper MAPPER = new ObjectMapper();

    /** The served reports, in declaration order. {@code ProductRevenue} declares
     *  {@code @spine} and a measure with {@code @default}; {@code InvoiceCalendar} lists one
     *  time dimension at two grains; {@code SalesByCategory} reaches a dimension through two
     *  references; {@code ProductRefunds} adds boolean {@code @agg any} measures. */
    static final List<String> SERVED =
        List.of("InvoiceStatusTotals", "InvoicesByMonth", "InvoiceTotals", "InvoiceCalendar", "InvoiceDisputes",
            "ProductRevenue", "SalesByCategory", "SalesBySku", "ProductRefunds", "TicketsByTags", "ReadingLog", "ExportCells");

    /** The report that declares no view and must generate nothing. */
    static final String SOURCELESS = "InvoiceDays";

    static Path root() {
        return ApiContractScenarioLoader.findCorpusRoot().resolve("report");
    }

    static Path scenariosDir() {
        return root().resolve("scenarios");
    }

    /**
     * The seed's base tables: every top-level key of {@code seed.json} but {@code reports}, in
     * file order. The file lists them parents first, so inserting them in this order keeps every
     * foreign key valid. {@code reports} is what the views return for those rows; this lane lets
     * the real views derive them, so it never reads that half.
     */
    @SuppressWarnings("unchecked")
    static Map<String, List<Map<String, Object>>> baseTables() {
        try {
            String text = Files.readString(root().resolve("seed.json"), StandardCharsets.UTF_8);
            Map<String, Object> parsed = MAPPER.readValue(text, new com.fasterxml.jackson.core.type.TypeReference<java.util.LinkedHashMap<String, Object>>() {});
            Map<String, List<Map<String, Object>>> out = new java.util.LinkedHashMap<>();
            parsed.forEach((table, rows) -> {
                if ("reports".equals(table)) return;
                if (!(rows instanceof List<?> list))
                    throw new IllegalStateException("report/seed.json: '" + table + "' is not an array");
                out.put(table, (List<Map<String, Object>>) list);
            });
            if (out.isEmpty()) throw new IllegalStateException("report/seed.json: no base tables");
            return out;
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    /** The committed TypeScript-produced schema of {@code engine}, read verbatim. */
    static String schema(String engineId) {
        try {
            return Files.readString(root().resolve("schema." + engineId + ".sql"), StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }
}

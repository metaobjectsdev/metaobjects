package com.metaobjects.generator.spring.runtime;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The request-side rules of a served report's {@code ?format=csv|json|xml} export (the "Report
 * export" section of {@code docs/features/api-contract.md}): which formats are wired, the three
 * 400 envelopes, the headers a successful export carries. Plain Java with no framework types,
 * so the Kotlin controller and an owned (ejected) copy use it unchanged.
 *
 * <p>The writers (CSV quoting, the formula-injection guard, XML) are NOT here: the
 * {@code report-export} generator writes them into the project, so the bytes of an export are
 * code the adopter owns. This class only decides whether a request is an export and what a
 * refusal looks like. Accept headers are never consulted: the selector is the query parameter.
 *
 * <p>A route consults this only when a {@code report-export} generator is wired for the
 * project (the routes generator sees it in the run); otherwise the generated
 * controller never mentions it and {@code ?format=} is ignored like any unknown parameter.
 */
public final class ReportExport {

    /** The wired formats, in the order the {@code invalid_format} envelope lists them. */
    public static final List<String> FORMATS = List.of("csv", "json", "xml");

    public static final String CSV = "csv";
    public static final String JSON = "json";
    public static final String XML = "xml";

    private ReportExport() { /* no instances */ }

    /** Whether {@code format} names a wired format. Case-sensitive; null and empty are not. */
    public static boolean isFormat(String format) {
        return format != null && FORMATS.contains(format);
    }

    /** {@code withCount} as an export request spells a truthy flag: {@code 1} or {@code true}. */
    public static boolean isTruthy(String flag) {
        return "1".equals(flag) || "true".equalsIgnoreCase(flag);
    }

    /** The {@code 400} body for a format this route does not wire. */
    public static Map<String, Object> invalidFormat() {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("error", "invalid_format");
        body.put("expected", FORMATS);
        return body;
    }

    /** The {@code 400} body for {@code withCount} on a CSV or XML export: only JSON carries the
     *  {@code { rows, total }} envelope. */
    public static Map<String, Object> withCount() {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("error", "export_with_count");
        body.put("message", "withCount is not supported with format=csv or format=xml: only JSON carries the { rows, total } envelope.");
        return body;
    }

    /** The {@code 400} body for an export of more than {@code maxRows} rows. */
    public static Map<String, Object> tooLarge(int maxRows) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("error", "export_too_large");
        body.put("maxRows", maxRows);
        return body;
    }

    /** {@code attachment; filename="<segment>.<format>"}. */
    public static String contentDisposition(String segment, String format) {
        return "attachment; filename=\"" + segment + "." + format + "\"";
    }

    /** The {@code Content-Type} of a successful export. */
    public static String contentType(String format) {
        switch (format) {
            case CSV: return "text/csv; charset=utf-8";
            case XML: return "application/xml";
            case JSON: return "application/json";
            default: throw new IllegalArgumentException("not an export format: " + format);
        }
    }
}

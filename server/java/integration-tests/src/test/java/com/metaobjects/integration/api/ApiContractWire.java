package com.metaobjects.integration.api;

import java.util.regex.Pattern;

/**
 * How a scenario path reaches the REFERENCE lane's server. A corpus path may carry a RAW
 * {@code %} that does not start a valid {@code %XX} escape ({@code filter-like-raw-percent.yaml})
 * — what a browser and Node's fetch send for a typed wildcard. The generated lanes put it on the
 * wire as written ({@link TomcatHost}); this lane cannot.
 */
public final class ApiContractWire {

    private static final Pattern STRAY_PERCENT = Pattern.compile("%(?![0-9A-Fa-f]{2})");

    private ApiContractWire() {}

    /**
     * Rewrite each stray {@code %} to {@code %25}. The reference servers run on the JDK's
     * HttpServer, which answers a raw {@code %} in the request line with
     * {@code 400 Bad request URI} before any handler runs — and {@link java.net.URI}, which the
     * JDK HTTP client needs, refuses to hold one at all. So this lane pins only what the value
     * MEANS (a literal {@code %}), not how it travels.
     */
    public static String escapeStrayPercent(String path) {
        return STRAY_PERCENT.matcher(path).replaceAll("%25");
    }
}

package com.metaobjects.integration.api;

import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.regex.Pattern;

import org.springframework.http.HttpMethod;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;

/**
 * How a scenario path reaches a JVM server. A corpus path may carry a RAW {@code %} that does
 * not start a valid {@code %XX} escape ({@code filter-like-raw-percent.yaml}) — what a browser
 * and Node's fetch send for a typed wildcard. {@link java.net.URI} refuses to hold that at all
 * ({@code URI.create} throws "Malformed escape pair"), so neither the JDK HTTP client nor
 * MockMvc can be handed the path as-is.
 */
public final class ApiContractWire {

    private static final Pattern STRAY_PERCENT = Pattern.compile("%(?![0-9A-Fa-f]{2})");

    private ApiContractWire() {}

    /**
     * REFERENCE lane: rewrite each stray {@code %} to {@code %25}. The reference servers run on
     * the JDK's HttpServer, which answers a raw {@code %} in the request line with
     * {@code 400 Bad request URI} before any handler runs — so this lane can only pin what the
     * value MEANS (a literal {@code %}), not how it travels. The generated lane pins the
     * transport ({@link #mockMvcRequest}).
     */
    public static String escapeStrayPercent(String path) {
        return STRAY_PERCENT.matcher(path).replaceAll("%25");
    }

    /**
     * GENERATED lane: a MockMvc request shaped the way Tomcat hands it to a controller. A
     * well-formed path goes through unchanged. A path whose query holds a malformed escape keeps
     * that query RAW in {@code getQueryString()}, and the parameter map carries only the pairs
     * that decode — Tomcat drops a malformed pair from the map ("Character decoding failed ...
     * has been ignored"). A controller that reads the map loses that filter silently; one that
     * parses the raw query must keep the escape literal.
     */
    public static MockHttpServletRequestBuilder mockMvcRequest(HttpMethod method, String path) {
        int q = path.indexOf('?');
        // No malformed escape (or one outside the query, which URI.create reports loudly).
        if (q < 0 || !STRAY_PERCENT.matcher(path.substring(q)).find()) return request(method, URI.create(path));
        String rawQuery = path.substring(q + 1);
        MockHttpServletRequestBuilder builder = request(method, URI.create(path.substring(0, q)));
        builder.with(r -> { r.setQueryString(rawQuery); return r; });
        for (String pair : rawQuery.split("&")) {
            int eq = pair.indexOf('=');
            String rawKey = eq < 0 ? pair : pair.substring(0, eq);
            String rawValue = eq < 0 ? "" : pair.substring(eq + 1);
            try {
                builder.param(URLDecoder.decode(rawKey, StandardCharsets.UTF_8),
                              URLDecoder.decode(rawValue, StandardCharsets.UTF_8));
            } catch (IllegalArgumentException malformed) {
                // Tomcat ignores this parameter; so does the map here.
            }
        }
        return builder;
    }
}

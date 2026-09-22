package com.metaobjects.integration.kotlin.api

import org.springframework.http.HttpMethod
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request
import java.net.URI
import java.net.URLDecoder
import java.nio.charset.StandardCharsets

/**
 * How a scenario path reaches a JVM server. A corpus path may carry a RAW `%` that does not
 * start a valid `%XX` escape (`filter-like-raw-percent.yaml`) — what a browser and Node's fetch
 * send for a typed wildcard. [java.net.URI] refuses to hold that at all (`URI.create` throws
 * "Malformed escape pair"), so neither the JDK HTTP client nor MockMvc can be handed it as-is.
 */
object ApiContractWire {

    private val STRAY_PERCENT = Regex("%(?![0-9A-Fa-f]{2})")

    /**
     * REFERENCE lane: rewrite each stray `%` to `%25`. The reference servers run on the JDK's
     * HttpServer, which answers a raw `%` in the request line with `400 Bad request URI` before
     * any handler runs — so this lane can only pin what the value MEANS (a literal `%`), not how
     * it travels. The generated lane pins the transport ([mockMvcRequest]).
     */
    fun escapeStrayPercent(path: String): String = STRAY_PERCENT.replace(path, "%25")

    /**
     * GENERATED lane: a MockMvc request shaped the way Tomcat hands it to a controller. A
     * well-formed path goes through unchanged. A path whose query holds a malformed escape keeps
     * that query RAW in `getQueryString()`, and the parameter map carries only the pairs that
     * decode — Tomcat drops a malformed pair from the map ("Character decoding failed ... has
     * been ignored"). A controller that reads the map loses that filter silently; one that
     * parses the raw query must keep the escape literal.
     */
    fun mockMvcRequest(method: HttpMethod, path: String): MockHttpServletRequestBuilder {
        val q = path.indexOf('?')
        // No malformed escape (or one outside the query, which URI.create reports loudly).
        if (q < 0 || !STRAY_PERCENT.containsMatchIn(path.substring(q))) return request(method, URI.create(path))
        val rawQuery = path.substring(q + 1)
        val builder = request(method, URI.create(path.substring(0, q)))
        builder.with { it.queryString = rawQuery; it }
        for (pair in rawQuery.split('&')) {
            val eq = pair.indexOf('=')
            val rawKey = if (eq < 0) pair else pair.substring(0, eq)
            val rawValue = if (eq < 0) "" else pair.substring(eq + 1)
            try {
                builder.param(URLDecoder.decode(rawKey, StandardCharsets.UTF_8),
                              URLDecoder.decode(rawValue, StandardCharsets.UTF_8))
            } catch (malformed: IllegalArgumentException) {
                // Tomcat ignores this parameter; so does the map here.
            }
        }
        return builder
    }
}

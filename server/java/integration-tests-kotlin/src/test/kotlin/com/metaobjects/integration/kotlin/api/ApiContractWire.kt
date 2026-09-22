package com.metaobjects.integration.kotlin.api

/**
 * How a scenario path reaches the REFERENCE lane's server. A corpus path may carry a RAW `%`
 * that does not start a valid `%XX` escape (`filter-like-raw-percent.yaml`) — what a browser
 * and Node's fetch send for a typed wildcard. The generated lanes put it on the wire as
 * written ([TomcatHost]); this lane cannot.
 */
object ApiContractWire {

    private val STRAY_PERCENT = Regex("%(?![0-9A-Fa-f]{2})")

    /**
     * Rewrite each stray `%` to `%25`. The reference servers run on the JDK's HttpServer, which
     * answers a raw `%` in the request line with `400 Bad request URI` before any handler runs —
     * and [java.net.URI], which the JDK HTTP client needs, refuses to hold one at all. So this
     * lane pins only what the value MEANS (a literal `%`), not how it travels.
     */
    fun escapeStrayPercent(path: String): String = STRAY_PERCENT.replace(path, "%25")
}

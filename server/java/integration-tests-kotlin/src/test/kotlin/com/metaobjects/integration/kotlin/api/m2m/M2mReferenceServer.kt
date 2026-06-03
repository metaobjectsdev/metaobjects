package com.metaobjects.integration.kotlin.api.m2m

import com.fasterxml.jackson.databind.ObjectMapper
import com.metaobjects.integration.kotlin.PostgresContainer
import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import java.net.InetSocketAddress
import java.sql.Connection
import java.sql.DriverManager

/**
 * FR-018 — hand-rolled reference server for the M:N api-contract corpus
 * (`fixtures/api-contract-conformance/m2m/`). Kotlin mirror of the Java
 * `M2mReferenceServer`.
 *
 * Creates the six physical tables via raw JDBC against Testcontainers Postgres,
 * seeds them from the shared `seed.json`, and exposes the three M:N traversal
 * sub-resources over a JDK `HttpServer`:
 *  - `GET /api/posts/{id}/tags`        — hetero (Post—Tag via PostTag);
 *  - `GET /api/persons/{id}/following` — directed self-join (source FK followerId);
 *  - `GET /api/persons/{id}/friends`   — symmetric self-join (union on read).
 *
 * The traversal SQL is hand-written here (the cross-port contract is what both this
 * and the generated lane must satisfy).
 */
class M2mReferenceServer(
    private val pg: PostgresContainer,
    seed: Map<String, List<Map<String, Any?>>>,
) : AutoCloseable {

    private val mapper = ObjectMapper()
    private val httpServer: HttpServer
    val baseUrl: String

    init {
        createSchema()
        applySeed(seed)
        httpServer = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        httpServer.createContext("/api/", ::handle)
        httpServer.executor = null
        httpServer.start()
        baseUrl = "http://127.0.0.1:${httpServer.address.port}"
    }

    override fun close() { httpServer.stop(0) }

    private fun connect(): Connection = DriverManager.getConnection(pg.jdbcUrl, pg.username, pg.password)

    private fun createSchema() {
        connect().use { c ->
            c.createStatement().use { st ->
                st.execute("CREATE TABLE \"posts\"  (id BIGINT PRIMARY KEY, title VARCHAR(200) NOT NULL)")
                st.execute("CREATE TABLE \"tags\"   (id BIGINT PRIMARY KEY, name VARCHAR(80) NOT NULL)")
                st.execute("CREATE TABLE \"post_tags\" (\"postId\" BIGINT NOT NULL, \"tagId\" BIGINT NOT NULL, " +
                    "PRIMARY KEY (\"postId\", \"tagId\"))")
                st.execute("CREATE TABLE \"people\" (id BIGINT PRIMARY KEY, name VARCHAR(80) NOT NULL)")
                st.execute("CREATE TABLE \"follows\" (\"followerId\" BIGINT NOT NULL, \"followeeId\" BIGINT NOT NULL, " +
                    "PRIMARY KEY (\"followerId\", \"followeeId\"))")
                st.execute("CREATE TABLE \"friendships\" (\"personAId\" BIGINT NOT NULL, \"personBId\" BIGINT NOT NULL, " +
                    "PRIMARY KEY (\"personAId\", \"personBId\"))")
            }
        }
    }

    private fun applySeed(seed: Map<String, List<Map<String, Any?>>>) {
        connect().use { c ->
            insertRows(c, "INSERT INTO \"posts\" (id, title) VALUES (?, ?)",
                M2mSeed.rows(seed, "posts"), "id", "title")
            insertRows(c, "INSERT INTO \"tags\" (id, name) VALUES (?, ?)",
                M2mSeed.rows(seed, "tags"), "id", "name")
            insertRows(c, "INSERT INTO \"post_tags\" (\"postId\", \"tagId\") VALUES (?, ?)",
                M2mSeed.rows(seed, "post_tags"), "postId", "tagId")
            insertRows(c, "INSERT INTO \"people\" (id, name) VALUES (?, ?)",
                M2mSeed.rows(seed, "people"), "id", "name")
            insertRows(c, "INSERT INTO \"follows\" (\"followerId\", \"followeeId\") VALUES (?, ?)",
                M2mSeed.rows(seed, "follows"), "followerId", "followeeId")
            insertRows(c, "INSERT INTO \"friendships\" (\"personAId\", \"personBId\") VALUES (?, ?)",
                M2mSeed.rows(seed, "friendships"), "personAId", "personBId")
        }
    }

    private fun insertRows(c: Connection, sql: String, rows: List<Map<String, Any?>>, col1: String, col2: String) {
        c.prepareStatement(sql).use { ps ->
            for (r in rows) {
                bind(ps, 1, r[col1])
                bind(ps, 2, r[col2])
                ps.executeUpdate()
            }
        }
    }

    private fun bind(ps: java.sql.PreparedStatement, idx: Int, v: Any?) {
        if (v is Number) ps.setLong(idx, v.toLong()) else ps.setObject(idx, v)
    }

    // -----------------------------------------------------------------------
    // HTTP handler
    // -----------------------------------------------------------------------

    private fun handle(exchange: HttpExchange) {
        try {
            doHandle(exchange)
        } catch (e: Exception) {
            runCatching { sendJson(exchange, 500, mapOf("error" to "internal", "message" to e.message)) }
        } finally {
            exchange.close()
        }
    }

    private fun doHandle(exchange: HttpExchange) {
        val method = exchange.requestMethod.uppercase()
        val seg = exchange.requestURI.rawPath.split("/")  // ["", "api", "<plural>", "<id>", "<relation>"]
        if (method != "GET" || seg.size != 5 || seg[1] != "api") {
            sendJson(exchange, 404, mapOf("error" to "not_found")); return
        }
        val plural = seg[2]
        val id = seg[3].toLong()
        val relation = seg[4]

        val rows = when {
            plural == "posts" && relation == "tags" ->
                traverse(id, "post_tags", "postId", "tagId", "tags", false)
            plural == "persons" && relation == "following" ->
                traverse(id, "follows", "followerId", "followeeId", "people", false)
            plural == "persons" && relation == "friends" ->
                traverse(id, "friendships", "personAId", "personBId", "people", true)
            else -> { sendJson(exchange, 404, mapOf("error" to "not_found")); return }
        }
        sendJson(exchange, 200, rows)
    }

    /**
     * Resolve the related target rows by traversing a junction. Hetero/directed:
     * `WHERE sourceFk = :id`, related id = targetFk. Symmetric: `WHERE sourceFk = :id
     * OR targetFk = :id`, related id = the column that is NOT the source id.
     */
    private fun traverse(
        sourceId: Long, junction: String, sourceFk: String, targetFk: String,
        targetTable: String, symmetric: Boolean,
    ): List<Map<String, Any?>> {
        val relatedIds = LinkedHashSet<Long>()
        val where = if (symmetric) "\"$sourceFk\" = ? OR \"$targetFk\" = ?" else "\"$sourceFk\" = ?"
        connect().use { c ->
            c.prepareStatement(
                "SELECT \"$sourceFk\", \"$targetFk\" FROM \"$junction\" WHERE $where").use { ps ->
                ps.setLong(1, sourceId)
                if (symmetric) ps.setLong(2, sourceId)
                ps.executeQuery().use { rs ->
                    while (rs.next()) {
                        val a = rs.getLong(1); val b = rs.getLong(2)
                        relatedIds.add(if (symmetric) (if (a == sourceId) b else a) else b)
                    }
                }
            }
        }
        if (relatedIds.isEmpty()) return emptyList()

        val out = ArrayList<Map<String, Any?>>(relatedIds.size)
        connect().use { c ->
            for (rid in relatedIds) {
                c.prepareStatement("SELECT id, name FROM \"$targetTable\" WHERE id = ?").use { ps ->
                    ps.setLong(1, rid)
                    ps.executeQuery().use { rs ->
                        if (rs.next()) out.add(linkedMapOf("id" to rs.getLong("id"), "name" to rs.getString("name")))
                    }
                }
            }
        }
        return out
    }

    private fun sendJson(exchange: HttpExchange, status: Int, body: Any?) {
        val bytes = mapper.writeValueAsBytes(body)
        exchange.responseHeaders.set("Content-Type", "application/json")
        exchange.sendResponseHeaders(status, bytes.size.toLong())
        exchange.responseBody.use { it.write(bytes) }
    }
}

package com.metaobjects.integration.kotlin.api

import com.fasterxml.jackson.databind.ObjectMapper
import com.metaobjects.integration.kotlin.PostgresContainer
import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import org.jetbrains.exposed.sql.Column
import org.jetbrains.exposed.sql.Database
import org.jetbrains.exposed.sql.ResultRow
import org.jetbrains.exposed.sql.SchemaUtils
import org.jetbrains.exposed.sql.SortOrder
import org.jetbrains.exposed.sql.SqlExpressionBuilder
import org.jetbrains.exposed.sql.Table
import org.jetbrains.exposed.sql.deleteWhere
import org.jetbrains.exposed.sql.insert
import org.jetbrains.exposed.sql.javatime.datetime
import org.jetbrains.exposed.sql.selectAll
import org.jetbrains.exposed.sql.transactions.transaction
import org.jetbrains.exposed.sql.update
import java.net.InetSocketAddress
import java.sql.DriverManager
import java.time.LocalDateTime
import java.time.format.DateTimeFormatter

/**
 * Minimal reference Kotlin/Exposed HTTP server implementing the cross-port
 * REST API contract for the `Author` entity from the api-contract-conformance
 * corpus.
 *
 * Why hand-rolled (vs the `KotlinSpringControllerGenerator` output): the
 * generator's output is a Spring `@RestController` requiring a Spring Boot
 * context — pulling all of Spring Boot in here for a 10-route contract test
 * is disproportionate. The handler logic and wire shape mirror the generator
 * output byte-for-byte; the corpus is the contract both must satisfy.
 *
 * Schema is created via Exposed `SchemaUtils.create`; seed/truncate go through
 * direct JDBC because they include `RESTART IDENTITY` which Exposed doesn't
 * expose cleanly.
 */
class AuthorApiServer(private val pg: PostgresContainer) : AutoCloseable {

    private val db: Database = Database.connect(pg.jdbcUrl, user = pg.username, password = pg.password)
    private val mapper = ObjectMapper()
    private val httpServer: HttpServer = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
    val baseUrl: String

    init {
        transaction(db) { SchemaUtils.create(AuthorTable) }

        httpServer.createContext("/api/authors") { exchange -> handle(exchange) }
        httpServer.executor = null
        httpServer.start()
        baseUrl = "http://127.0.0.1:${httpServer.address.port}"
    }

    override fun close() {
        httpServer.stop(0)
    }

    /** TRUNCATE + RESTART IDENTITY — used by the `list-empty` scenario. */
    fun truncate() {
        DriverManager.getConnection(pg.jdbcUrl, pg.username, pg.password).use { c ->
            c.createStatement().use { it.execute("""TRUNCATE TABLE "authors" RESTART IDENTITY""") }
        }
    }

    /**
     * Apply the seed file's `rows[]`. Inserts each row with an explicit id, then
     * bumps the bigserial sequence so the next implicit-id insert lands at
     * `max(id) + 1` — matters for `create-201` to land at a deterministic id.
     */
    fun applySeed(rows: List<Map<String, Any?>>) {
        truncate()
        transaction(db) {
            for (r in rows) {
                AuthorTable.insert {
                    it[id] = (r["id"] as Number).toLong()
                    it[name] = r["name"] as String
                    it[bio] = r["bio"] as String?
                    it[createdAt] = parseTimestamp(r["createdAt"] as String)
                }
            }
        }
        DriverManager.getConnection(pg.jdbcUrl, pg.username, pg.password).use { c ->
            c.createStatement().use {
                it.execute("SELECT setval(pg_get_serial_sequence('authors', 'id'), COALESCE((SELECT MAX(id) FROM authors), 1))")
            }
        }
    }

    // -----------------------------------------------------------------------
    // HTTP handler
    // -----------------------------------------------------------------------

    private fun handle(exchange: HttpExchange) {
        try {
            doHandle(exchange)
        } catch (e: Exception) {
            sendJson(exchange, 500, mapOf("error" to "internal", "message" to (e.message ?: e.toString())))
        } finally {
            exchange.close()
        }
    }

    private fun doHandle(exchange: HttpExchange) {
        val method = exchange.requestMethod.uppercase()
        val rawPath = exchange.requestURI.rawPath ?: ""
        val rawQuery = exchange.requestURI.rawQuery ?: ""
        val qs = parseQs(rawQuery)
        val idSegment = rawPath.removePrefix("/api/authors").trim('/').ifEmpty { null }

        when {
            method == "GET" && idSegment == null -> listAuthors(exchange, qs)
            method == "GET" && idSegment != null -> getAuthor(exchange, idSegment)
            method == "POST" && idSegment == null -> createAuthor(exchange)
            (method == "PATCH" || method == "PUT") && idSegment != null -> updateAuthor(exchange, idSegment)
            method == "DELETE" && idSegment != null -> deleteAuthor(exchange, idSegment)
            else -> sendJson(exchange, 404, mapOf("error" to "not_found"))
        }
    }

    private fun listAuthors(exchange: HttpExchange, qs: Map<String, String>) {
        val sort = parseSort(qs["sort"])
        if (sort == InvalidSort) {
            sendJson(exchange, 400, mapOf("error" to "invalid_sort"))
            return
        }
        val limit = qs["limit"]?.toIntOrNull()
        val offset = qs["offset"]?.toLongOrNull() ?: 0L
        val withCount = qs["withCount"] == "1" || qs["withCount"] == "true"

        val rows = transaction(db) {
            var q = AuthorTable.selectAll()
            val activeSort = (sort as? ValidSort)
                // Default sort: id ascending — pagination stability across ports.
                ?: ValidSort("id", SortOrder.ASC)
            val col = AuthorTable.columns.first { it.name == activeSort.field }
            q = q.orderBy(col to activeSort.dir)
            if (limit != null) q = q.limit(limit, offset)
            q.map { rowToMap(it) }
        }

        if (withCount) {
            val total = transaction(db) { AuthorTable.selectAll().count() }
            sendJson(exchange, 200, mapOf("rows" to rows, "total" to total))
        } else {
            sendJson(exchange, 200, rows)
        }
    }

    private fun getAuthor(exchange: HttpExchange, idStr: String) {
        val id = idStr.toLongOrNull()
            ?: return sendJson(exchange, 400, mapOf("error" to "invalid_id"))
        val row = transaction(db) {
            AuthorTable.selectAll().where { AuthorTable.id eq id }.singleOrNull()?.let(::rowToMap)
        }
        if (row == null) sendJson(exchange, 404, mapOf("error" to "not_found"))
        else sendJson(exchange, 200, row)
    }

    private fun createAuthor(exchange: HttpExchange) {
        @Suppress("UNCHECKED_CAST")
        val body = readJsonBody(exchange) as? Map<String, Any?>
            ?: return sendJson(exchange, 400, mapOf("error" to "validation"))
        val newId = transaction(db) {
            AuthorTable.insert {
                it[name] = body["name"] as String
                it[bio] = body["bio"] as String?
                it[createdAt] = parseTimestamp(body["createdAt"] as String)
            }[AuthorTable.id]
        }
        val row = transaction(db) {
            AuthorTable.selectAll().where { AuthorTable.id eq newId }.single().let(::rowToMap)
        }
        sendJson(exchange, 201, row)
    }

    private fun updateAuthor(exchange: HttpExchange, idStr: String) {
        val id = idStr.toLongOrNull()
            ?: return sendJson(exchange, 400, mapOf("error" to "invalid_id"))
        @Suppress("UNCHECKED_CAST")
        val body = readJsonBody(exchange) as? Map<String, Any?>
            ?: return sendJson(exchange, 400, mapOf("error" to "validation"))
        val updated = transaction(db) {
            AuthorTable.update({ AuthorTable.id eq id }) {
                (body["name"] as? String)?.let { v -> it[name] = v }
                if (body.containsKey("bio")) it[bio] = body["bio"] as String?
                (body["createdAt"] as? String)?.let { v -> it[createdAt] = parseTimestamp(v) }
            }
        }
        if (updated == 0) {
            sendJson(exchange, 404, mapOf("error" to "not_found"))
            return
        }
        val row = transaction(db) {
            AuthorTable.selectAll().where { AuthorTable.id eq id }.single().let(::rowToMap)
        }
        sendJson(exchange, 200, row)
    }

    private fun deleteAuthor(exchange: HttpExchange, idStr: String) {
        val id = idStr.toLongOrNull()
            ?: return sendJson(exchange, 400, mapOf("error" to "invalid_id"))
        val deleted = transaction(db) {
            // deleteWhere's lambda receives (Table, ISqlExpressionBuilder) — use the
            // builder receiver explicitly to resolve `eq` past the table-side ambiguity.
            AuthorTable.deleteWhere { with(SqlExpressionBuilder) { AuthorTable.id eq id } }
        }
        if (deleted == 0) sendJson(exchange, 404, mapOf("error" to "not_found"))
        else sendNoContent(exchange)
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    private fun rowToMap(row: ResultRow): Map<String, Any?> {
        val ts = row[AuthorTable.createdAt]
        return linkedMapOf(
            "id" to row[AuthorTable.id],
            "name" to row[AuthorTable.name],
            "bio" to row[AuthorTable.bio],
            // Normalize to ISO-8601 without zone (matches the seed/wire format).
            "createdAt" to ts.format(TIMESTAMP_FMT),
        )
    }

    private fun readJsonBody(exchange: HttpExchange): Any? {
        val bytes = exchange.requestBody.readAllBytes()
        if (bytes.isEmpty()) return null
        return mapper.readValue(bytes, Any::class.java)
    }

    private fun sendJson(exchange: HttpExchange, status: Int, body: Any?) {
        val bytes = mapper.writeValueAsBytes(body)
        exchange.responseHeaders.set("Content-Type", "application/json")
        exchange.sendResponseHeaders(status, bytes.size.toLong())
        exchange.responseBody.use { it.write(bytes) }
    }

    private fun sendNoContent(exchange: HttpExchange) {
        exchange.sendResponseHeaders(204, -1)
        exchange.responseBody.close()
    }

    /** Crude application/x-www-form-urlencoded query-string parser (single value per key). */
    private fun parseQs(raw: String): Map<String, String> {
        if (raw.isEmpty()) return emptyMap()
        return raw.split('&')
            .filter { it.isNotEmpty() }
            .associate { pair ->
                val eq = pair.indexOf('=')
                if (eq < 0) pair to "" else {
                    val k = java.net.URLDecoder.decode(pair.substring(0, eq), Charsets.UTF_8)
                    val v = java.net.URLDecoder.decode(pair.substring(eq + 1), Charsets.UTF_8)
                    k to v
                }
            }
    }

    private fun parseSort(raw: String?): Any? {
        if (raw.isNullOrEmpty()) return null
        val parts = raw.split(":", limit = 2)
        val field = parts.getOrNull(0) ?: return InvalidSort
        if (field !in SORT_ALLOWLIST) return InvalidSort
        val dir = when ((parts.getOrNull(1) ?: "asc").lowercase()) {
            "asc" -> SortOrder.ASC
            "desc" -> SortOrder.DESC
            else -> return InvalidSort
        }
        return ValidSort(field, dir)
    }

    private fun parseTimestamp(s: String): LocalDateTime {
        // The corpus uses `yyyy-MM-ddTHH:mm:ss` (no zone) for wall-clock times.
        return LocalDateTime.parse(s, TIMESTAMP_FMT)
    }

    private object InvalidSort
    private data class ValidSort(val field: String, val dir: SortOrder)

    companion object {
        // Mirrors the TS server's SORT_ALLOWLIST; cross-port contract.
        private val SORT_ALLOWLIST = setOf("id", "name", "createdAt")
        private val TIMESTAMP_FMT: DateTimeFormatter = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss")
    }

    /**
     * Exposed table for `authors`. Hand-written rather than reusing the
     * `entity-with-controller` snapshot (which is package `acme.blog`) — keeps
     * this test module self-contained.
     */
    object AuthorTable : Table("authors") {
        val id = long("id").autoIncrement()
        val name = varchar("name", 100)
        val bio = varchar("bio", 1000).nullable()
        val createdAt = datetime("createdAt")

        override val primaryKey = PrimaryKey(id)
    }
}

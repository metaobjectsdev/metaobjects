package com.metaobjects.integration.kotlin.api.jsonb

import com.fasterxml.jackson.databind.ObjectMapper
import com.metaobjects.integration.kotlin.PostgresContainer
import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import org.jetbrains.exposed.sql.Database
import org.jetbrains.exposed.sql.ResultRow
import org.jetbrains.exposed.sql.SchemaUtils
import org.jetbrains.exposed.sql.Table
import org.jetbrains.exposed.sql.insert
import org.jetbrains.exposed.sql.json.jsonb
import org.jetbrains.exposed.sql.selectAll
import org.jetbrains.exposed.sql.transactions.transaction
import java.net.InetSocketAddress
import java.sql.DriverManager

/**
 * Minimal reference Kotlin/Exposed HTTP server implementing the cross-port REST
 * API contract for the `Document` entity from the `jsonb/` api-contract-conformance
 * sub-corpus — the `field.string @dbColumnType=jsonb` open-JSON-bag contract
 * (issue #98).
 *
 * Why hand-rolled (vs the `KotlinSpringControllerGenerator` output): same trade-off
 * as the base `AuthorApiServer` — pulling a Spring Boot context in for a 2-route
 * contract test is disproportionate. The handler logic and wire shape mirror the
 * generated controller; the GENERATED lane ([com.metaobjects.integration.kotlin.api.jsonb.generated.GeneratedDocumentControllerHarness])
 * hosts the real artifact.
 *
 * The open-bag column is a real Postgres `JSONB` (Exposed `jsonb(...)`) whose
 * in-process Kotlin type is a kotlinx `JsonElement` — matching the generated
 * `DocumentTable`. The contract is object-in / object-out: a POSTed JSON object
 * reads back as the same object, never a JSON-encoded string.
 */
class DocumentApiServer(private val pg: PostgresContainer) : AutoCloseable {

    private val db: Database = Database.connect(pg.jdbcUrl, user = pg.username, password = pg.password)
    private val mapper = ObjectMapper()
    private val httpServer: HttpServer = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
    val baseUrl: String

    init {
        transaction(db) { SchemaUtils.create(DocumentTable) }

        httpServer.createContext("/api/documents") { exchange -> handle(exchange) }
        httpServer.executor = null
        httpServer.start()
        baseUrl = "http://127.0.0.1:${httpServer.address.port}"
    }

    override fun close() {
        httpServer.stop(0)
    }

    /** TRUNCATE + RESTART IDENTITY. */
    fun truncate() {
        DriverManager.getConnection(pg.jdbcUrl, pg.username, pg.password).use { c ->
            c.createStatement().use { it.execute("""TRUNCATE TABLE "documents" RESTART IDENTITY""") }
        }
    }

    /**
     * Apply the seed file's `rows[]` (each with a jsonb `payload` object), then bump
     * the serial sequence so the next implicit-id insert lands at `max(id) + 1` — so
     * the first scenario POST deterministically lands at id 3.
     */
    fun applySeed(rows: List<Map<String, Any?>>) {
        truncate()
        transaction(db) {
            for (r in rows) {
                DocumentTable.insert {
                    it[id] = (r["id"] as Number).toLong()
                    it[title] = r["title"] as String
                    it[payload] = toJsonElement(r["payload"])
                }
            }
        }
        DriverManager.getConnection(pg.jdbcUrl, pg.username, pg.password).use { c ->
            c.createStatement().use {
                it.execute("SELECT setval(pg_get_serial_sequence('documents', 'id'), COALESCE((SELECT MAX(id) FROM documents), 1))")
            }
        }
    }

    // -----------------------------------------------------------------------
    // HTTP handler — only the routes the jsonb scenario exercises (GET /{id}, POST).
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
        val idSegment = rawPath.removePrefix("/api/documents").trim('/').ifEmpty { null }

        when {
            method == "POST" && idSegment == null -> createDocument(exchange)
            method == "GET" && idSegment != null -> getDocument(exchange, idSegment)
            else -> sendJson(exchange, 404, mapOf("error" to "not_found"))
        }
    }

    private fun getDocument(exchange: HttpExchange, idStr: String) {
        val id = idStr.toLongOrNull()
            ?: return sendJson(exchange, 400, mapOf("error" to "invalid_id"))
        val row = transaction(db) {
            DocumentTable.selectAll().where { DocumentTable.id eq id }.singleOrNull()?.let(::rowToMap)
        }
        if (row == null) sendJson(exchange, 404, mapOf("error" to "not_found"))
        else sendJson(exchange, 200, row)
    }

    private fun createDocument(exchange: HttpExchange) {
        @Suppress("UNCHECKED_CAST")
        val body = readJsonBody(exchange) as? Map<String, Any?>
            ?: return sendJson(exchange, 400, mapOf("error" to "validation"))
        val newId = transaction(db) {
            DocumentTable.insert {
                it[title] = body["title"] as String
                it[payload] = toJsonElement(body["payload"])
            }[DocumentTable.id]
        }
        val row = transaction(db) {
            DocumentTable.selectAll().where { DocumentTable.id eq newId }.single().let(::rowToMap)
        }
        sendJson(exchange, 201, row)
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    /**
     * Map a row to the wire shape. `payload` is surfaced as a PARSED JSON value
     * (object/array/scalar) — never a JSON-encoded string. The stored `JsonElement`
     * is re-parsed into Jackson-native types so the response serializer emits a plain
     * object (`{"k":"v"}`), exactly the cross-port contract the generated lane locks.
     */
    private fun rowToMap(row: ResultRow): Map<String, Any?> = linkedMapOf(
        "id" to row[DocumentTable.id],
        "title" to row[DocumentTable.title],
        "payload" to fromJsonElement(row[DocumentTable.payload]),
    )

    /** Jackson value (Map/List/scalar/null) → kotlinx `JsonElement` (the column type). */
    private fun toJsonElement(value: Any?): JsonElement? =
        if (value == null) null else Json.parseToJsonElement(mapper.writeValueAsString(value))

    /** kotlinx `JsonElement` → Jackson-native value (Map/List/scalar) for the response. */
    private fun fromJsonElement(el: JsonElement?): Any? =
        if (el == null) null else mapper.readValue(el.toString(), Any::class.java)

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

    /**
     * Exposed table for `documents`. The `payload` column is a real Postgres `JSONB`
     * whose Kotlin type is a kotlinx `JsonElement` (the open-bag codec, mirroring the
     * generated `DocumentTable`: serialize via `JsonElement.toString()` = canonical
     * JSON, deserialize via `Json.parseToJsonElement`). Nullable because `payload`
     * carries no `@required` in the corpus.
     */
    object DocumentTable : Table("documents") {
        val id = long("id").autoIncrement()
        val title = varchar("title", 200)
        val payload = jsonb("payload", { it.toString() }, { Json.parseToJsonElement(it) }).nullable()

        override val primaryKey = PrimaryKey(id)
    }
}

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
import org.jetbrains.exposed.sql.update
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
                    // Both seed rows carry the required primaryMarker; row 1 also carries the
                    // optional single + array VO columns.
                    it[primaryMarker] = toJsonElement(r["primaryMarker"])!!
                    it[optionalMarker] = toJsonElement(r["optionalMarker"])
                    it[markers] = toJsonElement(r["markers"])
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
    // HTTP handler — only the routes the jsonb scenarios exercise (GET /{id}, POST, PATCH/PUT /{id}).
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
            (method == "PATCH" || method == "PUT") && idSegment != null -> updateDocument(exchange, idSegment)
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
        // primaryMarker is @required: absent / null / not-a-valid-Marker → 400.
        val primary = body["primaryMarker"]
        if (primary == null || !isValidMarker(primary)) return sendJson(exchange, 400, mapOf("error" to "validation"))
        // optional single VO: a present, non-null value must be a valid Marker.
        val optional = body["optionalMarker"]
        if (optional != null && !isValidMarker(optional)) return sendJson(exchange, 400, mapOf("error" to "validation"))
        // markers array-of-VO: a present, non-null value must be a list of valid Markers.
        val markersVal = body["markers"]
        if (markersVal != null && !(markersVal is List<*> && markersVal.all { isValidMarker(it) }))
            return sendJson(exchange, 400, mapOf("error" to "validation"))
        val newId = transaction(db) {
            DocumentTable.insert {
                it[title] = body["title"] as String
                it[payload] = toJsonElement(body["payload"])
                it[primaryMarker] = toJsonElement(primary)!!
                it[optionalMarker] = toJsonElement(optional)
                it[markers] = toJsonElement(markersVal)
            }[DocumentTable.id]
        }
        val row = transaction(db) {
            DocumentTable.selectAll().where { DocumentTable.id eq newId }.single().let(::rowToMap)
        }
        sendJson(exchange, 201, row)
    }

    /**
     * PATCH / PUT — the FR-035 present-key tristate + Program D nested value-object validation.
     * absent → untouched; present-null → clears a NULLABLE column / 400 on the @required
     * primaryMarker; present value → validated (label @required @maxLength 40 per element) + written.
     * Every mutation re-reads via GET (the caller) to convict persistence.
     */
    private fun updateDocument(exchange: HttpExchange, idStr: String) {
        val id = idStr.toLongOrNull()
            ?: return sendJson(exchange, 400, mapOf("error" to "invalid_id"))
        @Suppress("UNCHECKED_CAST")
        val body = readJsonBody(exchange) as? Map<String, Any?>
            ?: return sendJson(exchange, 400, mapOf("error" to "validation"))
        // title is @required: an explicit null clears nothing — it is a 400.
        if (body.containsKey("title") && body["title"] == null)
            return sendJson(exchange, 400, mapOf("error" to "validation"))
        // primaryMarker @required: present-null → 400; a present value must be a valid Marker.
        if (body.containsKey("primaryMarker")) {
            val v = body["primaryMarker"]
            if (v == null || !isValidMarker(v)) return sendJson(exchange, 400, mapOf("error" to "validation"))
        }
        // optionalMarker nullable single VO: present-null clears; a present value must be valid.
        if (body.containsKey("optionalMarker")) {
            val v = body["optionalMarker"]
            if (v != null && !isValidMarker(v)) return sendJson(exchange, 400, mapOf("error" to "validation"))
        }
        // markers nullable array-of-VO: present-null clears; present-[] empties; each present element valid.
        if (body.containsKey("markers")) {
            val v = body["markers"]
            if (v != null && !(v is List<*> && v.all { isValidMarker(it) }))
                return sendJson(exchange, 400, mapOf("error" to "validation"))
        }
        // Apply only the present keys (absent = untouched). Guard the empty-SET case (Exposed throws).
        val settableKeys = listOf("title", "payload", "primaryMarker", "optionalMarker", "markers")
        if (settableKeys.any { body.containsKey(it) }) {
            transaction(db) {
                DocumentTable.update({ DocumentTable.id eq id }) {
                    if (body.containsKey("title")) it[title] = body["title"] as String
                    if (body.containsKey("payload")) it[payload] = toJsonElement(body["payload"])
                    if (body.containsKey("primaryMarker")) it[primaryMarker] = toJsonElement(body["primaryMarker"])!!
                    if (body.containsKey("optionalMarker")) it[optionalMarker] = toJsonElement(body["optionalMarker"])
                    if (body.containsKey("markers")) it[markers] = toJsonElement(body["markers"])
                }
            }
        }
        val row = transaction(db) {
            DocumentTable.selectAll().where { DocumentTable.id eq id }.singleOrNull()?.let(::rowToMap)
        }
        if (row == null) sendJson(exchange, 404, mapOf("error" to "not_found"))
        else sendJson(exchange, 200, row)
    }

    /**
     * True iff [value] is a valid `Marker` value object: `label` is a NON-EMPTY string ≤ 40 chars
     * (FR-036 required-string: rejects null / ""; whitespace accepted), `score` is unconstrained.
     */
    private fun isValidMarker(value: Any?): Boolean {
        val map = value as? Map<*, *> ?: return false
        val label = map["label"] as? String ?: return false
        return label.isNotEmpty() && label.length <= 40
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
        // VO columns surface as parsed objects/arrays (or null), never JSON-encoded strings.
        "primaryMarker" to fromJsonElement(row[DocumentTable.primaryMarker]),
        "optionalMarker" to fromJsonElement(row[DocumentTable.optionalMarker]),
        "markers" to fromJsonElement(row[DocumentTable.markers]),
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

        // Program D value-object jsonb columns. Modelled the same way as the open bag (a real
        // Postgres JSONB whose in-process value is a kotlinx JsonElement); the reference server
        // validates the Marker shape (label @required @maxLength 40; score int) IN CODE — the
        // generated lane validates via jakarta constraints on the emitted VO record instead.
        val primaryMarker = jsonb("primary_marker", { it.toString() }, { Json.parseToJsonElement(it) })
        val optionalMarker = jsonb("optional_marker", { it.toString() }, { Json.parseToJsonElement(it) }).nullable()
        val markers = jsonb("markers", { it.toString() }, { Json.parseToJsonElement(it) }).nullable()

        override val primaryKey = PrimaryKey(id)
    }
}

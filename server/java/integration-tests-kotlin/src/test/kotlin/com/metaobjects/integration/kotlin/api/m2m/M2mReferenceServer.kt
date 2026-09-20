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
 * Creates the physical tables via raw JDBC against Testcontainers Postgres,
 * seeds them from the shared `seed.json`, and exposes the M:N traversal
 * sub-resources over a JDK `HttpServer`:
 *  - `GET /api/posts/{id}/tags`        — hetero (Post—Tag via PostTag);
 *  - `GET /api/persons/{id}/following` — directed self-join (source FK followerId);
 *  - `GET /api/persons/{id}/friends`   — symmetric self-join (union on read);
 *  - `GET /api/posts/{id}/reviewers`   — FW-8 target side: `@objectRef` resolves to the
 *    concrete TPH subtype `MemberAccount`, so the joined `accounts` rows are
 *    additionally narrowed to `kind = 'Member'`;
 *  - `GET /api/accounts/{id}/badges`   — FW-8 base-declared, UNGATED (rule a);
 *  - `GET /api/accounts/<seg>/{id}/<relation>` — FW-8 subtype-scoped (`<seg>` is
 *    `member` or `guest`): verifies `id` names a row of that subtype BEFORE joining
 *    (rule c) — a mismatch answers `200 []`, never a sibling's rows.
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
                // FW-8 (FR-018 x FR-017): the TPH discriminator base — ONE shared table for
                // Account/MemberAccount/GuestAccount; "kind" is the discriminator column,
                // "karma" (Member-only) and "invitedBy" (Guest-only) are nullable since a row
                // of the other subtype never sets them.
                st.execute("CREATE TABLE \"accounts\" (id BIGINT PRIMARY KEY, kind VARCHAR(20) NOT NULL, " +
                    "handle VARCHAR(80) NOT NULL, karma INTEGER, \"invitedBy\" VARCHAR(80))")
                st.execute("CREATE TABLE \"account_tags\" (\"accountId\" BIGINT NOT NULL, \"tagId\" BIGINT NOT NULL, " +
                    "PRIMARY KEY (\"accountId\", \"tagId\"))")
                st.execute("CREATE TABLE \"scoped_account_tags\" (\"accountId\" BIGINT NOT NULL, \"tagId\" BIGINT NOT NULL, " +
                    "PRIMARY KEY (\"accountId\", \"tagId\"))")
                st.execute("CREATE TABLE \"member_account_tags\" (\"accountId\" BIGINT NOT NULL, \"tagId\" BIGINT NOT NULL, " +
                    "PRIMARY KEY (\"accountId\", \"tagId\"))")
                st.execute("CREATE TABLE \"post_reviewers\" (\"postId\" BIGINT NOT NULL, \"accountId\" BIGINT NOT NULL, " +
                    "PRIMARY KEY (\"postId\", \"accountId\"))")
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
            insertAccounts(c, M2mSeed.rows(seed, "accounts"))
            insertRows(c, "INSERT INTO \"account_tags\" (\"accountId\", \"tagId\") VALUES (?, ?)",
                M2mSeed.rows(seed, "account_tags"), "accountId", "tagId")
            insertRows(c, "INSERT INTO \"scoped_account_tags\" (\"accountId\", \"tagId\") VALUES (?, ?)",
                M2mSeed.rows(seed, "scoped_account_tags"), "accountId", "tagId")
            insertRows(c, "INSERT INTO \"member_account_tags\" (\"accountId\", \"tagId\") VALUES (?, ?)",
                M2mSeed.rows(seed, "member_account_tags"), "accountId", "tagId")
            insertRows(c, "INSERT INTO \"post_reviewers\" (\"postId\", \"accountId\") VALUES (?, ?)",
                M2mSeed.rows(seed, "post_reviewers"), "postId", "accountId")
        }
    }

    /** Accounts has 5 columns, two of them nullable (subtype-specific) — the generic
     * 2-column [insertRows] helper doesn't fit; explicit typed binding here instead
     * (karma is INTEGER, not BIGINT — the generic [bind]'s Number branch calls setLong). */
    private fun insertAccounts(c: Connection, rows: List<Map<String, Any?>>) {
        c.prepareStatement(
            "INSERT INTO \"accounts\" (id, kind, handle, karma, \"invitedBy\") VALUES (?, ?, ?, ?, ?)"
        ).use { ps ->
            for (r in rows) {
                ps.setLong(1, (r["id"] as Number).toLong())
                ps.setString(2, r["kind"] as String)
                ps.setString(3, r["handle"] as String)
                val karma = r["karma"]
                if (karma is Number) ps.setInt(4, karma.toInt()) else ps.setNull(4, java.sql.Types.INTEGER)
                val invitedBy = r["invitedBy"]
                if (invitedBy != null) ps.setString(5, invitedBy as String) else ps.setNull(5, java.sql.Types.VARCHAR)
                ps.executeUpdate()
            }
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
        val seg = exchange.requestURI.rawPath.split("/")
        if (method != "GET" || seg.size < 5 || seg[1] != "api") {
            sendJson(exchange, 404, mapOf("error" to "not_found")); return
        }
        val plural = seg[2]

        val rows: List<Map<String, Any?>> = when {
            seg.size == 5 -> {
                // ["", "api", "<plural>", "<id>", "<relation>"]
                val id = seg[3].toLong()
                val relation = seg[4]
                when {
                    plural == "posts" && relation == "tags" ->
                        traverse(id, "post_tags", "postId", "tagId", "tags", false)
                    plural == "posts" && relation == "reviewers" ->
                        // FW-8 target side: post_reviewers -> accounts, narrowed to kind = "Member"
                        // (the target @objectRef resolves to the concrete TPH subtype MemberAccount).
                        traverseTargetScoped(id, "post_reviewers", "postId", "accountId",
                            "accounts", "kind", "Member")
                    plural == "persons" && relation == "following" ->
                        traverse(id, "follows", "followerId", "followeeId", "people", false)
                    plural == "persons" && relation == "friends" ->
                        traverse(id, "friendships", "personAId", "personBId", "people", true)
                    plural == "accounts" && relation == "badges" ->
                        // FW-8 rule (a): base-declared, UNGATED — every row of the shared
                        // accounts table (Member or Guest) is a legitimate source.
                        traverse(id, "account_tags", "accountId", "tagId", "tags", false)
                    else -> { sendJson(exchange, 404, mapOf("error" to "not_found")); return }
                }
            }
            seg.size == 6 && plural == "accounts" -> {
                // FW-8 rule (b)/(c): ["", "api", "accounts", "<subtypeSeg>", "<id>", "<relation>"]
                val subtypeValue = when (seg[3]) {
                    "member" -> "Member"
                    "guest" -> "Guest"
                    else -> null
                }
                if (subtypeValue == null) { sendJson(exchange, 404, mapOf("error" to "not_found")); return }
                val id = seg[4].toLong()
                val junctionTable = when (seg[5]) {
                    "badges" -> "account_tags"
                    "scopes" -> "scoped_account_tags"
                    "interests" -> "member_account_tags"
                    else -> null
                }
                if (junctionTable == null) { sendJson(exchange, 404, mapOf("error" to "not_found")); return }
                // Rule (c): verify sourceId names a row of THIS subtype BEFORE ever joining —
                // a miss answers 200 [] rather than reaching the junction, where the FK alone
                // addresses the shared base table and cannot tell subtypes apart.
                if (!rowIsKind(id, "accounts", "kind", subtypeValue)) {
                    sendJson(exchange, 200, emptyList<Map<String, Any?>>()); return
                }
                traverse(id, junctionTable, "accountId", "tagId", "tags", false)
            }
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

    /**
     * FW-8 target side: the relationship's `@objectRef` target is a concrete TPH subtype,
     * so its rows physically live in its discriminator base's shared table alongside its
     * siblings — an unscoped join cannot tell a genuine match from a same-table sibling.
     * Narrow the joined target rows to `targetDiscValue` AFTER the join (the junction FK
     * itself addresses the shared base table either way).
     */
    private fun traverseTargetScoped(
        sourceId: Long, junction: String, sourceFk: String, targetFk: String,
        targetTable: String, targetDiscColumn: String, targetDiscValue: String,
    ): List<Map<String, Any?>> {
        val relatedIds = LinkedHashSet<Long>()
        connect().use { c ->
            c.prepareStatement(
                "SELECT \"$targetFk\" FROM \"$junction\" WHERE \"$sourceFk\" = ?").use { ps ->
                ps.setLong(1, sourceId)
                ps.executeQuery().use { rs -> while (rs.next()) relatedIds.add(rs.getLong(1)) }
            }
        }
        if (relatedIds.isEmpty()) return emptyList()

        val out = ArrayList<Map<String, Any?>>(relatedIds.size)
        connect().use { c ->
            for (rid in relatedIds) {
                c.prepareStatement(
                    "SELECT id, kind, handle, karma FROM \"$targetTable\" WHERE id = ? AND \"$targetDiscColumn\" = ?"
                ).use { ps ->
                    ps.setLong(1, rid)
                    ps.setString(2, targetDiscValue)
                    ps.executeQuery().use { rs ->
                        if (rs.next()) {
                            val karma = rs.getInt("karma")
                            out.add(linkedMapOf(
                                "id" to rs.getLong("id"),
                                "kind" to rs.getString("kind"),
                                "handle" to rs.getString("handle"),
                                "karma" to (if (rs.wasNull()) null else karma),
                            ))
                        }
                    }
                }
            }
        }
        return out
    }

    /** Rule (c): does `id` name a row of `table` whose `column` equals `value`? Checked
     * BEFORE joining a subtype-scoped mount. */
    private fun rowIsKind(id: Long, table: String, column: String, value: String): Boolean {
        connect().use { c ->
            c.prepareStatement("SELECT 1 FROM \"$table\" WHERE id = ? AND \"$column\" = ?").use { ps ->
                ps.setLong(1, id)
                ps.setString(2, value)
                ps.executeQuery().use { rs -> return rs.next() }
            }
        }
    }

    private fun sendJson(exchange: HttpExchange, status: Int, body: Any?) {
        val bytes = mapper.writeValueAsBytes(body)
        exchange.responseHeaders.set("Content-Type", "application/json")
        exchange.sendResponseHeaders(status, bytes.size.toLong())
        exchange.responseBody.use { it.write(bytes) }
    }
}

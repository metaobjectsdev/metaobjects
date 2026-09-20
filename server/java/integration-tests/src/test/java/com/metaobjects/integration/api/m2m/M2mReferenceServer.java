package com.metaobjects.integration.api.m2m;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.metaobjects.integration.PostgresContainer;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.sql.Types;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * FR-018 — hand-rolled reference server for the M:N api-contract corpus
 * ({@code fixtures/api-contract-conformance/m2m/}). Mirrors the cross-port
 * reference lane (TS {@code api-contract-m2m.test.ts}, C# {@code M2mReferenceServer}).
 *
 * <p>Creates the physical tables via raw JDBC against Testcontainers Postgres,
 * seeds them from the shared {@code seed.json}, and exposes the M:N traversal
 * sub-resources over a JDK {@code HttpServer}:</p>
 * <ul>
 *   <li>{@code GET /api/posts/{id}/tags} — hetero ({@code Post}—{@code Tag} via {@code PostTag});</li>
 *   <li>{@code GET /api/persons/{id}/following} — directed self-join (source FK {@code followerId});</li>
 *   <li>{@code GET /api/persons/{id}/friends} — symmetric self-join (union on read);</li>
 *   <li>{@code GET /api/posts/{id}/reviewers} — FW-8 target-side: {@code @objectRef} resolves
 *       to the concrete TPH subtype {@code MemberAccount}, so the joined {@code accounts} rows
 *       are additionally narrowed to {@code kind = 'Member'};</li>
 *   <li>{@code GET /api/accounts/{id}/badges} — FW-8 base-declared, UNGATED (rule a): every
 *       row of the shared {@code accounts} table is a legitimate source;</li>
 *   <li>{@code GET /api/accounts/<seg>/{id}/<relation>} — FW-8 subtype-scoped ({@code <seg>} is
 *       {@code member} or {@code guest}): verifies {@code id} names a row of that subtype
 *       BEFORE joining (rule c) — a mismatch answers {@code 200 []}, never a sibling's rows.</li>
 * </ul>
 *
 * <p>The traversal SQL is hand-written here (the cross-port contract is what both
 * this and the generated lane must satisfy). The source URL segment is the entity
 * name pluralized ({@code Post}→{@code posts}, {@code Person}→{@code persons}); the
 * relation segment is the relationship name.</p>
 */
final class M2mReferenceServer implements AutoCloseable {

    private final PostgresContainer pg;
    private final ObjectMapper mapper = new ObjectMapper();
    private final HttpServer httpServer;
    private final String baseUrl;

    M2mReferenceServer(PostgresContainer pg, Map<String, List<Map<String, Object>>> seed) {
        this.pg = pg;
        try {
            createSchema();
            applySeed(seed);
            this.httpServer = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            httpServer.createContext("/api/", this::handle);
            httpServer.setExecutor(null);
            httpServer.start();
            this.baseUrl = "http://127.0.0.1:" + httpServer.getAddress().getPort();
        } catch (IOException | SQLException e) {
            throw new RuntimeException("could not start M2mReferenceServer", e);
        }
    }

    String baseUrl() { return baseUrl; }

    @Override public void close() { httpServer.stop(0); }

    private void createSchema() throws SQLException {
        try (Connection c = connect(); Statement st = c.createStatement()) {
            st.execute("CREATE TABLE \"posts\"  (id BIGINT PRIMARY KEY, title VARCHAR(200) NOT NULL)");
            st.execute("CREATE TABLE \"tags\"   (id BIGINT PRIMARY KEY, name VARCHAR(80) NOT NULL)");
            st.execute("CREATE TABLE \"post_tags\" (\"postId\" BIGINT NOT NULL, \"tagId\" BIGINT NOT NULL, "
                + "PRIMARY KEY (\"postId\", \"tagId\"))");
            st.execute("CREATE TABLE \"people\" (id BIGINT PRIMARY KEY, name VARCHAR(80) NOT NULL)");
            st.execute("CREATE TABLE \"follows\" (\"followerId\" BIGINT NOT NULL, \"followeeId\" BIGINT NOT NULL, "
                + "PRIMARY KEY (\"followerId\", \"followeeId\"))");
            st.execute("CREATE TABLE \"friendships\" (\"personAId\" BIGINT NOT NULL, \"personBId\" BIGINT NOT NULL, "
                + "PRIMARY KEY (\"personAId\", \"personBId\"))");
            // FW-8 (FR-018 x FR-017): the TPH discriminator base — ONE shared table for
            // Account/MemberAccount/GuestAccount (single-table inheritance); "kind" is the
            // discriminator column, "karma" (Member-only) and "invitedBy" (Guest-only) are
            // nullable since a row of the other subtype never sets them.
            st.execute("CREATE TABLE \"accounts\" (id BIGINT PRIMARY KEY, kind VARCHAR(20) NOT NULL, "
                + "handle VARCHAR(80) NOT NULL, karma INTEGER, \"invitedBy\" VARCHAR(80))");
            st.execute("CREATE TABLE \"account_tags\" (\"accountId\" BIGINT NOT NULL, \"tagId\" BIGINT NOT NULL, "
                + "PRIMARY KEY (\"accountId\", \"tagId\"))");
            st.execute("CREATE TABLE \"scoped_account_tags\" (\"accountId\" BIGINT NOT NULL, \"tagId\" BIGINT NOT NULL, "
                + "PRIMARY KEY (\"accountId\", \"tagId\"))");
            st.execute("CREATE TABLE \"member_account_tags\" (\"accountId\" BIGINT NOT NULL, \"tagId\" BIGINT NOT NULL, "
                + "PRIMARY KEY (\"accountId\", \"tagId\"))");
            st.execute("CREATE TABLE \"post_reviewers\" (\"postId\" BIGINT NOT NULL, \"accountId\" BIGINT NOT NULL, "
                + "PRIMARY KEY (\"postId\", \"accountId\"))");
            // PostCategory — route-spelling gate. Physical name deliberately unlike
            // its route segment (/post_categories), so echoing the table cannot pass.
            st.execute("CREATE TABLE \"blog_categories\" (id BIGINT PRIMARY KEY, name VARCHAR(80) NOT NULL)");
        }
    }

    private void applySeed(Map<String, List<Map<String, Object>>> seed) throws SQLException {
        try (Connection c = connect()) {
            insertRows(c, "INSERT INTO \"posts\" (id, title) VALUES (?, ?)",
                M2mSeed.rows(seed, "posts"), "id", "title");
            insertRows(c, "INSERT INTO \"tags\" (id, name) VALUES (?, ?)",
                M2mSeed.rows(seed, "tags"), "id", "name");
            insertRows(c, "INSERT INTO \"post_tags\" (\"postId\", \"tagId\") VALUES (?, ?)",
                M2mSeed.rows(seed, "post_tags"), "postId", "tagId");
            insertRows(c, "INSERT INTO \"people\" (id, name) VALUES (?, ?)",
                M2mSeed.rows(seed, "people"), "id", "name");
            insertRows(c, "INSERT INTO \"follows\" (\"followerId\", \"followeeId\") VALUES (?, ?)",
                M2mSeed.rows(seed, "follows"), "followerId", "followeeId");
            insertRows(c, "INSERT INTO \"friendships\" (\"personAId\", \"personBId\") VALUES (?, ?)",
                M2mSeed.rows(seed, "friendships"), "personAId", "personBId");
            insertAccounts(c, M2mSeed.rows(seed, "accounts"));
            insertRows(c, "INSERT INTO \"account_tags\" (\"accountId\", \"tagId\") VALUES (?, ?)",
                M2mSeed.rows(seed, "account_tags"), "accountId", "tagId");
            insertRows(c, "INSERT INTO \"scoped_account_tags\" (\"accountId\", \"tagId\") VALUES (?, ?)",
                M2mSeed.rows(seed, "scoped_account_tags"), "accountId", "tagId");
            insertRows(c, "INSERT INTO \"member_account_tags\" (\"accountId\", \"tagId\") VALUES (?, ?)",
                M2mSeed.rows(seed, "member_account_tags"), "accountId", "tagId");
            insertRows(c, "INSERT INTO \"post_reviewers\" (\"postId\", \"accountId\") VALUES (?, ?)",
                M2mSeed.rows(seed, "post_reviewers"), "postId", "accountId");
            insertRows(c, "INSERT INTO \"blog_categories\" (id, name) VALUES (?, ?)",
                M2mSeed.rows(seed, "blog_categories"), "id", "name");
        }
    }

    /** Accounts has 5 columns, two of them nullable (subtype-specific) — the generic
     * 2-column {@link #insertRows} helper doesn't fit; explicit binding here instead. */
    private static void insertAccounts(Connection c, List<Map<String, Object>> rows) throws SQLException {
        try (PreparedStatement ps = c.prepareStatement(
            "INSERT INTO \"accounts\" (id, kind, handle, karma, \"invitedBy\") VALUES (?, ?, ?, ?, ?)")) {
            for (Map<String, Object> r : rows) {
                ps.setLong(1, ((Number) r.get("id")).longValue());
                ps.setString(2, (String) r.get("kind"));
                ps.setString(3, (String) r.get("handle"));
                Object karma = r.get("karma");
                if (karma instanceof Number n) ps.setInt(4, n.intValue()); else ps.setNull(4, Types.INTEGER);
                Object invitedBy = r.get("invitedBy");
                if (invitedBy != null) ps.setString(5, (String) invitedBy); else ps.setNull(5, Types.VARCHAR);
                ps.executeUpdate();
            }
        }
    }

    private static void insertRows(Connection c, String sql, List<Map<String, Object>> rows,
                                   String col1, String col2) throws SQLException {
        try (PreparedStatement ps = c.prepareStatement(sql)) {
            for (Map<String, Object> r : rows) {
                Object v1 = r.get(col1);
                Object v2 = r.get(col2);
                if (v1 instanceof Number n1) ps.setLong(1, n1.longValue());
                else ps.setObject(1, v1);
                if (v2 instanceof Number n2) ps.setLong(2, n2.longValue());
                else ps.setObject(2, v2);
                ps.executeUpdate();
            }
        }
    }

    // -----------------------------------------------------------------------
    // HTTP handler — dispatch the three M:N traversal sub-resources.
    // -----------------------------------------------------------------------

    private void handle(HttpExchange exchange) {
        try {
            doHandle(exchange);
        } catch (Exception e) {
            try { sendJson(exchange, 500, Map.of("error", "internal", "message", String.valueOf(e.getMessage()))); }
            catch (IOException ignored) { /* nothing more we can do */ }
        } finally {
            exchange.close();
        }
    }

    private void doHandle(HttpExchange exchange) throws IOException, SQLException {
        String method = exchange.getRequestMethod().toUpperCase(Locale.ROOT);
        String path = exchange.getRequestURI().getRawPath();
        String[] seg = path.split("/");

        // The one plain collection the route-spelling scenario needs:
        // ["", "api", "post_categories"]. The segment is a LITERAL on purpose —
        // this lane exists to be an INDEPENDENT implementation, so deriving it from
        // SpringNaming would make both lanes share any bug in that rule and the
        // scenario would pass regardless. The retired spellings are simply not
        // handled, so they fall through to the 404 below.
        if (method.equals("GET") && seg.length == 3 && seg[1].equals("api")
                && seg[2].equals("post_categories")) {
            sendJson(exchange, 200, selectBlogCategories());
            return;
        }

        if (!method.equals("GET") || seg.length < 5 || !seg[1].equals("api")) {
            sendJson(exchange, 404, Map.of("error", "not_found"));
            return;
        }
        String plural = seg[2];

        List<Map<String, Object>> rows;
        if (seg.length == 5) {
            // ["", "api", "<plural>", "<id>", "<relation>"]
            long id = Long.parseLong(seg[3]);
            String relation = seg[4];
            if (plural.equals("posts") && relation.equals("tags")) {
                // hetero: junction post_tags(postId source, tagId target) -> tags
                rows = traverse(id, "post_tags", "postId", "tagId", "tags", false);
            } else if (plural.equals("posts") && relation.equals("reviewers")) {
                // FW-8 target side: post_reviewers -> accounts, narrowed to kind = "Member"
                // (the target @objectRef resolves to the concrete TPH subtype MemberAccount).
                rows = traverseTargetScoped(id, "post_reviewers", "postId", "accountId",
                    "accounts", "kind", "Member");
            } else if (plural.equals("persons") && relation.equals("following")) {
                // directed self-join: follows(followerId source, followeeId target) -> people
                rows = traverse(id, "follows", "followerId", "followeeId", "people", false);
            } else if (plural.equals("persons") && relation.equals("friends")) {
                // symmetric self-join: friendships(personAId, personBId) union-on-read -> people
                rows = traverse(id, "friendships", "personAId", "personBId", "people", true);
            } else if (plural.equals("accounts") && relation.equals("badges")) {
                // FW-8 rule (a): base-declared, UNGATED — every row of the shared accounts
                // table (Member or Guest) is a legitimate source.
                rows = traverse(id, "account_tags", "accountId", "tagId", "tags", false);
            } else {
                sendJson(exchange, 404, Map.of("error", "not_found"));
                return;
            }
        } else if (seg.length == 6 && plural.equals("accounts")) {
            // FW-8 rule (b)/(c): ["", "api", "accounts", "<subtypeSeg>", "<id>", "<relation>"]
            String subtypeSeg = seg[3];
            String subtypeValue = subtypeSeg.equals("member") ? "Member"
                : subtypeSeg.equals("guest") ? "Guest" : null;
            if (subtypeValue == null) {
                sendJson(exchange, 404, Map.of("error", "not_found"));
                return;
            }
            long id = Long.parseLong(seg[4]);
            String relation = seg[5];
            String junctionTable;
            if (relation.equals("badges")) junctionTable = "account_tags";
            else if (relation.equals("scopes")) junctionTable = "scoped_account_tags";
            else if (relation.equals("interests")) junctionTable = "member_account_tags";
            else {
                sendJson(exchange, 404, Map.of("error", "not_found"));
                return;
            }
            // Rule (c): verify sourceId names a row of THIS subtype BEFORE ever joining — a
            // miss answers 200 [] rather than reaching the junction, where the FK alone
            // addresses the shared base table and cannot tell subtypes apart.
            if (!rowIsKind(id, "accounts", "kind", subtypeValue)) {
                sendJson(exchange, 200, List.of());
                return;
            }
            rows = traverse(id, junctionTable, "accountId", "tagId", "tags", false);
        } else {
            sendJson(exchange, 404, Map.of("error", "not_found"));
            return;
        }
        sendJson(exchange, 200, rows);
    }

    /**
     * Resolve the related target rows by traversing a junction.
     *
     * <p>Hetero / directed: {@code WHERE sourceFk = :id}, related id = {@code targetFk}.
     * Symmetric: {@code WHERE sourceFk = :id OR targetFk = :id}, related id = the
     * column that is NOT the source id (union-on-read, single-row storage).</p>
     */
    private List<Map<String, Object>> traverse(long sourceId, String junction, String sourceFk,
                                               String targetFk, String targetTable, boolean symmetric)
            throws SQLException {
        Set<Long> relatedIds = new LinkedHashSet<>();
        String where = symmetric
            ? "\"" + sourceFk + "\" = ? OR \"" + targetFk + "\" = ?"
            : "\"" + sourceFk + "\" = ?";
        try (Connection c = connect();
             PreparedStatement ps = c.prepareStatement(
                 "SELECT \"" + sourceFk + "\", \"" + targetFk + "\" FROM \"" + junction + "\" WHERE " + where)) {
            ps.setLong(1, sourceId);
            if (symmetric) ps.setLong(2, sourceId);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    long a = rs.getLong(1);
                    long b = rs.getLong(2);
                    relatedIds.add(symmetric ? (a == sourceId ? b : a) : b);
                }
            }
        }
        if (relatedIds.isEmpty()) return List.of();

        List<Map<String, Object>> out = new ArrayList<>(relatedIds.size());
        try (Connection c = connect()) {
            for (Long rid : relatedIds) {
                try (PreparedStatement ps = c.prepareStatement(
                    "SELECT id, name FROM \"" + targetTable + "\" WHERE id = ?")) {
                    ps.setLong(1, rid);
                    try (ResultSet rs = ps.executeQuery()) {
                        if (rs.next()) {
                            Map<String, Object> row = new LinkedHashMap<>();
                            row.put("id", rs.getLong("id"));
                            row.put("name", rs.getString("name"));
                            out.add(row);
                        }
                    }
                }
            }
        }
        return out;
    }

    /**
     * FW-8 target side: the relationship's {@code @objectRef} target is a concrete TPH
     * subtype, so its rows physically live in its discriminator base's shared table
     * alongside its siblings — an unscoped join cannot tell a genuine match from a
     * same-table sibling. Narrow the joined target rows to
     * {@code targetDiscValue} AFTER the join (the junction FK itself addresses the
     * shared base table either way, so the narrowing cannot happen inside the join).
     */
    private List<Map<String, Object>> traverseTargetScoped(long sourceId, String junction, String sourceFk,
                                                            String targetFk, String targetTable,
                                                            String targetDiscColumn, String targetDiscValue)
            throws SQLException {
        Set<Long> relatedIds = new LinkedHashSet<>();
        try (Connection c = connect();
             PreparedStatement ps = c.prepareStatement(
                 "SELECT \"" + targetFk + "\" FROM \"" + junction + "\" WHERE \"" + sourceFk + "\" = ?")) {
            ps.setLong(1, sourceId);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) relatedIds.add(rs.getLong(1));
            }
        }
        if (relatedIds.isEmpty()) return List.of();

        List<Map<String, Object>> out = new ArrayList<>(relatedIds.size());
        try (Connection c = connect()) {
            for (Long rid : relatedIds) {
                try (PreparedStatement ps = c.prepareStatement(
                    "SELECT id, kind, handle, karma FROM \"" + targetTable + "\" WHERE id = ? AND \""
                        + targetDiscColumn + "\" = ?")) {
                    ps.setLong(1, rid);
                    ps.setString(2, targetDiscValue);
                    try (ResultSet rs = ps.executeQuery()) {
                        if (rs.next()) {
                            Map<String, Object> row = new LinkedHashMap<>();
                            row.put("id", rs.getLong("id"));
                            row.put("kind", rs.getString("kind"));
                            row.put("handle", rs.getString("handle"));
                            int karma = rs.getInt("karma");
                            row.put("karma", rs.wasNull() ? null : karma);
                            out.add(row);
                        }
                    }
                }
            }
        }
        return out;
    }

    /** Rule (c): does {@code id} name a row of {@code table} whose {@code column} equals
     * {@code value}? Checked BEFORE joining a subtype-scoped mount. */
    private boolean rowIsKind(long id, String table, String column, String value) throws SQLException {
        try (Connection c = connect();
             PreparedStatement ps = c.prepareStatement(
                 "SELECT 1 FROM \"" + table + "\" WHERE id = ? AND \"" + column + "\" = ?")) {
            ps.setLong(1, id);
            ps.setString(2, value);
            try (ResultSet rs = ps.executeQuery()) {
                return rs.next();
            }
        }
    }

    // -----------------------------------------------------------------------
    // helpers
    // -----------------------------------------------------------------------

    private Connection connect() throws SQLException {
        return DriverManager.getConnection(pg.jdbcUrl(), pg.username(), pg.password());
    }

    /** Every blog_categories row, ordered by id — the shape a generated collection returns. */
    private List<Map<String, Object>> selectBlogCategories() throws SQLException {
        List<Map<String, Object>> out = new ArrayList<>();
        try (Connection c = connect();
             PreparedStatement ps = c.prepareStatement(
                 "SELECT id, name FROM \"blog_categories\" ORDER BY id")) {
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    Map<String, Object> row = new LinkedHashMap<>();
                    row.put("id", rs.getLong("id"));
                    row.put("name", rs.getString("name"));
                    out.add(row);
                }
            }
        }
        return out;
    }

    private void sendJson(HttpExchange exchange, int status, Object body) throws IOException {
        byte[] bytes = mapper.writeValueAsBytes(body);
        exchange.getResponseHeaders().set("Content-Type", "application/json");
        exchange.sendResponseHeaders(status, bytes.length);
        try (OutputStream os = exchange.getResponseBody()) { os.write(bytes); }
    }
}

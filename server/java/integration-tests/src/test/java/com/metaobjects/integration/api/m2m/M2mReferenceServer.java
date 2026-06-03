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
 * <p>Creates the six physical tables via raw JDBC against Testcontainers Postgres,
 * seeds them from the shared {@code seed.json}, and exposes the three M:N
 * traversal sub-resources over a JDK {@code HttpServer}:</p>
 * <ul>
 *   <li>{@code GET /api/posts/{id}/tags} — hetero ({@code Post}—{@code Tag} via {@code PostTag});</li>
 *   <li>{@code GET /api/persons/{id}/following} — directed self-join (source FK {@code followerId});</li>
 *   <li>{@code GET /api/persons/{id}/friends} — symmetric self-join (union on read).</li>
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
        String[] seg = path.split("/");        // ["", "api", "<plural>", "<id>", "<relation>"]
        if (!method.equals("GET") || seg.length != 5 || !seg[1].equals("api")) {
            sendJson(exchange, 404, Map.of("error", "not_found"));
            return;
        }
        String plural = seg[2];
        long id = Long.parseLong(seg[3]);
        String relation = seg[4];

        List<Map<String, Object>> rows;
        if (plural.equals("posts") && relation.equals("tags")) {
            // hetero: junction post_tags(postId source, tagId target) -> tags
            rows = traverse(id, "post_tags", "postId", "tagId", "tags", false);
        } else if (plural.equals("persons") && relation.equals("following")) {
            // directed self-join: follows(followerId source, followeeId target) -> people
            rows = traverse(id, "follows", "followerId", "followeeId", "people", false);
        } else if (plural.equals("persons") && relation.equals("friends")) {
            // symmetric self-join: friendships(personAId, personBId) union-on-read -> people
            rows = traverse(id, "friendships", "personAId", "personBId", "people", true);
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

    // -----------------------------------------------------------------------
    // helpers
    // -----------------------------------------------------------------------

    private Connection connect() throws SQLException {
        return DriverManager.getConnection(pg.jdbcUrl(), pg.username(), pg.password());
    }

    private void sendJson(HttpExchange exchange, int status, Object body) throws IOException {
        byte[] bytes = mapper.writeValueAsBytes(body);
        exchange.getResponseHeaders().set("Content-Type", "application/json");
        exchange.sendResponseHeaders(status, bytes.length);
        try (OutputStream os = exchange.getResponseBody()) { os.write(bytes); }
    }
}

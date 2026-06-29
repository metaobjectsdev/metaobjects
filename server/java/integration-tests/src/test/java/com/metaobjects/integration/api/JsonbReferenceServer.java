package com.metaobjects.integration.api;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.metaobjects.integration.PostgresContainer;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.sql.Types;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * #98 — hand-rolled reference server for the jsonb open-bag api-contract corpus
 * ({@code fixtures/api-contract-conformance/jsonb/}). Mirrors the cross-port
 * reference lane (TS {@code api-contract-jsonb-server.ts}, Python
 * {@code DocumentRepository} + {@code make_jsonb_app}).
 *
 * <p>Creates the {@code documents} table ({@code payload JSONB}) via raw JDBC
 * against Testcontainers Postgres, seeds it from the shared {@code seed.json}
 * (whose {@code payload} values are JSON <em>objects</em>), and exposes the
 * single-entity CRUD surface the scenarios exercise:</p>
 * <ul>
 *   <li>{@code GET /api/documents/{id}} — read a document; {@code payload} comes
 *       back as a PARSED JSON value, never a JSON-encoded string;</li>
 *   <li>{@code POST /api/documents} — create a document whose {@code payload} is
 *       a posted JSON object; returns 201 with the persisted row.</li>
 * </ul>
 *
 * <p>The open-bag contract under test: the {@code payload} field accepts a posted
 * JSON object/array and surfaces a parsed value on read (the API-boundary half of
 * #98 — the persistence/runtime half is gated by
 * {@code OpenJsonbWriteRoundtripTest} + the persistence-conformance corpus).</p>
 */
final class JsonbReferenceServer implements AutoCloseable {

    private final PostgresContainer pg;
    private final ObjectMapper mapper = new ObjectMapper();
    private final HttpServer httpServer;
    private final String baseUrl;

    JsonbReferenceServer(PostgresContainer pg, List<Map<String, Object>> seedRows) {
        this.pg = pg;
        try {
            createSchema();
            applySeed(seedRows);
            this.httpServer = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            httpServer.createContext("/api/documents", this::handle);
            httpServer.setExecutor(null);
            httpServer.start();
            this.baseUrl = "http://127.0.0.1:" + httpServer.getAddress().getPort();
        } catch (IOException | SQLException e) {
            throw new RuntimeException("could not start JsonbReferenceServer", e);
        }
    }

    String baseUrl() { return baseUrl; }

    @Override public void close() { httpServer.stop(0); }

    private void createSchema() throws SQLException {
        try (Connection c = connect(); Statement st = c.createStatement()) {
            st.execute("CREATE TABLE \"documents\" ("
                + "id BIGSERIAL PRIMARY KEY, "
                + "title VARCHAR(200) NOT NULL, "
                + "payload JSONB)");
        }
    }

    private void applySeed(List<Map<String, Object>> seedRows) throws SQLException {
        try (Connection c = connect()) {
            try (PreparedStatement ps = c.prepareStatement(
                "INSERT INTO \"documents\" (id, title, payload) VALUES (?, ?, ?)")) {
                for (Map<String, Object> r : seedRows) {
                    ps.setLong(1, ((Number) r.get("id")).longValue());
                    ps.setString(2, String.valueOf(r.get("title")));
                    bindJsonb(ps, 3, r.get("payload"));
                    ps.executeUpdate();
                }
            }
            // Advance the BIGSERIAL sequence past the seeded max(id) so the next
            // implicit-id POST lands at max(id)+1 (the create-201 contract).
            try (Statement st = c.createStatement()) {
                st.execute("SELECT setval(pg_get_serial_sequence('documents','id'), "
                    + "(SELECT COALESCE(MAX(id), 1) FROM documents))");
            }
        }
    }

    // -----------------------------------------------------------------------
    // HTTP handler — GET /api/documents/{id}, POST /api/documents
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
        String path = exchange.getRequestURI().getRawPath();   // /api/documents[/{id}]
        String rest = path.substring("/api/documents".length());

        if (method.equals("GET") && rest.startsWith("/")) {
            long id = Long.parseLong(rest.substring(1));
            Map<String, Object> row = findById(id);
            if (row == null) { sendJson(exchange, 404, Map.of("error", "not_found")); return; }
            sendJson(exchange, 200, row);
            return;
        }
        if (method.equals("POST") && (rest.isEmpty() || rest.equals("/"))) {
            Map<String, Object> body = readBody(exchange);
            Map<String, Object> created = create(
                String.valueOf(body.get("title")), body.get("payload"));
            sendJson(exchange, 201, created);
            return;
        }
        sendJson(exchange, 404, Map.of("error", "not_found"));
    }

    private Map<String, Object> findById(long id) throws SQLException {
        try (Connection c = connect();
             PreparedStatement ps = c.prepareStatement(
                 "SELECT id, title, payload FROM \"documents\" WHERE id = ?")) {
            ps.setLong(1, id);
            try (ResultSet rs = ps.executeQuery()) {
                return rs.next() ? rowFrom(rs) : null;
            }
        }
    }

    private Map<String, Object> create(String title, Object payload) throws SQLException {
        try (Connection c = connect();
             PreparedStatement ps = c.prepareStatement(
                 "INSERT INTO \"documents\" (title, payload) VALUES (?, ?) RETURNING id, title, payload")) {
            ps.setString(1, title);
            bindJsonb(ps, 2, payload);
            try (ResultSet rs = ps.executeQuery()) {
                rs.next();
                return rowFrom(rs);
            }
        }
    }

    /** Project a row, parsing the jsonb {@code payload} column to a JSON value (not a string). */
    private Map<String, Object> rowFrom(ResultSet rs) throws SQLException {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("id", rs.getLong("id"));
        row.put("title", rs.getString("title"));
        row.put("payload", parseJson(rs.getString("payload")));
        return row;
    }

    // -----------------------------------------------------------------------
    // helpers
    // -----------------------------------------------------------------------

    /** Bind a JSON value to a Postgres {@code jsonb} parameter (Types.OTHER + JSON text). */
    private void bindJsonb(PreparedStatement ps, int index, Object value) throws SQLException {
        if (value == null) { ps.setNull(index, Types.OTHER); return; }
        try {
            ps.setObject(index, mapper.writeValueAsString(value), Types.OTHER);
        } catch (IOException e) {
            throw new SQLException("could not serialize jsonb payload", e);
        }
    }

    private Object parseJson(String json) {
        if (json == null) return null;
        try {
            return mapper.readValue(json, Object.class);
        } catch (IOException e) {
            return json;
        }
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> readBody(HttpExchange exchange) throws IOException {
        byte[] bytes = exchange.getRequestBody().readAllBytes();
        if (bytes.length == 0) return Map.of();
        return mapper.readValue(new String(bytes, StandardCharsets.UTF_8), Map.class);
    }

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

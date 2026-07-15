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
import java.util.ArrayList;
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
                + "payload JSONB, "
                + "primary_marker JSONB NOT NULL, "   // required single VO (Program D)
                + "optional_marker JSONB, "           // nullable single VO
                + "markers JSONB)");                  // nullable array-of-VO
        }
    }

    private void applySeed(List<Map<String, Object>> seedRows) throws SQLException {
        try (Connection c = connect()) {
            try (PreparedStatement ps = c.prepareStatement(
                "INSERT INTO \"documents\" (id, title, payload, primary_marker, optional_marker, markers) "
                + "VALUES (?, ?, ?, ?, ?, ?)")) {
                for (Map<String, Object> r : seedRows) {
                    ps.setLong(1, ((Number) r.get("id")).longValue());
                    ps.setString(2, String.valueOf(r.get("title")));
                    bindJsonb(ps, 3, r.get("payload"));
                    bindJsonb(ps, 4, r.get("primaryMarker"));
                    bindJsonb(ps, 5, r.get("optionalMarker"));
                    bindJsonb(ps, 6, r.get("markers"));
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
            // Program D: nested value-object validation on CREATE (required primaryMarker present +
            // valid; a present optional/array VO valid) → 400 before persisting.
            if (!voValidForCreate(body)) { sendJson(exchange, 400, Map.of("error", "validation")); return; }
            sendJson(exchange, 201, create(body));
            return;
        }
        if ((method.equals("PATCH") || method.equals("PUT")) && rest.startsWith("/")) {
            long id = Long.parseLong(rest.substring(1));
            Map<String, Object> body = readBody(exchange);
            // FR-035 tristate + Program D nested VO validation: present-null on the @required
            // primaryMarker → 400; a present value must be a valid Marker (single or array) → 400.
            if (!voValidForPatch(body)) { sendJson(exchange, 400, Map.of("error", "validation")); return; }
            Map<String, Object> row = patch(id, body);
            if (row == null) { sendJson(exchange, 404, Map.of("error", "not_found")); return; }
            sendJson(exchange, 200, row);
            return;
        }
        sendJson(exchange, 404, Map.of("error", "not_found"));
    }

    private Map<String, Object> findById(long id) throws SQLException {
        try (Connection c = connect();
             PreparedStatement ps = c.prepareStatement(
                 "SELECT id, title, payload, primary_marker, optional_marker, markers "
                 + "FROM \"documents\" WHERE id = ?")) {
            ps.setLong(1, id);
            try (ResultSet rs = ps.executeQuery()) {
                return rs.next() ? rowFrom(rs) : null;
            }
        }
    }

    private Map<String, Object> create(Map<String, Object> body) throws SQLException {
        try (Connection c = connect();
             PreparedStatement ps = c.prepareStatement(
                 "INSERT INTO \"documents\" (title, payload, primary_marker, optional_marker, markers) "
                 + "VALUES (?, ?, ?, ?, ?) "
                 + "RETURNING id, title, payload, primary_marker, optional_marker, markers")) {
            ps.setString(1, String.valueOf(body.get("title")));
            bindJsonb(ps, 2, body.get("payload"));
            bindJsonb(ps, 3, body.get("primaryMarker"));
            bindJsonb(ps, 4, body.get("optionalMarker"));
            bindJsonb(ps, 5, body.get("markers"));
            try (ResultSet rs = ps.executeQuery()) {
                rs.next();
                return rowFrom(rs);
            }
        }
    }

    /**
     * FR-035 present-key PATCH: apply ONLY the columns present in the body (an absent key is
     * untouched; a present null clears a nullable VO column / is rejected upstream on a required
     * one; a present value / empty array is written). Returns {@code null} when the id is absent.
     */
    private Map<String, Object> patch(long id, Map<String, Object> body) throws SQLException {
        if (findById(id) == null) return null;   // 404
        List<String> setClauses = new ArrayList<>();
        List<Object> values = new ArrayList<>();
        List<Boolean> jsonb = new ArrayList<>();
        addAssignment(body, "title", "title", false, setClauses, values, jsonb);
        addAssignment(body, "payload", "payload", true, setClauses, values, jsonb);
        addAssignment(body, "primaryMarker", "primary_marker", true, setClauses, values, jsonb);
        addAssignment(body, "optionalMarker", "optional_marker", true, setClauses, values, jsonb);
        addAssignment(body, "markers", "markers", true, setClauses, values, jsonb);
        if (!setClauses.isEmpty()) {
            String sql = "UPDATE \"documents\" SET " + String.join(", ", setClauses) + " WHERE id = ?";
            try (Connection c = connect(); PreparedStatement ps = c.prepareStatement(sql)) {
                int idx = 1;
                for (int i = 0; i < values.size(); i++) {
                    if (jsonb.get(i)) bindJsonb(ps, idx++, values.get(i));
                    else ps.setString(idx++, values.get(i) == null ? null : String.valueOf(values.get(i)));
                }
                ps.setLong(idx, id);
                ps.executeUpdate();
            }
        }
        return findById(id);
    }

    /** Record a {@code column = ?} assignment iff {@code wireKey} is PRESENT in the body. */
    private static void addAssignment(Map<String, Object> body, String wireKey, String column,
            boolean isJsonb, List<String> setClauses, List<Object> values, List<Boolean> jsonb) {
        if (!body.containsKey(wireKey)) return;
        setClauses.add(column + " = ?");
        values.add(body.get(wireKey));
        jsonb.add(isJsonb);
    }

    /** Project a row, parsing each jsonb column to a JSON value (never a JSON-encoded string). */
    private Map<String, Object> rowFrom(ResultSet rs) throws SQLException {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("id", rs.getLong("id"));
        row.put("title", rs.getString("title"));
        row.put("payload", parseJson(rs.getString("payload")));
        row.put("primaryMarker", parseJson(rs.getString("primary_marker")));
        row.put("optionalMarker", parseJson(rs.getString("optional_marker")));
        row.put("markers", parseJson(rs.getString("markers")));
        return row;
    }

    // --- nested value-object validation (Program D — mirrors the cross-port contract) --------

    /**
     * The scalar {@code title} is {@code @required @maxLength 200}. A present title must be a
     * non-empty string within the cap (FR-036: non-empty, whitespace allowed); a present-null /
     * empty / over-length is a 400 — matching the generated {@code DocumentPatch}/DTO, so the
     * reference lane does not instead hit the NOT NULL column and 500. Absence is the caller's
     * concern (required on CREATE, untouched on PATCH).
     */
    private static boolean titlePresentValueValid(Map<String, Object> body) {
        if (!body.containsKey("title")) return true;
        Object t = body.get("title");
        return t instanceof String s && !s.isEmpty() && s.length() <= 200;
    }

    /** CREATE: title required + valid; primaryMarker required + valid; a present optional/array VO valid. */
    private static boolean voValidForCreate(Map<String, Object> body) {
        if (!body.containsKey("title") || !titlePresentValueValid(body)) return false;
        Object pm = body.get("primaryMarker");
        if (!body.containsKey("primaryMarker") || pm == null || !validMarker(pm)) return false;
        if (body.containsKey("optionalMarker")) {
            Object om = body.get("optionalMarker");
            if (om != null && !validMarker(om)) return false;
        }
        if (body.containsKey("markers")) {
            Object mk = body.get("markers");
            if (mk != null && !validMarkerArray(mk)) return false;
        }
        return true;
    }

    /** PATCH: a present title/VO value must be valid; present-null on a @required field → invalid. */
    private static boolean voValidForPatch(Map<String, Object> body) {
        if (!titlePresentValueValid(body)) return false;   // present-null/empty/over-length title → 400
        if (body.containsKey("primaryMarker")) {
            Object pm = body.get("primaryMarker");
            if (pm == null || !validMarker(pm)) return false;   // present-null on @required → 400
        }
        if (body.containsKey("optionalMarker")) {
            Object om = body.get("optionalMarker");
            if (om != null && !validMarker(om)) return false;
        }
        if (body.containsKey("markers")) {
            Object mk = body.get("markers");
            if (mk != null && !validMarkerArray(mk)) return false;
        }
        return true;
    }

    /** A Marker is valid iff {@code label} is a non-empty String &le; 40 chars (FR-036 Ruling 1:
     *  reject null / "", accept whitespace); {@code score} is unconstrained. */
    private static boolean validMarker(Object v) {
        if (!(v instanceof Map<?, ?> m)) return false;
        Object label = m.get("label");
        if (!(label instanceof String s)) return false;
        return s.length() >= 1 && s.length() <= 40;
    }

    private static boolean validMarkerArray(Object v) {
        if (!(v instanceof List<?> list)) return false;
        for (Object el : list) if (!validMarker(el)) return false;
        return true;
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

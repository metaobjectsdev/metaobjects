package com.metaobjects.integration.api;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.metaobjects.integration.PostgresContainer;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.io.OutputStream;
import java.io.UncheckedIOException;
import java.net.InetSocketAddress;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.sql.Timestamp;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * Minimal reference Java/JDBC HTTP server implementing the cross-port REST
 * API contract for the {@code Author} entity from the api-contract-conformance
 * corpus.
 *
 * <p>Why hand-rolled (vs the {@code SpringControllerGenerator} output): the
 * generator's output is a Spring {@code @RestController} requiring a Spring
 * Boot context — pulling all of Spring Boot in here for a 10-route contract
 * test is disproportionate. The handler logic and wire shape mirror the
 * generator output byte-for-byte; the corpus is the contract both must
 * satisfy. Mirrors the sibling Kotlin {@code AuthorApiServer.kt}.</p>
 *
 * <p>Schema is created via raw JDBC; seed/truncate also go through direct
 * JDBC because they include {@code RESTART IDENTITY}.</p>
 */
final class AuthorApiServer implements AutoCloseable {
    private static final DateTimeFormatter TIMESTAMP_FMT =
        DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss");
    // Mirrors the TS server's SORT_ALLOWLIST; cross-port contract.
    private static final Set<String> SORT_ALLOWLIST = Set.of("id", "name", "createdAt");

    private final PostgresContainer pg;
    private final ObjectMapper mapper = new ObjectMapper();
    private final HttpServer httpServer;
    private final String baseUrl;

    AuthorApiServer(PostgresContainer pg) {
        this.pg = pg;
        try {
            try (Connection c = connect(); Statement st = c.createStatement()) {
                st.execute("""
                    CREATE TABLE IF NOT EXISTS "authors" (
                        id BIGSERIAL PRIMARY KEY,
                        name VARCHAR(100) NOT NULL,
                        bio VARCHAR(1000),
                        "createdAt" TIMESTAMP NOT NULL
                    )""");
            }
            this.httpServer = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            httpServer.createContext("/api/authors", this::handle);
            httpServer.setExecutor(null);
            httpServer.start();
            this.baseUrl = "http://127.0.0.1:" + httpServer.getAddress().getPort();
        } catch (IOException | SQLException e) {
            throw new RuntimeException("could not start AuthorApiServer", e);
        }
    }

    String baseUrl() { return baseUrl; }

    @Override public void close() { httpServer.stop(0); }

    /** TRUNCATE + RESTART IDENTITY — used by the {@code list-empty} scenario. */
    void truncate() {
        try (Connection c = connect(); Statement st = c.createStatement()) {
            st.execute("TRUNCATE TABLE \"authors\" RESTART IDENTITY");
        } catch (SQLException e) { throw new RuntimeException(e); }
    }

    /**
     * Apply the seed file's {@code rows[]}. Inserts each row with an explicit
     * id, then bumps the bigserial sequence so the next implicit-id insert
     * lands at {@code max(id) + 1} — matters for {@code create-201} to land
     * at a deterministic id.
     */
    void applySeed(List<Map<String, Object>> rows) {
        truncate();
        try (Connection c = connect()) {
            try (PreparedStatement ps = c.prepareStatement(
                "INSERT INTO \"authors\" (id, name, bio, \"createdAt\") VALUES (?, ?, ?, ?)")) {
                for (Map<String, Object> r : rows) {
                    ps.setLong(1, ((Number) r.get("id")).longValue());
                    ps.setString(2, (String) r.get("name"));
                    ps.setString(3, (String) r.get("bio"));
                    ps.setTimestamp(4, Timestamp.valueOf(parseTimestamp((String) r.get("createdAt"))));
                    ps.executeUpdate();
                }
            }
            try (Statement st = c.createStatement()) {
                st.execute("SELECT setval(pg_get_serial_sequence('authors', 'id'), "
                    + "COALESCE((SELECT MAX(id) FROM authors), 1))");
            }
        } catch (SQLException e) { throw new RuntimeException(e); }
    }

    // -----------------------------------------------------------------------
    // HTTP handler
    // -----------------------------------------------------------------------

    private void handle(HttpExchange exchange) {
        try {
            doHandle(exchange);
        } catch (Exception e) {
            try {
                sendJson(exchange, 500, Map.of("error", "internal", "message", String.valueOf(e.getMessage())));
            } catch (IOException ignored) { /* nothing we can do */ }
        } finally {
            exchange.close();
        }
    }

    private void doHandle(HttpExchange exchange) throws IOException, SQLException {
        String method = exchange.getRequestMethod().toUpperCase(Locale.ROOT);
        String rawPath = exchange.getRequestURI().getRawPath();
        if (rawPath == null) rawPath = "";
        String rawQuery = exchange.getRequestURI().getRawQuery();
        if (rawQuery == null) rawQuery = "";
        Map<String, String> qs = parseQs(rawQuery);
        String trimmed = rawPath.startsWith("/api/authors")
            ? rawPath.substring("/api/authors".length())
            : rawPath;
        while (trimmed.startsWith("/")) trimmed = trimmed.substring(1);
        while (trimmed.endsWith("/")) trimmed = trimmed.substring(0, trimmed.length() - 1);
        String idSegment = trimmed.isEmpty() ? null : trimmed;

        if (method.equals("GET") && idSegment == null) { listAuthors(exchange, qs); return; }
        if (method.equals("GET") && idSegment != null) { getAuthor(exchange, idSegment); return; }
        if (method.equals("POST") && idSegment == null) { createAuthor(exchange); return; }
        if ((method.equals("PATCH") || method.equals("PUT")) && idSegment != null) {
            updateAuthor(exchange, idSegment); return;
        }
        if (method.equals("DELETE") && idSegment != null) { deleteAuthor(exchange, idSegment); return; }

        sendJson(exchange, 404, Map.of("error", "not_found"));
    }

    private void listAuthors(HttpExchange exchange, Map<String, String> qs) throws IOException, SQLException {
        // Parse + validate sort.
        String sortRaw = qs.get("sort");
        String sortField = "id";
        String sortDir = "ASC";
        if (sortRaw != null && !sortRaw.isEmpty()) {
            String[] parts = sortRaw.split(":", 2);
            String field = parts[0];
            if (!SORT_ALLOWLIST.contains(field)) {
                sendJson(exchange, 400, Map.of("error", "invalid_sort"));
                return;
            }
            String dir = parts.length > 1 ? parts[1].toLowerCase(Locale.ROOT) : "asc";
            if (!dir.equals("asc") && !dir.equals("desc")) {
                sendJson(exchange, 400, Map.of("error", "invalid_sort"));
                return;
            }
            sortField = field;
            sortDir = dir.toUpperCase(Locale.ROOT);
        }
        Integer limit = parseIntOrNull(qs.get("limit"));
        Long offset = parseLongOrNull(qs.get("offset"));
        if (offset == null) offset = 0L;
        boolean withCount = "1".equals(qs.get("withCount")) || "true".equals(qs.get("withCount"));

        StringBuilder sql = new StringBuilder("SELECT id, name, bio, \"createdAt\" FROM \"authors\"");
        sql.append(" ORDER BY \"").append(sortField).append("\" ").append(sortDir);
        if (limit != null) sql.append(" LIMIT ").append(limit);
        sql.append(" OFFSET ").append(offset);

        List<Map<String, Object>> rows = new ArrayList<>();
        try (Connection c = connect(); Statement st = c.createStatement(); ResultSet rs = st.executeQuery(sql.toString())) {
            while (rs.next()) rows.add(rowToMap(rs));
        }

        if (withCount) {
            long total;
            try (Connection c = connect(); Statement st = c.createStatement();
                 ResultSet rs = st.executeQuery("SELECT COUNT(*) FROM \"authors\"")) {
                rs.next();
                total = rs.getLong(1);
            }
            Map<String, Object> envelope = new LinkedHashMap<>();
            envelope.put("rows", rows);
            envelope.put("total", total);
            sendJson(exchange, 200, envelope);
        } else {
            sendJson(exchange, 200, rows);
        }
    }

    private void getAuthor(HttpExchange exchange, String idStr) throws IOException, SQLException {
        Long id = parseLongOrNull(idStr);
        if (id == null) { sendJson(exchange, 400, Map.of("error", "invalid_id")); return; }
        try (Connection c = connect();
             PreparedStatement ps = c.prepareStatement(
                 "SELECT id, name, bio, \"createdAt\" FROM \"authors\" WHERE id = ?")) {
            ps.setLong(1, id);
            try (ResultSet rs = ps.executeQuery()) {
                if (!rs.next()) { sendJson(exchange, 404, Map.of("error", "not_found")); return; }
                sendJson(exchange, 200, rowToMap(rs));
            }
        }
    }

    @SuppressWarnings("unchecked")
    private void createAuthor(HttpExchange exchange) throws IOException, SQLException {
        Object parsed = readJsonBody(exchange);
        if (!(parsed instanceof Map<?, ?>)) {
            sendJson(exchange, 400, Map.of("error", "validation"));
            return;
        }
        Map<String, Object> body = (Map<String, Object>) parsed;
        long newId;
        try (Connection c = connect();
             PreparedStatement ps = c.prepareStatement(
                 "INSERT INTO \"authors\" (name, bio, \"createdAt\") VALUES (?, ?, ?) RETURNING id")) {
            ps.setString(1, (String) body.get("name"));
            ps.setString(2, (String) body.get("bio"));
            ps.setTimestamp(3, Timestamp.valueOf(parseTimestamp((String) body.get("createdAt"))));
            try (ResultSet rs = ps.executeQuery()) {
                rs.next();
                newId = rs.getLong(1);
            }
        }
        Map<String, Object> row;
        try (Connection c = connect();
             PreparedStatement ps = c.prepareStatement(
                 "SELECT id, name, bio, \"createdAt\" FROM \"authors\" WHERE id = ?")) {
            ps.setLong(1, newId);
            try (ResultSet rs = ps.executeQuery()) { rs.next(); row = rowToMap(rs); }
        }
        sendJson(exchange, 201, row);
    }

    @SuppressWarnings("unchecked")
    private void updateAuthor(HttpExchange exchange, String idStr) throws IOException, SQLException {
        Long id = parseLongOrNull(idStr);
        if (id == null) { sendJson(exchange, 400, Map.of("error", "invalid_id")); return; }
        Object parsed = readJsonBody(exchange);
        if (!(parsed instanceof Map<?, ?>)) { sendJson(exchange, 400, Map.of("error", "validation")); return; }
        Map<String, Object> body = (Map<String, Object>) parsed;

        // Dynamic SET clause — only update fields present in the body.
        List<String> setClauses = new ArrayList<>();
        List<Object> values = new ArrayList<>();
        if (body.get("name") instanceof String n) { setClauses.add("name = ?"); values.add(n); }
        if (body.containsKey("bio")) { setClauses.add("bio = ?"); values.add(body.get("bio")); }
        if (body.get("createdAt") instanceof String cAt) {
            setClauses.add("\"createdAt\" = ?");
            values.add(Timestamp.valueOf(parseTimestamp(cAt)));
        }
        if (setClauses.isEmpty()) { sendJson(exchange, 400, Map.of("error", "validation")); return; }

        int updated;
        try (Connection c = connect();
             PreparedStatement ps = c.prepareStatement(
                 "UPDATE \"authors\" SET " + String.join(", ", setClauses) + " WHERE id = ?")) {
            for (int i = 0; i < values.size(); i++) {
                Object v = values.get(i);
                if (v == null) ps.setObject(i + 1, null);
                else ps.setObject(i + 1, v);
            }
            ps.setLong(values.size() + 1, id);
            updated = ps.executeUpdate();
        }
        if (updated == 0) { sendJson(exchange, 404, Map.of("error", "not_found")); return; }

        Map<String, Object> row;
        try (Connection c = connect();
             PreparedStatement ps = c.prepareStatement(
                 "SELECT id, name, bio, \"createdAt\" FROM \"authors\" WHERE id = ?")) {
            ps.setLong(1, id);
            try (ResultSet rs = ps.executeQuery()) { rs.next(); row = rowToMap(rs); }
        }
        sendJson(exchange, 200, row);
    }

    private void deleteAuthor(HttpExchange exchange, String idStr) throws IOException, SQLException {
        Long id = parseLongOrNull(idStr);
        if (id == null) { sendJson(exchange, 400, Map.of("error", "invalid_id")); return; }
        int deleted;
        try (Connection c = connect();
             PreparedStatement ps = c.prepareStatement("DELETE FROM \"authors\" WHERE id = ?")) {
            ps.setLong(1, id);
            deleted = ps.executeUpdate();
        }
        if (deleted == 0) sendJson(exchange, 404, Map.of("error", "not_found"));
        else sendNoContent(exchange);
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    private Connection connect() throws SQLException {
        return DriverManager.getConnection(pg.jdbcUrl(), pg.username(), pg.password());
    }

    private Map<String, Object> rowToMap(ResultSet rs) throws SQLException {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("id", rs.getLong("id"));
        row.put("name", rs.getString("name"));
        row.put("bio", rs.getString("bio"));
        Timestamp ts = rs.getTimestamp("createdAt");
        // Normalize to ISO-8601 without zone (matches the seed/wire format).
        row.put("createdAt", ts == null ? null : ts.toLocalDateTime().format(TIMESTAMP_FMT));
        return row;
    }

    private Object readJsonBody(HttpExchange exchange) throws IOException {
        byte[] bytes = exchange.getRequestBody().readAllBytes();
        if (bytes.length == 0) return null;
        return mapper.readValue(bytes, Object.class);
    }

    private void sendJson(HttpExchange exchange, int status, Object body) throws IOException {
        byte[] bytes = mapper.writeValueAsBytes(body);
        exchange.getResponseHeaders().set("Content-Type", "application/json");
        exchange.sendResponseHeaders(status, bytes.length);
        try (OutputStream os = exchange.getResponseBody()) { os.write(bytes); }
    }

    private void sendNoContent(HttpExchange exchange) throws IOException {
        exchange.sendResponseHeaders(204, -1);
        exchange.getResponseBody().close();
    }

    /** Crude application/x-www-form-urlencoded query-string parser (single value per key). */
    private static Map<String, String> parseQs(String raw) {
        if (raw.isEmpty()) return Map.of();
        Map<String, String> out = new LinkedHashMap<>();
        for (String pair : raw.split("&")) {
            if (pair.isEmpty()) continue;
            int eq = pair.indexOf('=');
            if (eq < 0) { out.put(pair, ""); continue; }
            String k = URLDecoder.decode(pair.substring(0, eq), StandardCharsets.UTF_8);
            String v = URLDecoder.decode(pair.substring(eq + 1), StandardCharsets.UTF_8);
            out.put(k, v);
        }
        return out;
    }

    private static LocalDateTime parseTimestamp(String s) {
        // The corpus uses `yyyy-MM-ddTHH:mm:ss` (no zone) for wall-clock times.
        return LocalDateTime.parse(s, TIMESTAMP_FMT);
    }

    private static Integer parseIntOrNull(String s) {
        if (s == null) return null;
        try { return Integer.parseInt(s); } catch (NumberFormatException e) { return null; }
    }

    private static Long parseLongOrNull(String s) {
        if (s == null) return null;
        try { return Long.parseLong(s); } catch (NumberFormatException e) { return null; }
    }
}

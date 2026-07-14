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
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
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
    // ADR-0036 Wave 2: createdAt is a bare field.timestamp → instant/tz-aware. The wire
    // form is an absolute instant (yyyy-MM-ddTHH:mm:ss[.fff]Z). Corpus seed/body strings
    // are offset-less wall-clock; an offset-less value is interpreted as UTC.
    private static final DateTimeFormatter INSTANT_FMT =
        DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss");
    // Mirrors the TS server's SORT_ALLOWLIST; cross-port contract.
    private static final Set<String> SORT_ALLOWLIST = Set.of("id", "name", "createdAt");

    // Cross-port FILTER_ALLOWLIST — mirrors the TS api-contract-server. Per
    // FR-009 §5 the operator set per field is gated by its subtype:
    //   string                     → eq, ne, in, like, isNull
    //   number / date / timestamp  → eq, ne, gt, gte, lt, lte, in, isNull
    //   boolean                    → eq, isNull
    private record FilterRule(String subType, Set<String> ops) {}
    private static final Map<String, FilterRule> FILTER_ALLOWLIST = Map.of(
        "id",        new FilterRule("number",   Set.of("eq", "ne", "gt", "gte", "lt", "lte", "in", "isNull")),
        "name",      new FilterRule("string",   Set.of("eq", "ne", "in", "like", "isNull")),
        "bio",       new FilterRule("string",   Set.of("eq", "ne", "in", "like", "isNull")),
        "createdAt", new FilterRule("datetime", Set.of("eq", "ne", "gt", "gte", "lt", "lte", "in", "isNull"))
    );

    /** A single parsed predicate: field, op, coerced value object. */
    private record FilterPredicate(String field, String op, Object value) {}

    /** Result of parsing filter params: either predicates or an error envelope key. */
    private record FilterResult(List<FilterPredicate> predicates, String error) {
        static FilterResult ok(List<FilterPredicate> ps) { return new FilterResult(ps, null); }
        static FilterResult err(String e) { return new FilterResult(List.of(), e); }
    }

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
                        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL
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
                    ps.setObject(4, parseInstant((String) r.get("createdAt")));
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

        // Parse filter[<field>][<op>]=<value> from the raw query string. Returns
        // an error envelope key (invalid_filter_field / invalid_filter_op /
        // invalid_filter_value) → 400, or a list of validated + coerced predicates.
        String rawQuery = exchange.getRequestURI().getRawQuery();
        FilterResult filter = parseFilter(rawQuery == null ? "" : rawQuery);
        if (filter.error() != null) {
            sendJson(exchange, 400, Map.of("error", filter.error()));
            return;
        }

        // Build WHERE clause from predicates. Parameters are bound positionally
        // via a PreparedStatement so SQL injection isn't a concern even though
        // the field/op tokens come from the URL — both are validated against
        // FILTER_ALLOWLIST before reaching here.
        List<Object> bindParams = new ArrayList<>();
        String whereClause = buildWhere(filter.predicates(), bindParams);

        StringBuilder sql = new StringBuilder("SELECT id, name, bio, \"createdAt\" FROM \"authors\"");
        sql.append(whereClause);
        sql.append(" ORDER BY \"").append(sortField).append("\" ").append(sortDir);
        if (limit != null) sql.append(" LIMIT ").append(limit);
        sql.append(" OFFSET ").append(offset);

        List<Map<String, Object>> rows = new ArrayList<>();
        try (Connection c = connect(); PreparedStatement ps = c.prepareStatement(sql.toString())) {
            bindAll(ps, bindParams);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) rows.add(rowToMap(rs));
            }
        }

        if (withCount) {
            long total;
            String countSql = "SELECT COUNT(*) FROM \"authors\"" + whereClause;
            try (Connection c = connect(); PreparedStatement ps = c.prepareStatement(countSql)) {
                bindAll(ps, bindParams);
                try (ResultSet rs = ps.executeQuery()) {
                    rs.next();
                    total = rs.getLong(1);
                }
            }
            Map<String, Object> envelope = new LinkedHashMap<>();
            envelope.put("rows", rows);
            envelope.put("total", total);
            sendJson(exchange, 200, envelope);
        } else {
            sendJson(exchange, 200, rows);
        }
    }

    /**
     * Parse the bracketed-qs filter grammar {@code filter[<field>][<op>]=<value>}
     * (and the {@code filter[<field>]=<value>} sugar form for {@code eq}) from a
     * raw URL query string. Validates each entry against {@link #FILTER_ALLOWLIST}
     * and coerces the value to the field's substrate type.
     *
     * <p>Returns {@code FilterResult.err(envelope)} on the first failure (unknown
     * field / disallowed op / invalid value coercion) so the controller can emit
     * the cross-port 400 envelope without partial-progress side-effects.</p>
     */
    private static FilterResult parseFilter(String rawQuery) {
        if (rawQuery.isEmpty()) return FilterResult.ok(List.of());
        List<FilterPredicate> out = new ArrayList<>();
        for (String pair : rawQuery.split("&")) {
            if (pair.isEmpty()) continue;
            int eq = pair.indexOf('=');
            String rawKey = eq < 0 ? pair : pair.substring(0, eq);
            String rawValue = eq < 0 ? "" : pair.substring(eq + 1);
            String key = URLDecoder.decode(rawKey, StandardCharsets.UTF_8);
            String value = URLDecoder.decode(rawValue, StandardCharsets.UTF_8);
            if (!key.startsWith("filter[")) continue;
            // Match filter[field] or filter[field][op]; bracket payload is opaque (no
            // nested brackets in the spec).
            int firstClose = key.indexOf(']', 7);
            if (firstClose < 0) continue;
            String field = key.substring(7, firstClose);
            String op;
            int rest = firstClose + 1;
            if (rest >= key.length()) {
                op = "eq";
            } else if (key.charAt(rest) == '[') {
                int secondClose = key.indexOf(']', rest + 1);
                if (secondClose < 0) continue;
                op = key.substring(rest + 1, secondClose);
            } else {
                continue;
            }
            FilterRule rule = FILTER_ALLOWLIST.get(field);
            if (rule == null) return FilterResult.err("invalid_filter_field");
            if (!rule.ops().contains(op)) return FilterResult.err("invalid_filter_op");
            Object coerced = coerceValue(value, rule.subType(), op);
            if (coerced == INVALID_VALUE) return FilterResult.err("invalid_filter_value");
            if (op.equals("in") && coerced instanceof List<?> inList && inList.size() > MAX_IN_LIST) {
                return FilterResult.err("filter.in_too_large");
            }
            out.add(new FilterPredicate(field, op, coerced));
        }
        return FilterResult.ok(out);
    }

    private static final Object INVALID_VALUE = new Object();

    /** Cross-port cap on `in`-list size (matches TS DEFAULT_MAX_IN_LIST). */
    private static final int MAX_IN_LIST = 100;

    /** Coerce a raw URL-decoded string into a JDBC-bindable value for {@code op}. */
    private static Object coerceValue(String raw, String subType, String op) {
        if (op.equals("isNull")) {
            if (raw.equals("true")) return Boolean.TRUE;
            if (raw.equals("false")) return Boolean.FALSE;
            return INVALID_VALUE;
        }
        if (op.equals("in")) {
            String[] parts = raw.split(",");
            List<Object> list = new ArrayList<>(parts.length);
            for (String p : parts) {
                Object v = coerceScalar(p.trim(), subType);
                if (v == INVALID_VALUE) return INVALID_VALUE;
                list.add(v);
            }
            return list;
        }
        return coerceScalar(raw, subType);
    }

    /** Coerce a single value (non-list, non-isNull) into a JDBC-bindable. */
    private static Object coerceScalar(String raw, String subType) {
        switch (subType) {
            case "string": return raw;
            case "datetime":
                try { return parseInstant(raw); }
                catch (Exception e) { return INVALID_VALUE; }
            case "boolean":
                if (raw.equals("true")) return Boolean.TRUE;
                if (raw.equals("false")) return Boolean.FALSE;
                return INVALID_VALUE;
            case "number":
                try { return Long.parseLong(raw); }
                catch (NumberFormatException e) { return INVALID_VALUE; }
            default: return INVALID_VALUE;
        }
    }

    /**
     * Append a {@code " WHERE ..."} clause built from {@code predicates} (or
     * an empty string when the list is empty), pushing each bind value onto
     * {@code bindParams} in positional order. Multiple predicates AND together.
     */
    private static String buildWhere(List<FilterPredicate> predicates, List<Object> bindParams) {
        if (predicates.isEmpty()) return "";
        StringBuilder sb = new StringBuilder(" WHERE ");
        boolean first = true;
        for (FilterPredicate p : predicates) {
            if (!first) sb.append(" AND ");
            first = false;
            String col = "\"" + p.field() + "\"";
            switch (p.op()) {
                case "eq"  -> { sb.append(col).append(" = ?");  bindParams.add(p.value()); }
                case "ne"  -> { sb.append(col).append(" <> ?"); bindParams.add(p.value()); }
                case "gt"  -> { sb.append(col).append(" > ?");  bindParams.add(p.value()); }
                case "gte" -> { sb.append(col).append(" >= ?"); bindParams.add(p.value()); }
                case "lt"  -> { sb.append(col).append(" < ?");  bindParams.add(p.value()); }
                case "lte" -> { sb.append(col).append(" <= ?"); bindParams.add(p.value()); }
                case "like" -> { sb.append(col).append(" LIKE ?"); bindParams.add(p.value()); }
                case "isNull" -> {
                    if (Boolean.TRUE.equals(p.value())) sb.append(col).append(" IS NULL");
                    else sb.append(col).append(" IS NOT NULL");
                }
                case "in" -> {
                    @SuppressWarnings("unchecked")
                    List<Object> items = (List<Object>) p.value();
                    sb.append(col).append(" IN (");
                    for (int i = 0; i < items.size(); i++) {
                        if (i > 0) sb.append(", ");
                        sb.append('?');
                        bindParams.add(items.get(i));
                    }
                    sb.append(')');
                }
                default -> throw new IllegalStateException("unknown filter op: " + p.op());
            }
        }
        return sb.toString();
    }

    /** Bind each value positionally; lets the JDBC driver pick the right type. */
    private static void bindAll(PreparedStatement ps, List<Object> values) throws SQLException {
        for (int i = 0; i < values.size(); i++) ps.setObject(i + 1, values.get(i));
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
        // FR-036 wire-tier constraint enforcement: reject an over-length name/bio with the
        // cross-port {"error":"validation"} envelope BEFORE persisting (mirrors the generated
        // controller's @Size(max=…) rules).
        if (violatesLength(body)) { sendJson(exchange, 400, Map.of("error", "validation")); return; }
        long newId;
        try (Connection c = connect();
             PreparedStatement ps = c.prepareStatement(
                 "INSERT INTO \"authors\" (name, bio, \"createdAt\") VALUES (?, ?, ?) RETURNING id")) {
            ps.setString(1, (String) body.get("name"));
            ps.setString(2, (String) body.get("bio"));
            ps.setObject(3, parseInstant((String) body.get("createdAt")));
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

        // FR-035 PATCH-2: an explicit null on a @required field (name / createdAt, per
        // meta.json) is a 400 — a present null on the nullable bio clears it, and an
        // omitted required field is untouched (never a 400).
        for (String reqField : List.of("name", "createdAt")) {
            if (body.containsKey(reqField) && body.get(reqField) == null) {
                sendJson(exchange, 400, Map.of("error", "validation"));
                return;
            }
        }

        // FR-036 wire-tier constraint enforcement: a PRESENT, non-null over-length name/bio is a
        // 400 (matches the generated controller's per-present-value PATCH validation).
        if (violatesLength(body)) { sendJson(exchange, 400, Map.of("error", "validation")); return; }

        // Dynamic SET clause — only update fields present in the body.
        List<String> setClauses = new ArrayList<>();
        List<Object> values = new ArrayList<>();
        if (body.get("name") instanceof String n) { setClauses.add("name = ?"); values.add(n); }
        if (body.containsKey("bio")) { setClauses.add("bio = ?"); values.add(body.get("bio")); }
        if (body.get("createdAt") instanceof String cAt) {
            setClauses.add("\"createdAt\" = ?");
            values.add(parseInstant(cAt));
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

    /**
     * FR-036 wire-tier length enforcement mirroring the generated controller's
     * {@code @Size(max=…)} rules (name {@code @maxLength} 100, bio {@code @maxLength} 1000).
     * Only a PRESENT, non-null value is checked: an absent field is untouched (PATCH), a
     * present null on the nullable bio clears it, and a present null on a {@code @required}
     * field is already rejected upstream. Returns {@code true} when a bound is exceeded so
     * the caller emits the {@code {"error":"validation"}} envelope.
     */
    private static boolean violatesLength(Map<String, Object> body) {
        if (body.get("name") instanceof String n && n.length() > 100) return true;
        if (body.get("bio") instanceof String b && b.length() > 1000) return true;
        return false;
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
        OffsetDateTime ts = rs.getObject("createdAt", OffsetDateTime.class);
        // Normalize to a UTC instant on the wire: yyyy-MM-ddTHH:mm:ssZ (instant contract).
        row.put("createdAt", ts == null ? null : formatInstant(ts.toInstant()));
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

    /**
     * Parse a corpus createdAt string into a UTC {@link OffsetDateTime} (JDBC-bindable
     * to {@code timestamp with time zone}). Corpus values are offset-less wall-clock
     * (yyyy-MM-ddTHH:mm:ss); per the instant wire contract an offset-less value is
     * interpreted as UTC, so we append {@code Z} when no zone is present.
     */
    private static OffsetDateTime parseInstant(String s) {
        if (s.endsWith("Z") || s.contains("+")) {
            return OffsetDateTime.parse(s).withOffsetSameInstant(ZoneOffset.UTC);
        }
        return OffsetDateTime.parse(s + "Z");
    }

    /** Format an instant as the UTC wire form yyyy-MM-ddTHH:mm:ssZ. */
    private static String formatInstant(Instant instant) {
        return INSTANT_FMT.format(instant.atOffset(ZoneOffset.UTC)) + "Z";
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

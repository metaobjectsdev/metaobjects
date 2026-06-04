package com.metaobjects.integration;

import com.metaobjects.integration.Scenarios.QueryScenario;
import com.metaobjects.integration.Scenarios.QuerySpec;
import com.metaobjects.integration.Scenarios.SortSpec;
import org.yaml.snakeyaml.Yaml;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;

/**
 * Parse scenario YAML into typed records. Hyphenated YAML keys lower to
 * camelCase Java fields by hand because SnakeYAML doesn't impose a naming
 * convention on a raw {@code Map<String, Object>} load.
 */
public final class ScenarioLoader {
    private ScenarioLoader() {}

    private static final Yaml YAML = new Yaml();

    /** Canonical Postgres schema artifact, relative to the corpus root. */
    private static final String CANONICAL_SCHEMA_RELATIVE = "canonical/schema.postgres.sql";

    public static List<QueryScenario> loadQueries(Path dir) {
        return loadAll(dir, ScenarioLoader::parseQuery);
    }

    private static <T> List<T> loadAll(Path dir, java.util.function.BiFunction<Path, Map<String, Object>, T> parse) {
        try (Stream<Path> paths = Files.list(dir)) {
            return paths
                .filter(p -> p.getFileName().toString().endsWith(".yaml"))
                .sorted(Comparator.comparing(Path::toString))
                .map(p -> parse.apply(p, parseYaml(p)))
                .toList();
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    private static Map<String, Object> parseYaml(Path file) {
        try {
            String text = Files.readString(file, StandardCharsets.UTF_8);
            Object parsed = YAML.load(text);
            if (!(parsed instanceof Map<?, ?> raw)) {
                throw new IllegalStateException(file + ": top-level YAML must be a mapping");
            }
            @SuppressWarnings("unchecked")
            Map<String, Object> typed = (Map<String, Object>) raw;
            return typed;
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    // -----------------------------------------------------------------------
    // Query parsing
    // -----------------------------------------------------------------------

    @SuppressWarnings("unchecked")
    private static QueryScenario parseQuery(Path file, Map<String, Object> root) {
        List<Map<String, Object>> qsRaw = (List<Map<String, Object>>) root.getOrDefault("queries", List.of());
        List<QuerySpec> queries = new ArrayList<>(qsRaw.size());
        for (Map<String, Object> q : qsRaw) queries.add(parseQuerySpec(q));
        return new QueryScenario(
            requireString(file, root, "name"),
            stringOrDefault(root, "description", ""),
            file.toString(),
            (String) root.get("seed-data"),
            Collections.unmodifiableList(queries));
    }

    @SuppressWarnings("unchecked")
    private static QuerySpec parseQuerySpec(Map<String, Object> q) {
        List<Map<String, Object>> sortsRaw = (List<Map<String, Object>>) q.get("sort");
        List<SortSpec> sorts = sortsRaw == null ? null : sortsRaw.stream()
            .map(s -> new SortSpec((String) s.get("field"), (String) s.getOrDefault("dir", "asc")))
            .toList();
        return new QuerySpec(
            (String) q.get("name"),
            (String) q.get("op"),
            (String) q.get("entity"),
            (Map<String, Object>) q.get("by"),
            (Map<String, Object>) q.get("filter"),
            sorts,
            asInt(q.get("limit")),
            asInt(q.get("offset")),
            (String) q.get("relation"),
            (Map<String, Object>) q.get("insert"),
            (Map<String, Object>) q.get("data"),
            q.get("expect"));
    }

    private static Integer asInt(Object v) {
        if (v == null) return null;
        if (v instanceof Integer i) return i;
        if (v instanceof Number n) return n.intValue();
        return Integer.parseInt(v.toString());
    }

    // -----------------------------------------------------------------------
    // Path / string helpers
    // -----------------------------------------------------------------------

    private static String requireString(Path file, Map<String, Object> map, String key) {
        Object v = map.get(key);
        if (!(v instanceof String s) || s.isEmpty())
            throw new IllegalStateException(file + ": missing required key '" + key + "'");
        return s;
    }

    private static String stringOrDefault(Map<String, Object> map, String key, String fallback) {
        Object v = map.get(key);
        return v instanceof String s ? s : fallback;
    }

    /** Walk up from a known anchor file to find the corpus root, regardless of cwd. */
    public static Path findCorpusRoot() {
        Path cur = Paths.get("").toAbsolutePath();
        while (cur != null) {
            Path candidate = cur.resolve("fixtures/persistence-conformance");
            if (Files.isDirectory(candidate)) return candidate;
            cur = cur.getParent();
        }
        throw new IllegalStateException(
            "Could not locate fixtures/persistence-conformance from " + Paths.get("").toAbsolutePath());
    }

    /**
     * Read the committed canonical Postgres schema DDL (base tables + projection
     * views), executed verbatim by the query runner to provision its test DB.
     * Schema authority is the TS-produced artifact (ADR-0015); the Java port no
     * longer derives the conformance schema from metadata at test time.
     */
    public static String readCanonicalSchema(Path corpusRoot) {
        Path schema = corpusRoot.resolve(CANONICAL_SCHEMA_RELATIVE);
        if (!Files.isRegularFile(schema)) {
            throw new IllegalStateException("Canonical schema not found: " + schema);
        }
        try {
            return Files.readString(schema, StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }
}

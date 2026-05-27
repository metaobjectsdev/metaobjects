package com.metaobjects.integration.api;

import com.metaobjects.integration.api.ApiContractScenarios.ApiRequest;
import com.metaobjects.integration.api.ApiContractScenarios.ApiScenario;
import org.yaml.snakeyaml.Yaml;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;

/**
 * Parse scenario YAML files ({@code <corpus>/scenarios/<name>.yaml}) into
 * typed records. Mirrors {@code ApiContractScenarioLoader.kt} in
 * {@code integration-tests-kotlin}.
 */
final class ApiContractScenarioLoader {
    private ApiContractScenarioLoader() {}

    private static final Yaml YAML = new Yaml();

    static List<ApiScenario> loadScenarios(Path dir) {
        try (Stream<Path> paths = Files.list(dir)) {
            return paths
                .filter(p -> p.getFileName().toString().endsWith(".yaml"))
                .sorted(Comparator.comparing(Path::toString))
                .map(p -> parseScenario(p, parseYamlMap(p)))
                .toList();
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    /** Walk up from cwd to find {@code fixtures/api-contract-conformance}. */
    static Path findCorpusRoot() {
        Path cur = Paths.get("").toAbsolutePath();
        while (cur != null) {
            Path candidate = cur.resolve("fixtures/api-contract-conformance");
            if (Files.isDirectory(candidate)) return candidate;
            cur = cur.getParent();
        }
        throw new IllegalStateException(
            "Could not locate fixtures/api-contract-conformance from "
                + Paths.get("").toAbsolutePath());
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> parseYamlMap(Path file) {
        try {
            String text = Files.readString(file, StandardCharsets.UTF_8);
            Object parsed = YAML.load(text);
            if (!(parsed instanceof Map<?, ?> raw))
                throw new IllegalStateException(file + ": top-level YAML must be a mapping");
            return (Map<String, Object>) raw;
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    @SuppressWarnings("unchecked")
    private static ApiScenario parseScenario(Path file, Map<String, Object> root) {
        List<Map<String, Object>> rawRequests =
            (List<Map<String, Object>>) root.getOrDefault("requests", List.of());
        Map<String, Object> setup = (Map<String, Object>) root.get("setup");
        boolean truncate = setup != null && Boolean.TRUE.equals(setup.get("truncate"));

        List<ApiRequest> requests = new ArrayList<>(rawRequests.size());
        for (Map<String, Object> r : rawRequests) requests.add(parseRequest(r));

        return new ApiScenario(
            asString(root.get("name"), file.getFileName().toString()),
            asString(root.get("description"), ""),
            file.toString(),
            truncate,
            requests);
    }

    @SuppressWarnings("unchecked")
    private static ApiRequest parseRequest(Map<String, Object> r) {
        Map<String, Object> expect = (Map<String, Object>) r.get("expect");
        if (expect == null) throw new IllegalStateException("request '" + r.get("id") + "': missing 'expect' block");
        Object statusObj = expect.get("status");
        if (!(statusObj instanceof Number n))
            throw new IllegalStateException("request '" + r.get("id") + "': 'expect.status' must be a number");
        Map<String, Object> expectBody = (Map<String, Object>) expect.get("body");

        String method = (String) r.get("method");
        String path = (String) r.get("path");
        if (method == null) throw new IllegalStateException("request: missing method");
        if (path == null) throw new IllegalStateException("request: missing path");

        return new ApiRequest(
            asString(r.get("id"), "?"),
            method.toUpperCase(),
            path,
            r.get("body"),
            n.intValue(),
            expectBody);
    }

    private static String asString(Object v, String fallback) {
        return v == null ? fallback : v.toString();
    }
}

package com.metaobjects.integration.api.m2m;

import org.yaml.snakeyaml.Yaml;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;

/**
 * FR-018 — typed model + loader + assertion engine for the shared M:N
 * api-contract corpus ({@code fixtures/api-contract-conformance/m2m/}).
 *
 * <p>The single-entity api-contract corpus (the {@code Author} scenarios) uses a
 * {@code rows[]} seed shape and the {@code equals/ids/names/...} assertion
 * vocabulary; the M:N corpus differs in two ways that warrant a small dedicated
 * harness rather than overloading the {@code ApiContract*} types:</p>
 * <ul>
 *   <li>its {@code seed.json} is keyed by physical table name (six tables), not a
 *       single {@code rows[]} array;</li>
 *   <li>it adds one assertion key — {@code namesUnordered}: the response is an
 *       array whose {@code name} multiset is compared order-insensitively (related-row
 *       order through a junction is not contractual).</li>
 * </ul>
 *
 * <p>Mirror of {@code M2mScenarios.kt} in {@code integration-tests-kotlin}.</p>
 */
final class M2mScenarios {
    private M2mScenarios() {}

    private static final Yaml YAML = new Yaml();

    /** A single HTTP request inside an M:N scenario. */
    record M2mRequest(
        String id,
        String method,                 // GET (M:N traversal is read-only)
        String path,                   // e.g. /api/posts/1/tags
        int expectStatus,
        Map<String, Object> expectBody // nullable
    ) {}

    /** One scenario file (one {@code .yaml} under {@code m2m/scenarios/}). */
    record M2mScenario(
        String name,
        String description,
        List<M2mRequest> requests
    ) {}

    static List<M2mScenario> loadScenarios(Path dir) {
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

    /** Walk up from cwd to find {@code fixtures/api-contract-conformance/m2m}. */
    static Path findM2mCorpus() {
        Path cur = Path.of("").toAbsolutePath();
        while (cur != null) {
            Path candidate = cur.resolve("fixtures/api-contract-conformance/m2m");
            if (Files.isDirectory(candidate)) return candidate;
            cur = cur.getParent();
        }
        throw new IllegalStateException(
            "Could not locate fixtures/api-contract-conformance/m2m from " + Path.of("").toAbsolutePath());
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> parseYamlMap(Path file) {
        try {
            Object parsed = YAML.load(Files.readString(file, StandardCharsets.UTF_8));
            if (!(parsed instanceof Map<?, ?> raw))
                throw new IllegalStateException(file + ": top-level YAML must be a mapping");
            return (Map<String, Object>) raw;
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    @SuppressWarnings("unchecked")
    private static M2mScenario parseScenario(Path file, Map<String, Object> root) {
        List<Map<String, Object>> rawRequests =
            (List<Map<String, Object>>) root.getOrDefault("requests", List.of());
        List<M2mRequest> requests = new ArrayList<>(rawRequests.size());
        for (Map<String, Object> r : rawRequests) requests.add(parseRequest(r));
        return new M2mScenario(
            asString(root.get("name"), file.getFileName().toString()),
            asString(root.get("description"), ""),
            requests);
    }

    @SuppressWarnings("unchecked")
    private static M2mRequest parseRequest(Map<String, Object> r) {
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
        return new M2mRequest(asString(r.get("id"), "?"), method.toUpperCase(), path, n.intValue(), expectBody);
    }

    /**
     * Assert an M:N traversal response against the corpus {@code expect.body}
     * vocabulary: {@code namesUnordered} (order-insensitive {@code name} multiset)
     * and {@code length} (array size, used for the empty/orphan case).
     */
    static void assertResponse(String scenarioName, M2mRequest request, int status, Object body) {
        if (status != request.expectStatus()) {
            throw new AssertionError(scenarioName + " / " + request.id() + ": expected status "
                + request.expectStatus() + ", got " + status + "; body: " + body);
        }
        Map<String, Object> want = request.expectBody();
        if (want == null) return;

        Object lenObj = want.get("length");
        if (lenObj instanceof Number wantLen) {
            if (!(body instanceof List<?> list))
                throw new AssertionError(scenarioName + " / " + request.id() + ": expected array, got: " + body);
            if (list.size() != wantLen.intValue())
                throw new AssertionError(scenarioName + " / " + request.id()
                    + ": expected length=" + wantLen.intValue() + ", got " + list.size());
        }

        Object namesObj = want.get("namesUnordered");
        if (namesObj instanceof List<?> wantNames) {
            if (!(body instanceof List<?> list))
                throw new AssertionError(scenarioName + " / " + request.id() + ": expected array, got: " + body);
            List<String> actual = new ArrayList<>(list.size());
            for (Object it : list) {
                if (it instanceof Map<?, ?> m && m.get("name") != null) actual.add(String.valueOf(m.get("name")));
                else actual.add(null);
            }
            List<String> wantSorted = new ArrayList<>(wantNames.size());
            for (Object it : wantNames) wantSorted.add(it == null ? null : String.valueOf(it));
            actual.sort(Comparator.nullsFirst(Comparator.naturalOrder()));
            wantSorted.sort(Comparator.nullsFirst(Comparator.naturalOrder()));
            if (!actual.equals(wantSorted))
                throw new AssertionError(scenarioName + " / " + request.id()
                    + ": expected names (unordered) " + wantSorted + ", got " + actual);
        }
    }

    private static String asString(Object v, String fallback) {
        return v == null ? fallback : v.toString();
    }
}

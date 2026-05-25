package com.metaobjects.render;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.junit.runners.Parameterized;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;
import java.util.stream.Stream;

/**
 * Cross-port render-conformance REPORT — compares Java's actual render output
 * against the TS-baseline expected text. <strong>Not a gate</strong> — diffs
 * are printed to stdout but tests do not fail. Track documented drifts in
 * {@code server/java/render/KNOWN_DRIFT.md}.
 *
 * <p>Within-Java stability is the real build gate; see {@link RenderSnapshotTest}.
 */
@RunWith(Parameterized.class)
public class RenderCrossPortReportTest {

    private static final Path REPO_ROOT;
    private static final Path FIXTURES_DIR;
    private static final ObjectMapper JSON = new ObjectMapper();

    static {
        Path p = Paths.get(System.getProperty("user.dir")).toAbsolutePath();
        while (p != null && !Files.exists(p.resolve("fixtures/render-conformance"))) {
            p = p.getParent();
        }
        REPO_ROOT = p;
        FIXTURES_DIR = REPO_ROOT == null ? null : REPO_ROOT.resolve("fixtures/render-conformance");
    }

    @Parameterized.Parameters(name = "{0}")
    public static List<Object[]> fixtures() throws IOException {
        if (FIXTURES_DIR == null || !Files.isDirectory(FIXTURES_DIR)) return List.of();
        try (Stream<Path> s = Files.list(FIXTURES_DIR)) {
            return s.filter(Files::isDirectory)
                .filter(d -> Files.isRegularFile(d.resolve("expected.txt"))
                          || Files.isRegularFile(d.resolve("expected/rendered.txt")))
                .sorted()
                .map(p -> new Object[]{p.getFileName().toString(), p})
                .collect(Collectors.toList());
        }
    }

    private final String name;
    private final Path fixtureDir;

    public RenderCrossPortReportTest(String name, Path fixtureDir) {
        this.name = name;
        this.fixtureDir = fixtureDir;
    }

    @Test
    @SuppressWarnings("unchecked")
    public void compareAgainstTsBaseline() throws IOException {
        Path templatePath = fixtureDir.resolve("template.mustache");
        Path payloadPath = fixtureDir.resolve("payload.json");
        Path expectedPath = Files.isRegularFile(fixtureDir.resolve("expected.txt"))
            ? fixtureDir.resolve("expected.txt")
            : fixtureDir.resolve("expected/rendered.txt");
        Path metaPath = fixtureDir.resolve("meta.json");

        if (!Files.isRegularFile(templatePath) || !Files.isRegularFile(payloadPath)) return;

        Map<String, Object> meta = Files.isRegularFile(metaPath)
            ? (Map<String, Object>) JSON.readValue(metaPath.toFile(), Map.class)
            : Map.of();
        String format = (String) meta.getOrDefault("format", "text");
        String template = Files.readString(templatePath, StandardCharsets.UTF_8);
        Object payload = JSON.readValue(payloadPath.toFile(), Object.class);
        Provider provider = Files.isDirectory(fixtureDir.resolve("partials"))
            ? new FilesystemProvider(fixtureDir)
            : new InMemoryProvider(Map.of());

        String actual = new Renderer().render(new RenderRequest(
            template, null, payload, provider, format, null, null));
        String expected = Files.readString(expectedPath, StandardCharsets.UTF_8);

        if (!expected.equals(actual)) {
            System.out.println("=== CROSS-PORT DRIFT: " + name + " ===");
            System.out.println("--- expected (TS baseline) ---");
            System.out.println(expected);
            System.out.println("--- actual (Java) ---");
            System.out.println(actual);
            System.out.println("===");
        }
        // No assertion — this is a report, not a gate.
    }
}

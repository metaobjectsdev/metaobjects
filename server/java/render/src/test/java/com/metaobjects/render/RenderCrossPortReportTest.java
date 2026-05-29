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
import java.util.Set;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;

/**
 * Cross-port render-conformance GATE — asserts Java's render output is
 * byte-identical to the shared TS-baseline expected text in
 * {@code fixtures/render-conformance/}.
 *
 * <p>The one intentional Java divergence (a Mustache.java standalone-comment
 * whitespace quirk) is ledgered in {@link #KNOWN_DRIFT} and documented in
 * {@code server/java/render/KNOWN_DRIFT.md}. Ledgered fixtures are asserted to
 * <em>still</em> drift, so the moment the divergence is resolved this test fails
 * and prompts removing the stale entry. Every non-ledgered fixture is a hard
 * byte-equality gate — new cross-port drift fails the build.
 *
 * <p>{@link RenderSnapshotTest} additionally guards within-Java stability.
 */
@RunWith(Parameterized.class)
public class RenderCrossPortReportTest {

    private static final Path REPO_ROOT;
    private static final Path FIXTURES_DIR;
    private static final ObjectMapper JSON = new ObjectMapper();

    /**
     * Fixtures where Java intentionally diverges from the shared TS baseline.
     * See {@code server/java/render/KNOWN_DRIFT.md}. These are asserted to STILL
     * differ; if Java comes into agreement, remove the entry (the test will fail
     * to remind you).
     */
    private static final Set<String> KNOWN_DRIFT = Set.of(
        // Mustache.java leaves the trailing newline after a standalone {{! comment }};
        // TS / C# / Python all strip it.
        "render-standalone-tag-stripping"
    );

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

        if (KNOWN_DRIFT.contains(name)) {
            // Documented intentional divergence: assert it STILL drifts, so a
            // future fix that brings Java into agreement fails here and prompts
            // removing the stale KNOWN_DRIFT entry (and this guard).
            assertNotEquals(
                "Fixture '" + name + "' is in KNOWN_DRIFT but now matches the shared "
                + "baseline — remove it from KNOWN_DRIFT and server/java/render/KNOWN_DRIFT.md.",
                expected, actual);
            return;
        }
        assertEquals(
            "Cross-port render drift on fixture '" + name + "' vs the shared "
            + "fixtures/render-conformance baseline. Fix the Renderer/Escapers, or "
            + "(if intentional) document it in KNOWN_DRIFT.md and add to KNOWN_DRIFT.",
            expected, actual);
    }
}

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

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/**
 * Within-Java render snapshot gate — parameterized over every fixture under
 * {@code fixtures/render-conformance/} at the repo root. First run for a new
 * fixture creates the snapshot and fails with a "snapshot created" message;
 * subsequent runs assert the rendered output is byte-identical.
 *
 * <p>This is the build gate for "Java render output is stable" — see
 * {@link RenderCrossPortReportTest} for the cross-port (report-only) comparison.
 */
@RunWith(Parameterized.class)
public class RenderSnapshotTest {

    private static final Path REPO_ROOT;
    private static final Path FIXTURES_DIR;
    private static final Path SNAPSHOTS_DIR;
    private static final ObjectMapper JSON = new ObjectMapper();

    static {
        // Walk up from CWD to find the repo root containing fixtures/render-conformance.
        Path p = Paths.get(System.getProperty("user.dir")).toAbsolutePath();
        while (p != null && !Files.exists(p.resolve("fixtures/render-conformance"))) {
            p = p.getParent();
        }
        REPO_ROOT = p;
        FIXTURES_DIR = REPO_ROOT == null ? null : REPO_ROOT.resolve("fixtures/render-conformance");
        SNAPSHOTS_DIR = Paths.get("src/test/resources/snapshots").toAbsolutePath();
    }

    @Parameterized.Parameters(name = "{0}")
    public static List<Object[]> fixtures() throws IOException {
        if (FIXTURES_DIR == null || !Files.isDirectory(FIXTURES_DIR)) return List.of();
        try (Stream<Path> s = Files.list(FIXTURES_DIR)) {
            return s.filter(Files::isDirectory)
                    .sorted()
                    .map(p -> new Object[]{p.getFileName().toString(), p})
                    .collect(Collectors.toList());
        }
    }

    private final String name;
    private final Path fixtureDir;

    public RenderSnapshotTest(String name, Path fixtureDir) {
        this.name = name;
        this.fixtureDir = fixtureDir;
    }

    @Test
    @SuppressWarnings("unchecked")
    public void rendersToSnapshot() throws IOException {
        Path metaPath = fixtureDir.resolve("meta.json");
        Path templatePath = fixtureDir.resolve("template.mustache");
        Path payloadPath = fixtureDir.resolve("payload.json");
        Path snapshotPath = SNAPSHOTS_DIR.resolve(name + ".txt");
        Path partialsDir = fixtureDir.resolve("partials");

        assertTrue("missing template: " + templatePath, Files.isRegularFile(templatePath));
        assertTrue("missing payload: " + payloadPath, Files.isRegularFile(payloadPath));

        Map<String, Object> meta = Files.isRegularFile(metaPath)
            ? (Map<String, Object>) JSON.readValue(metaPath.toFile(), Map.class)
            : Map.of();
        String format = (String) meta.getOrDefault("format", "text");

        String template = Files.readString(templatePath, StandardCharsets.UTF_8);
        Object payload = JSON.readValue(payloadPath.toFile(), Object.class);

        // Partial references like "partials/tone" resolve to <fixtureDir>/partials/tone.mustache.
        Provider provider = Files.isDirectory(partialsDir)
            ? new FilesystemProvider(fixtureDir)
            : new InMemoryProvider(Map.of());

        String actual = new Renderer().render(new RenderRequest(
            template, null, payload, provider, format, null, null));

        if (!Files.isRegularFile(snapshotPath)) {
            Files.createDirectories(snapshotPath.getParent());
            Files.writeString(snapshotPath, actual, StandardCharsets.UTF_8);
            fail("snapshot created for '" + name + "' at " + snapshotPath
                + " — review + commit. Re-run to gate.");
        }
        String expected = Files.readString(snapshotPath, StandardCharsets.UTF_8);
        assertEquals("render output drifted from snapshot for " + name, expected, actual);
    }
}

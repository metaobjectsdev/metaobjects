package com.metaobjects.mojo;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.metaobjects.loader.MetaDataLoader;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.junit.runners.Parameterized;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.List;
import java.util.stream.Stream;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

/**
 * Cross-port field-lint conformance corpus — {@code fixtures/field-lint-conformance/}. See
 * that directory's README.md for the fixture format. Every case is LOADED first, so "this
 * loads with no error today" is proven by the fixture, and only then linted. Mirrors the
 * TypeScript reference ({@code field-lint-conformance.test.ts}) and the C#/Python ports
 * exactly; a mismatch here is a bug in THIS port's lint, never in the fixture.
 */
@RunWith(Parameterized.class)
public class FieldLintConformanceTest {

    private static final Path CORPUS = locateCorpus();

    private static Path locateCorpus() {
        Path dir = Paths.get("").toAbsolutePath();
        while (dir != null) {
            Path candidate = dir.resolve("fixtures/field-lint-conformance");
            if (Files.isDirectory(candidate)) return candidate;
            dir = dir.getParent();
        }
        throw new AssertionError("Could not locate fixtures/field-lint-conformance/ by walking up from "
            + Paths.get("").toAbsolutePath());
    }

    @Parameterized.Parameters(name = "{0}")
    public static Collection<Object[]> fixtures() throws IOException {
        List<Object[]> params = new ArrayList<>();
        try (Stream<Path> dirs = Files.list(CORPUS)) {
            List<Path> sorted = dirs.filter(Files::isDirectory).sorted(Comparator.comparing(Path::toString)).toList();
            for (Path d : sorted) params.add(new Object[]{d.getFileName().toString(), d});
        }
        return params;
    }

    private final String name;
    private final Path dir;

    public FieldLintConformanceTest(String name, Path dir) {
        this.name = name;
        this.dir = dir;
    }

    @Test
    public void fixture() throws IOException {
        Path input = dir.resolve("input");
        MetaDataLoader loader = MetaDataLoader.fromDirectory("field-lint-" + name, input);
        assertTrue(name + ": expected a clean load, got: " + loader.getErrors(), loader.getErrors().isEmpty());

        List<Path> files;
        try (Stream<Path> listed = Files.list(input)) {
            files = listed.sorted(Comparator.comparing(Path::toString)).toList();
        }
        List<String> actual = new ArrayList<>();
        for (FieldLint.Finding f : FieldLint.lintReferenceFields(loader)) actual.add(row(f.code(), f.path(), f.message()));
        for (FieldLint.Finding f : FieldLint.lintDuplicateFields(files)) actual.add(row(f.code(), f.path(), f.message()));

        List<String> expected = new ArrayList<>();
        JsonObject doc = JsonParser.parseString(Files.readString(dir.resolve("expected.json"), StandardCharsets.UTF_8)).getAsJsonObject();
        for (JsonElement e : doc.getAsJsonArray("findings")) {
            JsonObject f = e.getAsJsonObject();
            expected.add(row(f.get("code").getAsString(), f.get("path").getAsString(), f.get("message").getAsString()));
        }

        assertEquals(name, expected.stream().sorted().toList(), actual.stream().sorted().toList());
    }

    private static String row(String code, String path, String message) {
        return code + " [" + path + "]: " + message;
    }
}

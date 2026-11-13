package com.metaobjects.loader;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.metaobjects.MetaDataException;
import com.metaobjects.registry.ObjectClassRegistry;
import com.metaobjects.source.JsonSource;
import org.junit.After;
import org.junit.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;
import java.util.stream.Stream;

import static org.junit.Assert.assertEquals;

/**
 * {@code validator.atLeastOne} takes no {@code @max}. The shared fixture
 * {@code error-validator-at-least-one-max-unknown} runs under the strict loader, where the
 * attribute is unregistered; this runs the same input through the default (non-strict) loader
 * too, which would otherwise keep {@code @max} and ignore it. Oracle: that fixture's
 * {@code expected-errors.json}, exactly one {@code ERR_UNKNOWN_ATTR} at the validator, under
 * either loader.
 */
public class AtLeastOneMaxDefaultLoadTest {

    @After
    public void reset() {
        ObjectClassRegistry.resetGlobal();
    }

    private static Path fixture() {
        Path dir = Paths.get("").toAbsolutePath();
        while (dir != null) {
            Path candidate = dir.resolve("fixtures/conformance/error-validator-at-least-one-max-unknown");
            if (Files.isDirectory(candidate)) return candidate;
            dir = dir.getParent();
        }
        throw new AssertionError("fixtures/conformance/error-validator-at-least-one-max-unknown not found");
    }

    private static List<String> expected(Path fixture) throws IOException {
        JsonObject doc = JsonParser.parseString(
            Files.readString(fixture.resolve("expected-errors.json"), StandardCharsets.UTF_8)).getAsJsonObject();
        List<String> out = new ArrayList<>();
        for (JsonElement e : doc.getAsJsonArray("errors")) {
            JsonObject err = e.getAsJsonObject();
            out.add(err.get("code").getAsString() + " " + err.getAsJsonObject("source").get("jsonPath").getAsString());
        }
        return out;
    }

    private static String describe(MetaDataException e) {
        String code = e.getCode().map(Enum::name).orElse("ERR_UNKNOWN");
        String path = e.getEnvelope().filter(JsonSource.class::isInstance)
            .map(s -> ((JsonSource) s).jsonPath()).orElse("");
        return code + " " + path;
    }

    private static List<String> load(Path fixture, boolean strict) throws IOException {
        MetaDataLoader loader = new MetaDataLoader(LoaderOptions.create(false, false, strict),
            MetaDataLoader.SUBTYPE_MANUAL, "acme");
        loader.init();
        List<MetaDataSource> sources = new ArrayList<>();
        try (Stream<Path> files = Files.list(fixture.resolve("input"))) {
            for (Path f : files.filter(p -> p.toString().endsWith(".json")).sorted().toList()) {
                sources.add(new InMemoryStringSource(Files.readString(f, StandardCharsets.UTF_8), f.getFileName().toString()));
            }
        }
        List<String> seen = new ArrayList<>();
        MetaDataException thrown = null;
        try {
            loader.load(sources);
        } catch (MetaDataException e) {
            thrown = e;
        }
        for (MetaDataException recorded : loader.getErrors()) seen.add(describe(recorded));
        if (thrown != null) seen.add(describe(thrown));
        return seen;
    }

    @Test
    public void theDefaultLoadRefusesItOnce() throws IOException {
        Path fixture = fixture();
        assertEquals(expected(fixture), load(fixture, false));
    }

    @Test
    public void theStrictLoadRefusesItOnce() throws IOException {
        Path fixture = fixture();
        assertEquals(expected(fixture), load(fixture, true));
    }
}

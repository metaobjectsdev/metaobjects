package com.metaobjects.mojo;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.metaobjects.loader.LoaderOptions;
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
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import java.util.stream.Stream;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Cross-port fmt conformance corpus (#304) — {@code fixtures/fmt-conformance/}.
 * See that directory's README.md for the fixture format. Mirrors the TS
 * reference ({@code fmt-conformance.test.ts}) and the C# port
 * ({@code FmtConformanceTests.cs}) exactly; a mismatch here is a bug in THIS
 * port's formatter or serializer, never in the fixture.
 */
@RunWith(Parameterized.class)
public class FmtConformanceTest {

    private static final Path CORPUS = locateCorpus();

    private static Path locateCorpus() {
        Path dir = Paths.get("").toAbsolutePath();
        while (dir != null) {
            Path candidate = dir.resolve("fixtures/fmt-conformance");
            if (Files.isDirectory(candidate)) return candidate;
            dir = dir.getParent();
        }
        throw new AssertionError("Could not locate fixtures/fmt-conformance/ by walking up from "
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

    public FmtConformanceTest(String name, Path dir) {
        this.name = name;
        this.dir = dir;
    }

    @Test
    public void fixture() throws IOException {
        String input = Files.readString(dir.resolve("input.json"), StandardCharsets.UTF_8);

        // Strict, matching MetaDataFmtMojo's own default (lax=false -> strict=true,
        // same convention `gen`/`verify` already use in this port) — unlike TS/C#,
        // an unregistered type/subtype on a CHILD node in this port is only an
        // error under strict load (BaseMetaDataParser's documented lax skip+warn
        // path), so the fixture's "skip-structurally-invalid" case only reproduces
        // under the loader this port's fmt goal actually runs with.
        FmtSupport.FormatFileResult result = FmtSupport.formatFile(
            loaderName -> {
                MetaDataLoader loader = new MetaDataLoader(
                    LoaderOptions.create(false, false, true), MetaDataLoader.SUBTYPE_MANUAL, loaderName);
                loader.init();
                return loader;
            },
            input,
            "input.json");

        Path expected = dir.resolve("expected.json");
        Path expectedSkip = dir.resolve("expected-skip.json");

        if (Files.exists(expected)) {
            assertTrue(name + ": expected ok, got: " + result.message, result.ok);
            assertEquals(name, Files.readString(expected, StandardCharsets.UTF_8), result.text);
        } else {
            assertFalse(name + ": expected a skip, but formatting succeeded", result.ok);
            JsonObject skip = JsonParser.parseString(Files.readString(expectedSkip, StandardCharsets.UTF_8)).getAsJsonObject();
            String reason = skip.get("reason").getAsString();
            assertEquals(name, "overlay".equals(reason), result.overlay);
        }
    }
}

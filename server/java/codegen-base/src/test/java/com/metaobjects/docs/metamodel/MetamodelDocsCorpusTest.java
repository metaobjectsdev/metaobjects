package com.metaobjects.docs.metamodel;

import com.google.gson.Gson;
import com.google.gson.JsonElement;
import com.google.gson.JsonParser;
import org.junit.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

/**
 * Gates the metamodel-docs builder and renderer against the cross-port corpus
 * ({@code fixtures/metamodel-docs/}): the builder's data equals every pinned data file as JSON values,
 * and the rendered pages equal the expected bytes, over exactly the expected file set.
 */
public class MetamodelDocsCorpusTest {

    private static Path root() {
        for (Path p = Path.of("").toAbsolutePath(); p != null; p = p.getParent()) {
            if (Files.isDirectory(p.resolve("fixtures")) && Files.isDirectory(p.resolve("server"))) {
                return p.resolve("fixtures/metamodel-docs");
            }
        }
        throw new IllegalStateException("could not locate the repo root");
    }

    private static Map<String, String> filesUnder(Path dir, String suffix) throws IOException {
        Map<String, String> out = new TreeMap<>();
        try (Stream<Path> s = Files.walk(dir)) {
            for (Path p : s.filter(Files::isRegularFile).collect(Collectors.toList())) {
                String rel = dir.relativize(p).toString().replace('\\', '/');
                if (!rel.endsWith(suffix)) continue;
                out.put(rel.substring(0, rel.length() - suffix.length()), Files.readString(p, StandardCharsets.UTF_8));
            }
        }
        return out;
    }

    @Test
    public void builderDataEqualsEveryPinnedDataFile() throws IOException {
        Map<String, String> pinned = filesUnder(root().resolve("data"), ".json");
        List<MetamodelDocsPages.Page> pages = MetamodelDocsPages.build();
        assertEquals(pinned.keySet(), new TreeSet<>(pages.stream().map(MetamodelDocsPages.Page::path).toList()));
        Gson gson = new Gson();
        for (MetamodelDocsPages.Page page : pages) {
            JsonElement want = JsonParser.parseString(pinned.get(page.path()));
            assertEquals(page.path(), want, gson.toJsonTree(page.data()));
        }
    }

    @Test
    public void renderedPagesEqualTheExpectedBytes() throws IOException {
        Map<String, String> expected = filesUnder(root().resolve("expected"), "");
        Map<String, String> got = MetamodelDocsEmitter.emit("", null);
        assertEquals(expected.keySet(), got.keySet());
        for (Map.Entry<String, String> e : expected.entrySet()) {
            assertEquals(e.getKey(), e.getValue(), got.get(e.getKey()));
        }
        assertTrue(got.size() > 2);
    }
}

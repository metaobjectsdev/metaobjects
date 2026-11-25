/*
 * Copyright 2003 Doug Mealing LLC dba Meta Objects
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package com.metaobjects.config;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.metaobjects.MetaDataException;
import com.metaobjects.loader.FileSource;
import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.loader.MetaDataSource;
import com.metaobjects.object.MetaObject;
import com.metaobjects.registry.SharedRegistryTestBase;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.junit.runners.Parameterized;
import org.junit.runners.Parameterized.Parameter;
import org.junit.runners.Parameterized.Parameters;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.stream.Stream;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/**
 * Runs the shared reference-source corpus against this port: the single committed
 * {@code fixtures/reference-source-conformance/cases.json}. A source declared
 * {@code "reference": true} loads into the same root, and the top-level nodes ONLY reference files
 * declare are the reference nodes ({@link com.metaobjects.MetaRoot#getReferenceNodes()}) that no
 * generator emits. {@code expectReference} is the exhaustive set over the loaded top-level objects.
 */
@RunWith(Parameterized.class)
public class ReferenceSourceConformanceTest extends SharedRegistryTestBase {

    /** The id prefix a reference file loads under, so its provenance cannot collide with an own file's. */
    private static final String REFERENCE_ID_PREFIX = "ref:";

    private record Case(String name, Map<String, String> tree, JsonObject config,
                         Set<String> expectReference, String expectLoadError) {}

    @Parameters(name = "{0}")
    public static Collection<Object[]> cases() throws IOException {
        Path dir = Paths.get("").toAbsolutePath();
        while (dir != null && !Files.isDirectory(dir.resolve("fixtures"))) dir = dir.getParent();
        assertNotNull("could not locate the repository fixtures/ directory", dir);
        Path corpus = dir.resolve("fixtures/reference-source-conformance/cases.json");
        JsonArray arr = JsonParser.parseString(Files.readString(corpus, StandardCharsets.UTF_8))
                .getAsJsonObject().getAsJsonArray("cases");
        List<Object[]> rows = new ArrayList<>();
        for (JsonElement el : arr) {
            JsonObject c = el.getAsJsonObject();
            Map<String, String> tree = new LinkedHashMap<>();
            for (Map.Entry<String, JsonElement> e : c.getAsJsonObject("tree").entrySet()) {
                tree.put(e.getKey(), e.getValue().getAsString());
            }
            Set<String> expect = null;
            if (c.has("expectReference")) {
                expect = new TreeSet<>();
                for (JsonElement f : c.getAsJsonArray("expectReference")) expect.add(f.getAsString());
            }
            String err = c.has("expectLoadError") ? c.get("expectLoadError").getAsString() : null;
            String name = c.get("name").getAsString();
            rows.add(new Object[]{name, new Case(name, tree, c.getAsJsonObject("config"), expect, err)});
        }
        return rows;
    }

    @Parameter(0)
    public String caseName;

    @Parameter(1)
    public Case testCase;

    @Test
    public void reportsTheSameReferenceNodes() throws Exception {
        Path root = Files.createTempDirectory("mo-ref-source-").toAbsolutePath().normalize();
        try {
            for (Map.Entry<String, String> entry : testCase.tree().entrySet()) {
                Path abs = root.resolve(entry.getKey());
                Files.createDirectories(abs.getParent());
                Files.write(abs, entry.getValue().getBytes(StandardCharsets.UTF_8));
            }
            Path dotMo = root.resolve(".metaobjects");
            Files.createDirectories(dotMo);
            Files.write(dotMo.resolve("config.json"), testCase.config().toString().getBytes(StandardCharsets.UTF_8));

            SourceResolver.ResolvedCollection collection = SourceResolver.resolveCollectionWithDependencies(root);
            List<MetaDataSource> sources = new ArrayList<>();
            Set<String> referenceIds = new TreeSet<>();
            for (Path file : collection.ownFiles()) {
                if (collection.referenceFiles().contains(file)) {
                    String id = REFERENCE_ID_PREFIX + root.relativize(file).toString().replace('\\', '/');
                    referenceIds.add(id);
                    sources.add(new FileSource(file, id));
                } else {
                    sources.add(new FileSource(file, root.relativize(file).toString().replace('\\', '/')));
                }
            }

            MetaDataLoader loader = new MetaDataLoader(
                    LoaderOptions.create(false, false, true), MetaDataLoader.SUBTYPE_MANUAL, "ref-" + testCase.name());
            loader.init();
            loader.setReferenceSourceIds(referenceIds);
            try {
                loader.load(sources);
            } catch (MetaDataException e) {
                assertRefusal(e);
                return;
            }
            if (testCase.expectLoadError() != null) {
                for (MetaDataException e : loader.getErrors()) {
                    if (e.getCode().filter(c -> c.name().equals(testCase.expectLoadError())).isPresent()) return;
                }
                fail("expected " + testCase.expectLoadError() + " for case " + testCase.name()
                        + ", got errors " + loader.getErrors());
            }
            assertTrue("unexpected load errors: " + loader.getErrors(), loader.getErrors().isEmpty());

            // Exhaustive over the loaded top-level objects: a reference-node set naming anything else
            // (or missing an object) fails here.
            Set<String> got = new TreeSet<>();
            for (MetaObject o : loader.getMetaObjects()) {
                if (loader.getRoot().getReferenceNodes().contains(o.getName())) got.add(o.getName());
            }
            assertEquals(testCase.expectReference(), got);
        } finally {
            deleteRecursive(root);
        }
    }

    private void assertRefusal(MetaDataException e) {
        assertNotNull("case " + testCase.name() + " raised an uncoded error: " + e, e.getCode().orElse(null));
        assertEquals(testCase.expectLoadError(), e.getCode().orElseThrow().name());
    }

    private static void deleteRecursive(Path dir) throws IOException {
        if (!Files.exists(dir)) return;
        try (Stream<Path> walk = Files.walk(dir)) {
            walk.sorted(Comparator.reverseOrder()).forEach(p -> {
                try {
                    Files.delete(p);
                } catch (IOException ignored) {
                    // best-effort temp-dir cleanup
                }
            });
        }
    }
}

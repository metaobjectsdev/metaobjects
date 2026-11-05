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
import com.metaobjects.ErrorCode;
import com.metaobjects.MetaDataException;
import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.MetaObject;
import com.metaobjects.source.ErrorSource;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.junit.runners.Parameterized;
import org.junit.runners.Parameterized.Parameter;
import org.junit.runners.Parameterized.Parameters;

import java.io.IOException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.TreeSet;
import java.util.function.Predicate;
import java.util.stream.Stream;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/**
 * FR-023 — the RUNTIME path (a Spring app, no project directory: lock and snapshot are read through a
 * {@link Dependencies.SnapshotReader} that has no file path, and the project's own files load through
 * {@link MetaDataLoader#fromUris}) must agree with the build-time path on the shared
 * {@code fixtures/dependency-conformance/} corpus: the same imported / selected / migrate-governed sets,
 * the same load-time failures and source ids, the same resolution errors. "Imported is load-only" at
 * runtime is exactly this agreement.
 */
@RunWith(Parameterized.class)
public class DependencySnapshotRuntimeConformanceTest {

    private record Case(String name, Map<String, String> tree, Map<String, String> treeFiles,
                        JsonObject config, JsonObject lock, String resolveFrom,
                        List<String> expectImported, List<String> expectSelected,
                        List<String> expectMigrateGoverned, String expectLoadError,
                        List<String> expectErrorFiles, String expectError) {}

    @Parameters(name = "{0}")
    public static Collection<Object[]> cases() throws IOException {
        String content = Files.readString(
                DependencyConformanceTest.corpusDir().resolve("cases.json"), StandardCharsets.UTF_8);
        JsonArray arr = JsonParser.parseString(content).getAsJsonObject().getAsJsonArray("cases");
        List<Object[]> rows = new ArrayList<>();
        for (JsonElement el : arr) {
            JsonObject c = el.getAsJsonObject();
            if (c.has("expectCheck")) continue;
            String name = c.get("name").getAsString();
            rows.add(new Object[]{name, new Case(
                    name, strings(c, "tree"), strings(c, "treeFiles"),
                    c.get("config").isJsonNull() ? null : c.getAsJsonObject("config"),
                    c.has("lock") ? c.getAsJsonObject("lock") : null,
                    c.has("resolveFrom") ? c.get("resolveFrom").getAsString() : ".",
                    list(c, "expectImported"), list(c, "expectSelected"), list(c, "expectMigrateGoverned"),
                    c.has("expectLoadError") ? c.get("expectLoadError").getAsString() : null,
                    list(c, "expectErrorFiles"),
                    c.has("expectError") ? c.get("expectError").getAsString() : null)});
        }
        return rows;
    }

    private static Map<String, String> strings(JsonObject c, String key) {
        Map<String, String> out = new LinkedHashMap<>();
        if (c.has(key)) {
            for (Map.Entry<String, JsonElement> e : c.getAsJsonObject(key).entrySet()) {
                out.put(e.getKey(), e.getValue().getAsString());
            }
        }
        return out;
    }

    private static List<String> list(JsonObject c, String key) {
        if (!c.has(key)) return null;
        List<String> out = new ArrayList<>();
        for (JsonElement el : c.getAsJsonArray(key)) out.add(el.getAsString());
        return out;
    }

    @Parameter(0)
    public String caseName;

    @Parameter(1)
    public Case testCase;

    private static void write(Path path, byte[] bytes) throws IOException {
        Files.createDirectories(path.getParent());
        Files.write(path, bytes);
    }

    private static void delete(Path root) throws IOException {
        try (Stream<Path> walk = Files.walk(root)) {
            walk.sorted(Comparator.reverseOrder()).forEach(p -> p.toFile().delete());
        }
    }

    /** What a Spring classpath reader does: bytes by location, no file path to hand back. */
    private static Dependencies.SnapshotReader classpathLike(Path dir) {
        return new Dependencies.SnapshotReader() {
            @Override
            public byte[] read(String name, String artifact) throws IOException {
                return Files.readAllBytes(dir.resolve(".metaobjects/deps").resolve(name).resolve(artifact));
            }

            @Override
            public String describe(String name, String artifact) {
                return "classpath:.metaobjects/deps/" + name + "/" + artifact;
            }
        };
    }

    private static Optional<Map<String, Dependencies.LockEntry>> lockOf(Path dir) throws IOException {
        Path lock = dir.resolve(".metaobjects/deps.lock.json");
        return Files.isRegularFile(lock)
                ? Optional.of(Dependencies.parseLock(Files.readString(lock, StandardCharsets.UTF_8), "classpath lock"))
                : Optional.empty();
    }

    private static DependencySet resolve(Path dir) throws IOException {
        return DependencySet.ofSnapshot(NeutralConfig.read(dir), lockOf(dir), classpathLike(dir));
    }

    private static MetaDataException firstError(MetaDataLoader loader, Throwable thrown) {
        for (Throwable t = thrown; t != null; t = t.getCause()) {
            if (t instanceof MetaDataException e && e.getCode().isPresent()) return e;
        }
        List<MetaDataException> recorded = loader == null ? List.of() : loader.getErrors();
        if (!recorded.isEmpty()) return recorded.get(0);
        return thrown == null ? null : new MetaDataException(String.valueOf(thrown.getMessage()));
    }

    private static List<String> files(ErrorSource source) {
        return source instanceof com.metaobjects.source.JsonSource s ? s.files()
                : source instanceof com.metaobjects.source.YamlSource s ? s.files()
                : source instanceof com.metaobjects.source.MergedSource s ? s.files()
                : source instanceof com.metaobjects.source.ResolvedSource s ? s.files() : List.of();
    }

    @Test
    public void agreesWithTheBuildTimePath() throws IOException {
        Path root = Files.createTempDirectory("mo-dep-runtime-").toAbsolutePath().normalize();
        try {
            for (Map.Entry<String, String> e : testCase.tree().entrySet()) {
                write(root.resolve(e.getKey()), e.getValue().getBytes(StandardCharsets.UTF_8));
            }
            for (Map.Entry<String, String> e : testCase.treeFiles().entrySet()) {
                write(root.resolve(e.getKey()),
                        Files.readAllBytes(DependencyConformanceTest.corpusDir().resolve(e.getValue())));
            }
            Path dir = root.resolve(testCase.resolveFrom()).normalize();
            Files.createDirectories(dir.resolve(".metaobjects"));
            if (testCase.config() != null) {
                write(dir.resolve(".metaobjects/config.json"), testCase.config().toString().getBytes(StandardCharsets.UTF_8));
            }
            if (testCase.lock() != null) {
                write(dir.resolve(".metaobjects/deps.lock.json"), testCase.lock().toString().getBytes(StandardCharsets.UTF_8));
            }

            if (testCase.expectError() != null) {
                try {
                    resolve(dir);
                    fail("expected " + testCase.expectError() + " but resolution succeeded");
                } catch (MetaDataException e) {
                    assertEquals(testCase.expectError(), e.getCode().map(ErrorCode::name).orElse("<no code>"));
                }
                return;
            }

            DependencySet deps = resolve(dir);
            // Which files are the project's OWN is a build-time question already pinned by the resolution
            // arm; the runtime is handed them as URIs, as a Spring app's metadata-sources are.
            List<URI> own = new ArrayList<>();
            for (Path f : SourceResolver.resolveCollectionWithDependencies(dir).ownFiles()) own.add(f.toUri());

            MetaDataLoader loader = null;
            Throwable thrown = null;
            try {
                loader = MetaDataLoader.fromUris("runtime", own, LoaderOptions.create(false, false, true),
                        com.metaobjects.database.PhysicalNaming.DEFAULT, deps);
            } catch (RuntimeException e) {
                thrown = e;
            }
            MetaDataException error = firstError(loader, thrown);

            if (testCase.expectLoadError() != null) {
                assertNotNull("expected " + testCase.expectLoadError() + " but the load succeeded", error);
                assertEquals(testCase.expectLoadError(), error.getCode().map(ErrorCode::name).orElse("<no code>"));
                if (testCase.expectErrorFiles() != null) {
                    ErrorSource envelope = error.getEnvelope().orElse(null);
                    assertNotNull("the error carries no source envelope", envelope);
                    List<String> files = files(envelope);
                    assertFalse("the error names no file", files.isEmpty());
                    assertEquals(testCase.expectErrorFiles(), List.of(files.get(0)));
                }
                return;
            }
            if (error != null) throw error;

            Set<String> loaded = new TreeSet<>();
            for (MetaObject mo : loader.getRoot().getChildren(MetaObject.class, false)) loaded.add(mo.getName());
            assertEquals("the root must carry the set codegen and the runtime read", deps, loader.getRoot().getDependencySet());

            if (testCase.expectImported() != null) {
                assertEquals(new TreeSet<>(testCase.expectImported()), filter(loaded, deps::imported));
            }
            if (testCase.expectSelected() != null) {
                assertEquals(new TreeSet<>(testCase.expectSelected()), filter(loaded, deps::inScope));
            }
            if (testCase.expectMigrateGoverned() != null) {
                Predicate<String> governed = deps.inMigrateScope().orElse(fqn -> true);
                assertEquals(new TreeSet<>(testCase.expectMigrateGoverned()), filter(loaded, governed));
            }
        } finally {
            delete(root);
        }
    }

    private static Set<String> filter(Set<String> all, Predicate<String> keep) {
        Set<String> out = new TreeSet<>();
        for (String s : all) if (keep.test(s)) out.add(s);
        return out;
    }

    @Test
    public void theCorpusIsNotEmpty() throws IOException {
        assertTrue(cases().size() > 0);
    }
}

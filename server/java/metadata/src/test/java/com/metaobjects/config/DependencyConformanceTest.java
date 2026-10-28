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
import com.metaobjects.loader.FileSource;
import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.loader.MetaDataSource;
import com.metaobjects.object.MetaObject;
import com.metaobjects.source.ErrorSource;
import com.metaobjects.source.JsonSource;
import com.metaobjects.source.MergedSource;
import com.metaobjects.source.ResolvedSource;
import com.metaobjects.source.YamlSource;
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
import java.util.List;
import java.util.Map;
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
 * Runs the shared FR-023 dependency corpus against this port (Java; Kotlin loads through the same
 * loader and Maven plugin). Reads the single committed
 * {@code fixtures/dependency-conformance/cases.json} — no per-port fixture. The reference is
 * {@code sdk/src/collection.ts} ({@code resolveCollection}) and {@code sdk/src/memory.ts}
 * ({@code loadMemory}); {@code SourceResolver.resolveCollectionWithDependencies} and
 * {@code DependencySet.refuseUnownedPackages} are this port's counterparts.
 *
 * <p>Arms: resolution ({@code expectFiles}/{@code expectError}), the imported / selected /
 * migrate-governed sets over every loaded top-level object, and load-time failure
 * ({@code expectLoadError}, {@code expectErrorFiles}). The load runs the loader's own errors FIRST
 * and the package-ownership refusal after them — the README's "Ordering note".
 */
@RunWith(Parameterized.class)
public class DependencyConformanceTest {

    private record Case(String name, Map<String, String> tree, Map<String, String> treeFiles,
                         JsonObject config, JsonObject lock, String resolveFrom,
                         List<String> expectFiles, List<String> expectImported,
                         List<String> expectSelected, List<String> expectMigrateGoverned,
                         String expectLoadError, List<String> expectErrorFiles, String expectError) {}

    static Path corpusDir() {
        Path dir = Paths.get("").toAbsolutePath();
        while (dir != null && !Files.isDirectory(dir.resolve("fixtures"))) dir = dir.getParent();
        assertNotNull("could not locate the repository fixtures/ directory", dir);
        return dir.resolve("fixtures/dependency-conformance");
    }

    private static Map<String, String> stringMap(JsonObject c, String key) {
        Map<String, String> out = new java.util.LinkedHashMap<>();
        if (c.has(key)) {
            for (Map.Entry<String, JsonElement> e : c.getAsJsonObject(key).entrySet()) {
                out.put(e.getKey(), e.getValue().getAsString());
            }
        }
        return out;
    }

    private static List<String> stringList(JsonObject c, String key) {
        if (!c.has(key)) return null;
        List<String> out = new ArrayList<>();
        for (JsonElement el : c.getAsJsonArray(key)) out.add(el.getAsString());
        return out;
    }

    private static String optString(JsonObject c, String key) {
        return c.has(key) ? c.get(key).getAsString() : null;
    }

    @Parameters(name = "{0}")
    public static Collection<Object[]> cases() throws IOException {
        String content = Files.readString(corpusDir().resolve("cases.json"), StandardCharsets.UTF_8);
        JsonArray arr = JsonParser.parseString(content).getAsJsonObject().getAsJsonArray("cases");
        List<Object[]> rows = new ArrayList<>();
        for (JsonElement el : arr) {
            JsonObject c = el.getAsJsonObject();
            String name = c.get("name").getAsString();
            // Check-arm cases (`expectCheck`) pin the Node `meta deps check` verdict; the resolution
            // arm run here has nothing to assert on them, and Java has no check of its own.
            if (c.has("expectCheck")) continue;
            if (!c.has("config")) {
                throw new IllegalStateException("corpus case \"" + name + "\" has no \"config\" key");
            }
            JsonElement cfg = c.get("config");
            rows.add(new Object[]{name, new Case(
                    name, stringMap(c, "tree"), stringMap(c, "treeFiles"),
                    cfg.isJsonNull() ? null : cfg.getAsJsonObject(),
                    c.has("lock") ? c.getAsJsonObject("lock") : null,
                    c.has("resolveFrom") ? c.get("resolveFrom").getAsString() : ".",
                    stringList(c, "expectFiles"), stringList(c, "expectImported"),
                    stringList(c, "expectSelected"), stringList(c, "expectMigrateGoverned"),
                    optString(c, "expectLoadError"), stringList(c, "expectErrorFiles"),
                    optString(c, "expectError"))});
        }
        return rows;
    }

    @Parameter(0)
    public String caseName;

    @Parameter(1)
    public Case testCase;

    private static void delete(Path root) throws IOException {
        try (Stream<Path> walk = Files.walk(root)) {
            walk.sorted(Comparator.reverseOrder()).forEach(p -> p.toFile().delete());
        }
    }

    private static void write(Path path, byte[] bytes) throws IOException {
        Files.createDirectories(path.getParent());
        Files.write(path, bytes);
    }

    private static List<String> files(ErrorSource source) {
        if (source instanceof JsonSource s) return s.files();
        if (source instanceof YamlSource s) return s.files();
        if (source instanceof MergedSource s) return s.files();
        if (source instanceof ResolvedSource s) return s.files();
        return List.of();
    }

    /** First error the load produced: thrown, or recorded by the strict loader. */
    private static MetaDataException firstError(MetaDataLoader loader, Throwable thrown) {
        for (Throwable t = thrown; t != null; t = t.getCause()) {
            if (t instanceof MetaDataException e && e.getCode().isPresent()) return e;
        }
        List<MetaDataException> recorded = loader.getErrors();
        if (recorded != null && !recorded.isEmpty()) return recorded.get(0);
        return thrown == null ? null : new MetaDataException(String.valueOf(thrown.getMessage()));
    }

    @Test
    public void resolvesLoadsAndScopesLikeTheReference() throws IOException {
        Path root = Files.createTempDirectory("mo-dep-conformance-").toAbsolutePath().normalize();
        try {
            for (Map.Entry<String, String> e : testCase.tree().entrySet()) {
                write(root.resolve(e.getKey()), e.getValue().getBytes(StandardCharsets.UTF_8));
            }
            // Byte-for-byte: a pinned hash must never be re-encoded on the way in.
            for (Map.Entry<String, String> e : testCase.treeFiles().entrySet()) {
                write(root.resolve(e.getKey()), Files.readAllBytes(corpusDir().resolve(e.getValue())));
            }
            Path invokeDir = root.resolve(testCase.resolveFrom()).normalize();
            Files.createDirectories(invokeDir);
            Path dotMo = invokeDir.resolve(".metaobjects");
            Files.createDirectories(dotMo);
            if (testCase.config() != null) {
                write(dotMo.resolve("config.json"), testCase.config().toString().getBytes(StandardCharsets.UTF_8));
            }
            if (testCase.lock() != null) {
                write(dotMo.resolve("deps.lock.json"), testCase.lock().toString().getBytes(StandardCharsets.UTF_8));
            }

            if (testCase.expectError() != null) {
                try {
                    SourceResolver.resolveCollectionWithDependencies(invokeDir);
                    fail("expected " + testCase.expectError() + " but resolution succeeded");
                } catch (MetaDataException e) {
                    assertEquals(testCase.expectError(), e.getCode().map(ErrorCode::name).orElse("<no code>"));
                }
                return;
            }

            SourceResolver.ResolvedCollection collection =
                    SourceResolver.resolveCollectionWithDependencies(invokeDir);

            Set<String> actual = new TreeSet<>();
            for (Path f : collection.files()) {
                actual.add(root.relativize(f).toString().replace(java.io.File.separatorChar, '/'));
            }
            assertEquals(new TreeSet<>(testCase.expectFiles()), actual);

            boolean needsLoad = testCase.expectImported() != null || testCase.expectSelected() != null
                    || testCase.expectMigrateGoverned() != null || testCase.expectLoadError() != null;
            if (!needsLoad) return;

            DependencySet deps = collection.dependencies();
            List<MetaDataSource> sources = new ArrayList<>(deps.sources());
            for (Path own : collection.ownFiles()) sources.add(new FileSource(own));

            MetaDataLoader loader = new MetaDataLoader(
                    LoaderOptions.create(false, false, true), MetaDataLoader.SUBTYPE_MANUAL, "dep-conformance");
            loader.init();
            Throwable thrown = null;
            try {
                loader.load(sources);
            } catch (RuntimeException e) {
                thrown = e;
            }
            MetaDataException error = firstError(loader, thrown);

            if (error == null) {
                // The loader's own errors come first; only a clean load reaches the ownership walk.
                try {
                    deps.refuseUnownedPackages(loader.getRoot());
                } catch (MetaDataException e) {
                    error = e;
                }
            }

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

            if (testCase.expectImported() != null) {
                assertEquals(new TreeSet<>(testCase.expectImported()), filter(loaded, deps::imported));
            }
            if (testCase.expectSelected() != null) {
                assertEquals(new TreeSet<>(testCase.expectSelected()), filter(loaded, deps::inScope));
            }
            if (testCase.expectMigrateGoverned() != null) {
                // An absent predicate governs everything loaded.
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

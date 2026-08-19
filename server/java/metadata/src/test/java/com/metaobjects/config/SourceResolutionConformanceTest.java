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
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.fail;

/**
 * Runs the shared source-resolution corpus against this port. Reads the single
 * committed {@code fixtures/source-resolution-conformance/cases.json} — no per-port
 * fixture. The corpus is the contract; see
 * {@code server/typescript/packages/sdk/src/sources.ts} + {@code collection.ts} for
 * the authoritative behavior each case pins.
 */
@RunWith(Parameterized.class)
public class SourceResolutionConformanceTest {

    /**
     * One row per corpus case.
     *
     * @param resolveFrom Project-root-relative directory the resolver is invoked
     *     FROM. Defaults to {@code "."} — 18 of 19 cases leave it there, so the
     *     config lives at the project root and "relative to project root" vs
     *     "relative to the invocation directory" coincide. The one case that sets it
     *     ({@code a-parent-relative-path-resolves-against-the-declaring-configs-
     *     directory}) is the one place those two bases diverge, and both the
     *     config's own location AND the {@code expectFiles} comparison base below
     *     must honor it correctly for that case to mean anything.
     */
    private record Case(String name, Map<String, String> tree, JsonObject config,
                         String resolveFrom, List<String> expectFiles, String expectError) {}

    private static Path corpus() {
        Path dir = Paths.get("").toAbsolutePath();
        while (dir != null && !Files.isDirectory(dir.resolve("fixtures"))) dir = dir.getParent();
        assertNotNull("could not locate the repository fixtures/ directory", dir);
        return dir.resolve("fixtures/source-resolution-conformance/cases.json");
    }

    @Parameters(name = "{0}")
    public static Collection<Object[]> cases() throws IOException {
        String content = new String(Files.readAllBytes(corpus()), StandardCharsets.UTF_8);
        JsonObject root = JsonParser.parseString(content).getAsJsonObject();
        JsonArray arr = root.getAsJsonArray("cases");

        List<Object[]> rows = new ArrayList<>();
        for (JsonElement el : arr) {
            JsonObject c = el.getAsJsonObject();
            String name = c.get("name").getAsString();

            Map<String, String> tree = new LinkedHashMap<>();
            for (Map.Entry<String, JsonElement> e : c.getAsJsonObject("tree").entrySet()) {
                tree.put(e.getKey(), e.getValue().getAsString());
            }

            JsonElement cfgEl = c.get("config");
            JsonObject config = (cfgEl == null || cfgEl.isJsonNull()) ? null : cfgEl.getAsJsonObject();

            String resolveFrom = c.has("resolveFrom") ? c.get("resolveFrom").getAsString() : ".";

            List<String> expectFiles = null;
            if (c.has("expectFiles")) {
                expectFiles = new ArrayList<>();
                for (JsonElement f : c.getAsJsonArray("expectFiles")) {
                    expectFiles.add(f.getAsString());
                }
            }

            String expectError = c.has("expectError") ? c.get("expectError").getAsString() : null;

            rows.add(new Object[]{name, new Case(name, tree, config, resolveFrom, expectFiles, expectError)});
        }
        return rows;
    }

    /** First arg drives the JUnit display name. */
    @Parameter(0)
    public String caseName;

    @Parameter(1)
    public Case testCase;

    @Test
    public void resolvesTheSameFileSet() throws IOException {
        // `root` is the PROJECT ROOT — the base every `tree` path and every
        // `expectFiles` entry is written/compared relative to, regardless of
        // `resolveFrom`. Normalized the same way SourceResolver.resolveCollection
        // normalizes its own `root` argument, so relativizing against it later lines
        // up exactly with what the resolver returns.
        Path root = Files.createTempDirectory("mo-src-resolution-").toAbsolutePath().normalize();
        try {
            for (Map.Entry<String, String> entry : testCase.tree().entrySet()) {
                Path abs = root.resolve(entry.getKey());
                Files.createDirectories(abs.getParent());
                Files.write(abs, entry.getValue().getBytes(StandardCharsets.UTF_8));
            }

            // The invocation directory: project root joined with `resolveFrom`. The
            // config MUST be materialized here, not at the project root — a config
            // placed at the project root while resolving FROM a subdirectory would go
            // undetected by resolveCollection there and fail loudly with
            // ERR_COLLECTION_NOT_FOUND, which is what makes this half of the mistake
            // self-catching. Getting it right on purpose (not by luck) is what this
            // comment is pinning.
            Path invokeDir = root.resolve(testCase.resolveFrom()).normalize();
            Files.createDirectories(invokeDir);
            if (testCase.config() != null) {
                Path dotMo = invokeDir.resolve(".metaobjects");
                Files.createDirectories(dotMo);
                Files.write(dotMo.resolve("config.json"),
                        testCase.config().toString().getBytes(StandardCharsets.UTF_8));
            }

            if (testCase.expectError() != null) {
                try {
                    SourceResolver.resolveCollection(invokeDir);
                    fail("expected " + testCase.expectError() + " for case " + testCase.name());
                } catch (MetaDataException e) {
                    assertEquals(testCase.expectError(), e.getCode().orElseThrow().name());
                }
                return;
            }

            // Compared against the PROJECT ROOT explicitly — never against
            // `invokeDir`. For 18 of 19 cases the two coincide (resolveFrom "."), so a
            // comparison-base bug here would pass every case except the one that sets
            // `resolveFrom`, which is exactly why that case exists.
            Set<String> got = SourceResolver.resolveCollection(invokeDir).stream()
                    .map(p -> root.relativize(p).toString().replace('\\', '/'))
                    .collect(Collectors.toSet());

            Set<String> want = new HashSet<>(testCase.expectFiles());
            assertEquals(want, got);
        } finally {
            deleteRecursive(root);
        }
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

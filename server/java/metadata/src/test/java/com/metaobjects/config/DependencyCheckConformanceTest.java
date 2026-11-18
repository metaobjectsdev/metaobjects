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
import org.junit.Test;
import org.junit.runner.RunWith;
import org.junit.runners.Parameterized;
import org.junit.runners.Parameterized.Parameter;
import org.junit.runners.Parameterized.Parameters;

import java.io.IOException;
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
import java.util.stream.Stream;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

/**
 * Runs the {@code expectCheck} arm of the shared FR-023 corpus against this port's
 * {@link Dependencies#check} (the engine behind {@code metaobjects:verify -Dmeta.verify.mode=deps};
 * Kotlin runs the same goal). The reference is {@code cli/src/lib/dependency-sync.ts}
 * {@code checkDependencies}. The status is the contract; the detail text is not.
 */
@RunWith(Parameterized.class)
public class DependencyCheckConformanceTest {

    private record Case(String name, Map<String, String> tree, Map<String, String> treeFiles,
                        JsonObject config, JsonObject lock, String resolveFrom,
                        Map<String, String> expectCheck) {}

    @Parameters(name = "{0}")
    public static Collection<Object[]> cases() throws IOException {
        String content = Files.readString(
                DependencyConformanceTest.corpusDir().resolve("cases.json"), StandardCharsets.UTF_8);
        JsonArray arr = JsonParser.parseString(content).getAsJsonObject().getAsJsonArray("cases");
        List<Object[]> rows = new ArrayList<>();
        for (JsonElement el : arr) {
            JsonObject c = el.getAsJsonObject();
            if (!c.has("expectCheck")) continue;
            String name = c.get("name").getAsString();
            Map<String, String> expected = new LinkedHashMap<>();
            for (Map.Entry<String, JsonElement> e : c.getAsJsonObject("expectCheck").entrySet()) {
                expected.put(e.getKey(), e.getValue().getAsString());
            }
            rows.add(new Object[]{name, new Case(
                    name, strings(c, "tree"), strings(c, "treeFiles"),
                    c.get("config").isJsonNull() ? null : c.getAsJsonObject("config"),
                    c.has("lock") ? c.getAsJsonObject("lock") : null,
                    c.has("resolveFrom") ? c.get("resolveFrom").getAsString() : ".",
                    expected)});
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

    @Test
    public void reportsTheStatusTheReferenceReports() throws IOException {
        Path root = Files.createTempDirectory("mo-dep-check-").toAbsolutePath().normalize();
        try {
            for (Map.Entry<String, String> e : testCase.tree().entrySet()) {
                write(root.resolve(e.getKey()), e.getValue().getBytes(StandardCharsets.UTF_8));
            }
            // Byte-for-byte: a pinned hash must never be re-encoded on the way in.
            for (Map.Entry<String, String> e : testCase.treeFiles().entrySet()) {
                write(root.resolve(e.getKey()),
                        Files.readAllBytes(DependencyConformanceTest.corpusDir().resolve(e.getValue())));
            }
            Path configDir = root.resolve(testCase.resolveFrom()).normalize();
            Path dotMo = configDir.resolve(".metaobjects");
            Files.createDirectories(dotMo);
            if (testCase.config() != null) {
                write(dotMo.resolve("config.json"), testCase.config().toString().getBytes(StandardCharsets.UTF_8));
            }
            if (testCase.lock() != null) {
                write(dotMo.resolve("deps.lock.json"), testCase.lock().toString().getBytes(StandardCharsets.UTF_8));
            }

            List<Map<String, String>> specs = NeutralConfig.read(configDir)
                    .map(NeutralConfig::getDependencies).orElse(List.of());
            List<Dependencies.CheckResult> results = Dependencies.check(configDir, specs, Dependencies.readLock(configDir));

            Map<String, String> actual = new LinkedHashMap<>();
            for (Dependencies.CheckResult r : results) actual.put(r.name(), r.status().name().toLowerCase());
            assertEquals(testCase.expectCheck(), actual);
        } finally {
            delete(root);
        }
    }

    @Test
    public void theCorpusHasCheckCases() throws IOException {
        assertTrue(cases().size() > 0);
    }
}

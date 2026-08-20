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
import static org.junit.Assert.assertTrue;
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
     *     FROM. Defaults to {@code "."} — every case leaves it there EXCEPT
     *     {@code a-parent-relative-path-resolves-against-the-declaring-configs-
     *     directory}, so for all the others the config lives at the project root
     *     and "relative to project root" vs "relative to the invocation directory"
     *     coincide. That one case is the one place those two bases diverge, and
     *     both the config's own location AND the {@code expectFiles} comparison
     *     base below must honor it correctly for that case to mean anything. (Do
     *     not restate this as "N of M cases" — the corpus grows and a hardcoded
     *     count silently goes stale; the structural description above does not.)
     */
    /**
     * {@code expectError}: a JSON string pins the exact error code raised; JSON
     * {@code true} leaves the CODE unpinned but still requires the port's coded
     * {@link MetaDataException} — the malformed-config error code is deliberately
     * not pinned cross-port (see the corpus README), the TYPE is.
     *
     * <p>{@code errorIsNative}: this case's failure surfaces as a PLATFORM-native
     * error rather than a coded exception, lifting the type requirement for it
     * alone — the symlink-cycle case, whose raise comes from the filesystem walk
     * ({@code FileSystemLoopException}) and never reaches a coded-error constructor.
     */
    private record Case(String name, Map<String, String> tree, JsonObject config,
                         String resolveFrom, List<String> expectFiles, JsonElement expectError,
                         Map<String, String> symlinks, boolean errorIsNative) {}

    /** Package-private (not private): shared with {@link SourceResolutionCorpusNotEmptyTest},
     *  which needs to locate the same committed corpus file without a second definition
     *  of "walk up to find fixtures/". */
    static Path corpus() {
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

            // A LITERALLY ABSENT "config" key is a malformed corpus case, not the same
            // thing as an explicit `"config": null` (which means "no config file" —
            // see e.g. no-config-uses-default-directory). Python's dict indexing and
            // C#'s JsonElement.GetProperty both throw on the former; Gson's `get()`
            // returns Java null for BOTH, so without this check a future case that
            // simply forgot the key would silently read as "no config" here while the
            // other three runners crash loudly on the same corpus file.
            if (!c.has("config")) {
                throw new IllegalStateException(
                        "corpus case \"" + name + "\" has no \"config\" key (use JSON null for " +
                        "\"no config file\", not an absent key)");
            }
            JsonElement cfgEl = c.get("config");
            JsonObject config = cfgEl.isJsonNull() ? null : cfgEl.getAsJsonObject();

            String resolveFrom = c.has("resolveFrom") ? c.get("resolveFrom").getAsString() : ".";

            List<String> expectFiles = null;
            if (c.has("expectFiles")) {
                expectFiles = new ArrayList<>();
                for (JsonElement f : c.getAsJsonArray("expectFiles")) {
                    expectFiles.add(f.getAsString());
                }
            }

            JsonElement expectError = c.has("expectError") ? c.get("expectError") : null;

            // Optional: linkPath -> targetPath, both project-root-relative, materialized
            // AFTER `tree` (I1 — a symlinked source root, or a symlinked subdirectory
            // inside a walked tree).
            Map<String, String> symlinks = new LinkedHashMap<>();
            if (c.has("symlinks")) {
                for (Map.Entry<String, JsonElement> e : c.getAsJsonObject("symlinks").entrySet()) {
                    symlinks.put(e.getKey(), e.getValue().getAsString());
                }
            }

            boolean errorIsNative = c.has("errorIsNative") && c.get("errorIsNative").getAsBoolean();

            rows.add(new Object[]{name, new Case(name, tree, config, resolveFrom, expectFiles, expectError, symlinks, errorIsNative)});
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
            // Materialized AFTER tree — see the Case record's symlinks doc.
            for (Map.Entry<String, String> link : testCase.symlinks().entrySet()) {
                Path linkPath = root.resolve(link.getKey());
                Files.createDirectories(linkPath.getParent());
                Files.createSymbolicLink(linkPath, root.resolve(link.getValue()));
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
                JsonElement expected = testCase.expectError();
                boolean codePinned = expected.isJsonPrimitive() && expected.getAsJsonPrimitive().isString();
                try {
                    SourceResolver.resolveCollection(invokeDir);
                    fail("expected " + testCase.expectError() + " for case " + testCase.name());
                } catch (Exception e) {
                    // The catch is on Exception so a native raise can reach the body at
                    // all; the TYPE requirement is asserted here rather than by the catch
                    // clause. `true` leaves the CODE unpinned but still demands
                    // MetaDataException — a malformed config that crashes with a raw NPE
                    // must FAIL this case, not pass it. `errorIsNative` lifts that for the
                    // one case whose raise comes from the filesystem walk
                    // (FileSystemLoopException) and never reaches a coded-error
                    // constructor; widening the whole arm instead would quietly relax the
                    // six malformed-config cases to "anything at all".
                    // (`fail` above throws AssertionError, an Error — so it still escapes.)
                    if (!testCase.errorIsNative()) {
                        assertTrue("case " + testCase.name()
                                        + " must raise MetaDataException, got " + e,
                                e instanceof MetaDataException);
                        if (codePinned) {
                            assertEquals(expected.getAsString(),
                                    ((MetaDataException) e).getCode().orElseThrow().name());
                        }
                    }
                }
                return;
            }

            // Compared against the PROJECT ROOT explicitly — never against
            // `invokeDir`. For every case but the one that sets `resolveFrom` the two
            // coincide (resolveFrom "."), so a comparison-base bug here would pass
            // every other case and fail only that one — which is exactly why that
            // case exists.
            List<Path> raw = SourceResolver.resolveCollection(invokeDir);
            Set<String> got = raw.stream()
                    .map(p -> root.relativize(p).toString().replace('\\', '/'))
                    .collect(Collectors.toSet());

            Set<String> want = new HashSet<>(testCase.expectFiles());
            assertEquals(want, got);
            // The Set comparison above cannot see a duplicate emission (two entries
            // for the same file collapse invisibly into one Set element) —
            // `overlapping-sources-yield-each-file-once` specifically exercises
            // resolveCollection's own de-duplication, so the RAW list length must be
            // asserted too, before it is thrown away by the Set conversion.
            assertEquals(want.size(), raw.size());
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

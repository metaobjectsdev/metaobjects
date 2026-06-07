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
package com.metaobjects.conformance;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonParser;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * Discovers every conformance fixture under the corpus root.
 *
 * <p>Java port of the C# {@code FixtureDiscovery} class. Each scenario
 * directory becomes a {@link Fixture} record with presence-flags for each
 * expectation file ({@code expected.json}, {@code expected-errors.json},
 * {@code expected-warnings.json}, {@code expected-effective.json},
 * {@code script.json}) and the {@code providers.json} presence flag.</p>
 *
 * <p><strong>Provider-set handling note:</strong> Java's metadata providers
 * self-register via {@code ServiceLoader} at class-init; an explicit
 * provider-set composition is not yet exposed in the Java loader. The
 * {@code hasProvidersJson} flag is captured for honest fixture lint but the
 * runner uses the default service-loaded provider set for every fixture.
 * Until provider-set composition lands in the Java loader, fixtures that
 * require a non-default provider set go in the ledger.</p>
 */
public final class FixtureDiscovery {

    private FixtureDiscovery() {
        // Utility class — no instantiation.
    }

    /**
     * One discovered conformance scenario.
     */
    public static final class Fixture {
        public final String name;
        public final Path dir;
        public final Path inputDir;
        public final boolean hasExpected;
        public final boolean hasExpectedEffective;
        public final boolean hasExpectedErrors;
        public final boolean hasExpectedWarnings;
        public final boolean hasScript;
        public final boolean hasProvidersJson;
        /** True when {@code expected/} exists and holds at least one {@code .md} doc golden. */
        public final boolean hasDocsExpected;
        /**
         * True when the fixture ships a cross-port {@code expected-paths.json} layout
         * contract (the api-docs cross-port manifest). Mirrors the TS discovery's
         * {@code hasContractManifest} flag.
         */
        public final boolean hasContractManifest;
        /** Provider IDs required by this fixture (from {@code providers.json}); empty if absent. */
        public final List<String> requiredProviders;

        Fixture(String name, Path dir, Path inputDir,
                boolean hasExpected, boolean hasExpectedEffective,
                boolean hasExpectedErrors, boolean hasExpectedWarnings,
                boolean hasScript, boolean hasProvidersJson,
                boolean hasDocsExpected,
                boolean hasContractManifest,
                List<String> requiredProviders) {
            this.name = name;
            this.dir = dir;
            this.inputDir = inputDir;
            this.hasExpected = hasExpected;
            this.hasExpectedEffective = hasExpectedEffective;
            this.hasExpectedErrors = hasExpectedErrors;
            this.hasExpectedWarnings = hasExpectedWarnings;
            this.hasScript = hasScript;
            this.hasProvidersJson = hasProvidersJson;
            this.hasDocsExpected = hasDocsExpected;
            this.hasContractManifest = hasContractManifest;
            this.requiredProviders = requiredProviders != null
                ? Collections.unmodifiableList(requiredProviders)
                : Collections.emptyList();
        }

        /**
         * A fixture is "docs-only" when it ships an {@code expected/} directory of
         * {@code .md} doc goldens but NONE of the strict metadata expectation files.
         * Such fixtures drive the docs-conformance runner only; the strict metadata
         * conformance runner skips them rather than flagging "declares no expectation
         * files".
         */
        public boolean isDocsOnly() {
            return hasDocsExpected
                && !hasExpected
                && !hasExpectedEffective
                && !hasExpectedErrors
                && !hasExpectedWarnings
                && !hasScript;
        }

        /**
         * A fixture is "contract-only" when it ships a cross-port layout manifest
         * ({@code expected-paths.json}) but NONE of the strict metadata expectation
         * files. Such fixtures drive the dedicated api-docs cross-port conformance
         * runner only ({@code ApiDocsCrossPortConformanceTest} in codegen-spring); the
         * strict metadata conformance runner skips them rather than flagging "declares
         * no expectation files". Mirrors the TS {@code isContractOnlyFixture}.
         */
        public boolean isContractOnly() {
            return hasContractManifest
                && !hasExpected
                && !hasExpectedEffective
                && !hasExpectedErrors
                && !hasExpectedWarnings
                && !hasScript;
        }

        @Override
        public String toString() {
            return name;
        }
    }

    /**
     * Discover every scenario directory under {@code corpusRoot}, sorted by name.
     *
     * @param corpusRoot the conformance corpus root (the directory returned by
     *                   {@link CorpusRoot#locate()})
     * @return immutable, name-sorted list of fixtures
     * @throws AssertionError if any fixture directory has no {@code input/} subdir
     */
    public static List<Fixture> discover(Path corpusRoot) {
        List<String> dirNames = new ArrayList<>();
        try (DirectoryStream<Path> stream = Files.newDirectoryStream(corpusRoot)) {
            for (Path p : stream) {
                if (Files.isDirectory(p)) {
                    dirNames.add(p.getFileName().toString());
                }
            }
        } catch (IOException e) {
            throw new AssertionError("Failed to enumerate corpus directories under " + corpusRoot, e);
        }
        Collections.sort(dirNames);

        List<Fixture> fixtures = new ArrayList<>(dirNames.size());
        for (String name : dirNames) {
            Path dir = corpusRoot.resolve(name);
            Path inputDir = dir.resolve("input");
            if (!Files.isDirectory(inputDir)) {
                throw new AssertionError("Fixture '" + name + "' has no input/ directory");
            }

            Path providersFile = dir.resolve("providers.json");
            boolean hasProvidersJson = Files.isRegularFile(providersFile);
            List<String> requiredProviders = hasProvidersJson
                ? readRequiredProviders(providersFile, name)
                : Collections.emptyList();

            fixtures.add(new Fixture(
                name,
                dir,
                inputDir,
                Files.isRegularFile(dir.resolve("expected.json")),
                Files.isRegularFile(dir.resolve("expected-effective.json")),
                Files.isRegularFile(dir.resolve("expected-errors.json")),
                Files.isRegularFile(dir.resolve("expected-warnings.json")),
                Files.isRegularFile(dir.resolve("script.json")),
                hasProvidersJson,
                hasDocsExpectedDir(dir),
                Files.isRegularFile(dir.resolve("expected-paths.json")),
                requiredProviders));
        }

        return Collections.unmodifiableList(fixtures);
    }

    /**
     * Read the list of required provider IDs from a fixture's {@code providers.json}.
     * The file format is a top-level JSON array of strings (e.g.
     * {@code ["metaobjects-core-types", "metaobjects-documentation"]}).
     *
     * @param providersFile path to {@code providers.json}
     * @param fixtureName   fixture name, for error messages
     * @return the provider IDs in declared order
     * @throws AssertionError if the file is unreadable or not a JSON array of strings
     */
    /**
     * True when {@code dir/expected/} exists and contains at least one {@code .md} file.
     *
     * @param dir the fixture scenario directory
     * @return whether the fixture ships doc goldens
     */
    private static boolean hasDocsExpectedDir(Path dir) {
        Path expectedDir = dir.resolve("expected");
        if (!Files.isDirectory(expectedDir)) {
            return false;
        }
        try (DirectoryStream<Path> stream = Files.newDirectoryStream(expectedDir, "*.md")) {
            return stream.iterator().hasNext();
        } catch (IOException e) {
            throw new AssertionError("Failed to scan expected/ dir under " + dir, e);
        }
    }

    private static List<String> readRequiredProviders(Path providersFile, String fixtureName) {
        try {
            String content = new String(Files.readAllBytes(providersFile), StandardCharsets.UTF_8);
            JsonElement parsed = JsonParser.parseString(content);
            if (!parsed.isJsonArray()) {
                throw new AssertionError("Fixture '" + fixtureName
                    + "' providers.json is not a JSON array: " + providersFile);
            }
            JsonArray array = parsed.getAsJsonArray();
            List<String> result = new ArrayList<>(array.size());
            for (JsonElement el : array) {
                if (!el.isJsonPrimitive() || !el.getAsJsonPrimitive().isString()) {
                    throw new AssertionError("Fixture '" + fixtureName
                        + "' providers.json contains a non-string entry: " + providersFile);
                }
                result.add(el.getAsString());
            }
            return result;
        } catch (IOException e) {
            throw new AssertionError("Fixture '" + fixtureName
                + "' providers.json is unreadable: " + providersFile, e);
        }
    }
}

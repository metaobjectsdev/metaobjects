/*
 * Copyright 2003 Doug Mealing LLC dba Meta Objects. All Rights Reserved.
 *
 * This software is the proprietary information of Doug Mealing LLC dba Meta Objects.
 * Use is subject to license terms.
 */
package com.metaobjects.conformance;

import java.io.IOException;
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

        Fixture(String name, Path dir, Path inputDir,
                boolean hasExpected, boolean hasExpectedEffective,
                boolean hasExpectedErrors, boolean hasExpectedWarnings,
                boolean hasScript, boolean hasProvidersJson) {
            this.name = name;
            this.dir = dir;
            this.inputDir = inputDir;
            this.hasExpected = hasExpected;
            this.hasExpectedEffective = hasExpectedEffective;
            this.hasExpectedErrors = hasExpectedErrors;
            this.hasExpectedWarnings = hasExpectedWarnings;
            this.hasScript = hasScript;
            this.hasProvidersJson = hasProvidersJson;
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

            fixtures.add(new Fixture(
                name,
                dir,
                inputDir,
                Files.isRegularFile(dir.resolve("expected.json")),
                Files.isRegularFile(dir.resolve("expected-effective.json")),
                Files.isRegularFile(dir.resolve("expected-errors.json")),
                Files.isRegularFile(dir.resolve("expected-warnings.json")),
                Files.isRegularFile(dir.resolve("script.json")),
                Files.isRegularFile(dir.resolve("providers.json"))));
        }

        return Collections.unmodifiableList(fixtures);
    }
}

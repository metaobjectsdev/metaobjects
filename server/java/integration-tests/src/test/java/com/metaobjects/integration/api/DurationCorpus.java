package com.metaobjects.integration.api;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

/** Locates the duration api-contract sub-corpus ({@code fixtures/api-contract-conformance/duration/}) and its committed per-engine schema. */
final class DurationCorpus {
    private DurationCorpus() {}

    static Path root() {
        return ApiContractScenarioLoader.findCorpusRoot().resolve("duration");
    }

    static Path scenariosDir() {
        return root().resolve("scenarios");
    }

    /** The committed TypeScript-produced schema of {@code engineId}, read verbatim. */
    static String schema(String engineId) {
        try {
            return Files.readString(root().resolve("schema." + engineId + ".sql"), StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }
}

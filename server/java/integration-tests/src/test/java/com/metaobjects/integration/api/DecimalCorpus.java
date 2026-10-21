package com.metaobjects.integration.api;

import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

/**
 * Locates the decimal api-contract sub-corpus ({@code fixtures/api-contract-conformance/decimal/},
 * ADR-0019 Amendment 1), its committed per-engine schema and its {@code entries} seed. The
 * {@code reports} half of {@code seed.json} is what the SEAM lanes serve; this lane lets the
 * real view derive the rows, so it never reads it.
 */
final class DecimalCorpus {
    private DecimalCorpus() {}

    private static final ObjectMapper MAPPER = new ObjectMapper();

    static Path root() {
        return ApiContractScenarioLoader.findCorpusRoot().resolve("decimal");
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

    /** The seed {@code entries} rows, each {@code amount} still the TEXT the file holds (never a double). */
    @SuppressWarnings("unchecked")
    static List<Map<String, Object>> entries() {
        try {
            Map<String, Object> parsed = MAPPER.readValue(
                Files.readString(root().resolve("seed.json"), StandardCharsets.UTF_8),
                new com.fasterxml.jackson.core.type.TypeReference<java.util.LinkedHashMap<String, Object>>() {});
            return (List<Map<String, Object>>) parsed.get("entries");
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }
}

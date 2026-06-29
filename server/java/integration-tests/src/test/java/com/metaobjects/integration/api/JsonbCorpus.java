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
 * Locates the jsonb open-bag sub-corpus
 * ({@code fixtures/api-contract-conformance/jsonb/}) and loads its seed rows.
 * Shared by the reference ({@link JsonbApiContractConformanceTest}) and generated
 * ({@link JsonbGeneratedApiContractConformanceTest}) lanes.
 */
final class JsonbCorpus {
    private JsonbCorpus() {}

    private static final ObjectMapper MAPPER = new ObjectMapper();

    /** The jsonb sub-corpus root ({@code <api-contract-conformance>/jsonb}). */
    static Path root() {
        return ApiContractScenarioLoader.findCorpusRoot().resolve("jsonb");
    }

    static Path scenariosDir() {
        return root().resolve("scenarios");
    }

    static Path metaJson() {
        return root().resolve("meta.json");
    }

    /** The {@code rows} array from {@code jsonb/seed.json} (payload values are JSON objects). */
    @SuppressWarnings("unchecked")
    static List<Map<String, Object>> seedRows() {
        try {
            String text = Files.readString(root().resolve("seed.json"), StandardCharsets.UTF_8);
            Map<String, Object> parsed = MAPPER.readValue(text, Map.class);
            Object rows = parsed.get("rows");
            if (!(rows instanceof List<?>))
                throw new IllegalStateException("jsonb/seed.json: missing 'rows' array");
            return (List<Map<String, Object>>) rows;
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }
}

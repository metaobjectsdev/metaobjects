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
 * Locates the F22 view-only-projection sub-corpus
 * ({@code fixtures/api-contract-conformance/projection/}) and loads its seed rows.
 *
 * <p>The seed is keyed by the base TABLE ({@code invoices}) and never by the view: the
 * view derives, which is the whole point of the sub-corpus. This lane's in-memory seam
 * stands in for the view, so it is seeded from those same rows.</p>
 */
final class ProjectionCorpus {
    private ProjectionCorpus() {}

    private static final ObjectMapper MAPPER = new ObjectMapper();

    static Path root() {
        return ApiContractScenarioLoader.findCorpusRoot().resolve("projection");
    }

    static Path scenariosDir() {
        return root().resolve("scenarios");
    }

    static Path metaJson() {
        return root().resolve("meta.json");
    }

    /** The {@code invoices} array from {@code projection/seed.json}. */
    @SuppressWarnings("unchecked")
    static List<Map<String, Object>> seedRows() {
        try {
            String text = Files.readString(root().resolve("seed.json"), StandardCharsets.UTF_8);
            Map<String, Object> parsed = MAPPER.readValue(text, Map.class);
            Object rows = parsed.get("invoices");
            if (!(rows instanceof List<?>))
                throw new IllegalStateException("projection/seed.json: missing 'invoices' array");
            return (List<Map<String, Object>>) rows;
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }
}

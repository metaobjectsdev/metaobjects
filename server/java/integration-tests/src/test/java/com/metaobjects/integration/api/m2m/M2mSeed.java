package com.metaobjects.integration.api.m2m;

import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

/**
 * FR-018 — the shared M:N corpus {@code seed.json}, keyed by physical table name
 * (six tables: {@code posts/tags/post_tags/people/follows/friendships}). Loaded
 * once and applied fresh per scenario by both lanes.
 *
 * <p>Mirror of {@code M2mSeed.kt} in {@code integration-tests-kotlin}.</p>
 */
final class M2mSeed {
    private M2mSeed() {}

    private static final ObjectMapper MAPPER = new ObjectMapper();

    @SuppressWarnings("unchecked")
    static Map<String, List<Map<String, Object>>> load(Path corpus) {
        try {
            String text = Files.readString(corpus.resolve("seed.json"), StandardCharsets.UTF_8);
            return (Map<String, List<Map<String, Object>>>) (Map<?, ?>)
                MAPPER.readValue(text, Map.class);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    @SuppressWarnings("unchecked")
    static List<Map<String, Object>> rows(Map<String, List<Map<String, Object>>> seed, String table) {
        Object v = seed.get(table);
        return v == null ? List.of() : (List<Map<String, Object>>) v;
    }
}

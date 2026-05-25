package com.metaobjects.render;

import java.util.Map;
import java.util.Objects;

/**
 * Deterministic, in-memory {@link Provider} — the conformance + unit-test
 * provider. Returns the mapped text for a known reference, or {@code null}
 * when the reference is absent.
 */
public final class InMemoryProvider implements Provider {

    private final Map<String, String> map;

    public InMemoryProvider(Map<String, String> map) {
        this.map = Objects.requireNonNull(map, "map");
    }

    @Override
    public String resolve(String reference) {
        return map.get(reference);
    }
}

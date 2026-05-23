package com.metaobjects.registry;

import java.util.HashMap;
import java.util.Map;
import java.util.ServiceLoader;

/** Aggregates FQN -> Class bindings from all discovered providers (ADR-0001). */
public final class ObjectClassRegistry {
    private final Map<String, Class<?>> byFqn = new HashMap<>();

    /** Discover and register all providers on the classpath via ServiceLoader. */
    public static ObjectClassRegistry discover() {
        ObjectClassRegistry reg = new ObjectClassRegistry();
        for (ObjectClassBindingProvider p : ServiceLoader.load(ObjectClassBindingProvider.class)) {
            reg.register(p);
        }
        return reg;
    }

    public void register(ObjectClassBindingProvider provider) {
        for (Map.Entry<String, Class<?>> e : provider.bindings().entrySet()) {
            Class<?> existing = byFqn.putIfAbsent(e.getKey(), e.getValue());
            if (existing != null && existing != e.getValue()) {
                throw new IllegalStateException(
                    "Conflicting class binding for '" + e.getKey() + "': "
                    + existing.getName() + " vs " + e.getValue().getName());
            }
        }
    }

    /** The bound class for an FQN, or null if none is registered (caller falls back to ValueObject). */
    public Class<?> resolve(String fqn) {
        return byFqn.get(fqn);
    }
}

package com.metaobjects.registry;

import java.util.HashMap;
import java.util.Map;
import java.util.ServiceLoader;

/** Aggregates FQN -> Class bindings from all discovered providers (ADR-0001). */
public final class ObjectClassRegistry {

    // -----------------------------------------------------------------------
    // Process-global holder
    // -----------------------------------------------------------------------

    /** The current process-global registry (null = not yet lazily initialised). */
    private static volatile ObjectClassRegistry globalInstance = null;

    /**
     * Returns the process-global registry.  If no explicit registry has been set via
     * {@link #setGlobal(ObjectClassRegistry)}, a {@link #discover()}-populated instance
     * is created lazily and cached.
     */
    public static ObjectClassRegistry global() {
        ObjectClassRegistry g = globalInstance;
        if (g == null) {
            synchronized (ObjectClassRegistry.class) {
                g = globalInstance;
                if (g == null) {
                    g = discover();
                    globalInstance = g;
                }
            }
        }
        return g;
    }

    /**
     * Installs {@code reg} as the process-global registry.
     * Intended for application startup wiring and for tests.
     */
    public static void setGlobal(ObjectClassRegistry reg) {
        globalInstance = reg;
    }

    /**
     * Clears the cached global instance so the next call to {@link #global()} will
     * perform a fresh {@link #discover()}.  Tests should call this in {@code @After}.
     */
    public static void resetGlobal() {
        globalInstance = null;
    }

    // -----------------------------------------------------------------------
    // Instance members
    // -----------------------------------------------------------------------

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

package com.metaobjects.registry;

import com.metaobjects.constraint.ConstraintEnforcer;

/**
 * Deterministic one-time bootstrap of the process-global registry singletons the
 * load / codegen path lazily builds. See issue #233 and
 * {@code docs/superpowers/specs/2026-08-02-issue-233-maven-parallel-build-deadlock-design.md}.
 *
 * <p>Under a concurrent first init (e.g. a parallel Maven reactor, {@code mvn -T}),
 * two threads building {@link MetaDataRegistry#getInstance()},
 * {@link RegistryManifest#defaultLoaderRegistry()} and
 * {@link ConstraintEnforcer#getInstance()} can acquire their independent locks
 * (MetaDataRegistry INSTANCE_LOCK / RegistryManifest DEFAULT_LOCK /
 * ServiceRegistryFactory LOCK + the JVM class-init locks the type providers trigger)
 * in different orders and deadlock. This warms all of them ON A SINGLE THREAD, once,
 * under one lock — every other thread blocks on {@code WARMUP_LOCK} holding nothing,
 * so no two threads ever interleave the inner locks. After warm-up, every access is a
 * lock-free volatile read.</p>
 *
 * <p>Deliberately NOT placed inside the singleton getters themselves: a self-warming
 * getter would re-enter {@code warmUpDefaults()} and recurse. Callers are the coarse
 * entry points that precede any parallelism — {@link com.metaobjects.loader.MetaDataLoader}
 * init and the Maven mojos' {@code execute()}.</p>
 */
public final class RegistryBootstrap {

    private static volatile boolean warmedUp = false;
    private static final Object WARMUP_LOCK = new Object();

    private RegistryBootstrap() {}

    /**
     * Force-initialize the process-global registry singletons on the calling thread.
     * Idempotent and thread-safe; a warm-up failure propagates to the caller (a
     * poisoned singleton must never be masked as "warmed").
     */
    public static void warmUpDefaults() {
        if (warmedUp) return;
        synchronized (WARMUP_LOCK) {
            if (warmedUp) return;
            // Order is immaterial (all three are independent registries), but fixed.
            MetaDataRegistry.getInstance();            // SPI singleton (+ ServiceRegistryFactory + provider class-inits)
            RegistryManifest.defaultLoaderRegistry();  // sealed loader registry
            ConstraintEnforcer.getInstance();          // constraint enforcer singleton
            warmedUp = true;                           // ONLY after all three build
        }
    }
}

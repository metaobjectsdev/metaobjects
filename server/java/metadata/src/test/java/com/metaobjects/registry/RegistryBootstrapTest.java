package com.metaobjects.registry;

import com.metaobjects.constraint.ConstraintEnforcer;
import org.junit.Test;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertSame;

/**
 * #233 — {@link RegistryBootstrap#warmUpDefaults()} deterministically builds the
 * process-global registry singletons on a single thread, so a concurrent first-init
 * cannot deadlock on their independent locks.
 */
public class RegistryBootstrapTest {

    @Test
    public void warmUpInitializesAllThreeGlobals() {
        RegistryBootstrap.warmUpDefaults();
        assertNotNull(MetaDataRegistry.getInstance());
        assertNotNull(RegistryManifest.defaultLoaderRegistry());
        assertNotNull(ConstraintEnforcer.getInstance());
    }

    @Test
    public void warmUpIsIdempotent() {
        RegistryBootstrap.warmUpDefaults();
        MetaDataRegistry spi1 = MetaDataRegistry.getInstance();
        MetaDataRegistry sealed1 = RegistryManifest.defaultLoaderRegistry();
        RegistryBootstrap.warmUpDefaults();
        assertSame(spi1, MetaDataRegistry.getInstance());
        assertSame(sealed1, RegistryManifest.defaultLoaderRegistry());
    }

    /**
     * Concurrent callers do not throw or hang. NOTE: this cannot reproduce the #233
     * cold first-init deadlock — the three singletons are process-global with no reset,
     * so whichever test ran first already flipped {@code warmedUp}, and every caller
     * here hits the lock-free fast path. Faithful cold-init reproduction needs a fresh
     * JVM (the real {@code mvn -T} reactor); that before/after is verified manually and
     * recorded in the design doc.
     */
    @Test(timeout = 30_000)
    public void warmUpIsThreadSafeUnderConcurrentCallers() throws Exception {
        int n = 8;
        CyclicBarrier start = new CyclicBarrier(n);
        ExecutorService pool = Executors.newFixedThreadPool(n);
        try {
            CompletableFuture<?>[] fs = new CompletableFuture[n];
            for (int i = 0; i < n; i++) {
                fs[i] = CompletableFuture.runAsync(() -> {
                    try {
                        start.await();
                    } catch (Exception e) {
                        throw new RuntimeException(e);
                    }
                    RegistryBootstrap.warmUpDefaults();
                }, pool);
            }
            CompletableFuture.allOf(fs).get(20, TimeUnit.SECONDS); // must not deadlock or throw
            assertNotNull(MetaDataRegistry.getInstance());
        } finally {
            pool.shutdownNow();
        }
    }
}

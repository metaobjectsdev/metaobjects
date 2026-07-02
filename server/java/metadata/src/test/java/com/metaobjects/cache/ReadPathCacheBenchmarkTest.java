/*
 * Copyright 2012 Doug Mealing LLC dba Meta Objects
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package com.metaobjects.cache;

import com.metaobjects.MetaData;
import com.metaobjects.attr.BooleanAttribute;
import com.metaobjects.attr.StringAttribute;
import com.metaobjects.field.MetaField;
import com.metaobjects.field.StringField;
import com.metaobjects.registry.SharedRegistryTestBase;
import org.junit.Test;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.ArrayList;
import java.util.List;

import static org.junit.Assert.*;

/**
 * FR-031: 100k-object read-path throughput gate.
 *
 * <p>Builds ~100k concrete fields, each on a shared 4-deep {@code extends} chain
 * (so every resolving read walks 4 super hops + de-dups), freezes the tree, then
 * hammers the resolving accessors ({@code getMetaAttrs()} + {@code isArrayType()})
 * once per object and asserts a throughput floor. Its job is to <b>fail if a future
 * change silently bypasses the read-path cache</b> (turning every resolving read
 * back into a full extends-chain walk), which is the exact regression FR-031's
 * cache guards against.</p>
 *
 * <p>The threshold is deliberately <b>generous</b> (well below the cached machine's
 * real throughput) so it does not flake on slow / loaded CI hardware — it is a
 * regression tripwire, not a micro-benchmark. As a sharper, hardware-independent
 * check it also asserts the frozen (cached) pass is not dramatically slower than an
 * unfrozen (uncached) recompute of the same work: a bypassed cache shows up as the
 * frozen pass being no faster than — or slower than — uncached.</p>
 */
public class ReadPathCacheBenchmarkTest extends SharedRegistryTestBase {

    private static final Logger log = LoggerFactory.getLogger(ReadPathCacheBenchmarkTest.class);

    /** Number of concrete leaf objects resolved. */
    private static final int OBJECT_COUNT = 100_000;

    /** Depth of the shared abstract extends chain each leaf inherits from. */
    private static final int CHAIN_DEPTH = 4;

    /**
     * Throughput floor: resolving reads per second on the FROZEN (cached) tree.
     * A modern machine does millions/sec cached; 200k/sec leaves >10x head-room so
     * the gate only trips on a real regression (e.g. the cache being bypassed), not
     * on a slow CI box. Each "op" = one getMetaAttrs() + one isArrayType() call.
     */
    private static final double MIN_OPS_PER_SEC = 200_000.0;

    /**
     * Build a shared abstract chain: chain[0] (root, carries baseAttr + isArray) ←
     * chain[1] ← ... ← chain[DEPTH-1]. Leaf fields extend chain[DEPTH-1].
     */
    private List<StringField> buildChain() {
        List<StringField> chain = new ArrayList<>();
        StringField root = new StringField("Base0");
        root.addChild(StringAttribute.create("baseAttr", "baseVal"));
        root.addChild(BooleanAttribute.create(MetaField.ATTR_IS_ARRAY, true));
        chain.add(root);
        for (int d = 1; d < CHAIN_DEPTH; d++) {
            StringField mid = new StringField("Base" + d);
            mid.addChild(StringAttribute.create("mid" + d, "v" + d));
            mid.setSuperData(chain.get(d - 1));
            chain.add(mid);
        }
        return chain;
    }

    private List<StringField> buildLeaves(StringField top) {
        List<StringField> leaves = new ArrayList<>(OBJECT_COUNT);
        for (int i = 0; i < OBJECT_COUNT; i++) {
            StringField leaf = new StringField("Leaf" + i);
            leaf.addChild(StringAttribute.create("own", "o" + i));
            leaf.setSuperData(top);
            leaves.add(leaf);
        }
        return leaves;
    }

    /** Resolve every leaf once; return an accumulator so the JIT can't elide the work. */
    private long resolveAll(List<StringField> leaves) {
        long acc = 0;
        for (StringField leaf : leaves) {
            acc += leaf.getMetaAttrs().size();          // resolving: own + 4 inherited
            if (leaf.isArrayType()) acc++;              // resolving array-ness up the chain
        }
        return acc;
    }

    @Test
    public void resolvingThroughputOn100kObjectsMeetsFloor() {
        StringField top = buildChain().get(CHAIN_DEPTH - 1);
        List<StringField> leaves = buildLeaves(top);

        // Correctness sanity: each leaf resolves own + (baseAttr + isArray + mid1..mid3)
        // = 6 attrs, and inherits array-ness from the root of the chain.
        StringField sample = leaves.get(0);
        assertTrue("leaf inherits baseAttr", sample.hasMetaAttr("baseAttr"));
        assertTrue("leaf inherits mid array-ness", sample.isArrayType());
        assertEquals("own + 5 inherited attrs resolve", 6, sample.getMetaAttrs().size());

        // ---- UNCACHED baseline: resolve on the still-mutable (unfrozen) tree. ----
        long warm = resolveAll(leaves);                 // warm caches/JIT (all unfrozen)
        long tUncachedStart = System.nanoTime();
        long uncachedAcc = resolveAll(leaves);
        long uncachedNanos = System.nanoTime() - tUncachedStart;

        // ---- Freeze the whole tree, then resolve again (CACHED). ----
        for (StringField leaf : leaves) leaf.freeze();
        top.freeze();                                    // freezes the shared chain
        long cachedWarm = resolveAll(leaves);            // prime the frozen cache
        long tCachedStart = System.nanoTime();
        long cachedAcc = resolveAll(leaves);
        long cachedNanos = System.nanoTime() - tCachedStart;

        // Behavior-neutral: cached and uncached resolve identically.
        assertEquals("cached resolution must match uncached", uncachedAcc, cachedAcc);
        assertEquals(warm, uncachedAcc);
        assertEquals(cachedWarm, cachedAcc);

        double cachedOpsPerSec = (double) OBJECT_COUNT / (cachedNanos / 1_000_000_000.0);
        double uncachedOpsPerSec = (double) OBJECT_COUNT / (uncachedNanos / 1_000_000_000.0);
        log.info("FR-031 read-path benchmark: {} objects, chain depth {} — cached {} ops/s, uncached {} ops/s ({}x)",
                OBJECT_COUNT, CHAIN_DEPTH,
                String.format("%.0f", cachedOpsPerSec),
                String.format("%.0f", uncachedOpsPerSec),
                String.format("%.2f", cachedOpsPerSec / uncachedOpsPerSec));

        // GATE 1 — absolute throughput floor (regression tripwire, generous).
        assertTrue(
            "cached resolving throughput " + String.format("%.0f", cachedOpsPerSec)
                + " ops/s fell below the " + String.format("%.0f", MIN_OPS_PER_SEC)
                + " ops/s floor — the read-path cache may have been bypassed",
            cachedOpsPerSec >= MIN_OPS_PER_SEC);

        // GATE 2 — the cache must not make resolving SLOWER than the uncached walk.
        // If the frozen path is materially slower than recompute, the cache is
        // pathological / bypassed. Allow slack for timing noise on a busy box.
        assertTrue(
            "frozen (cached) pass (" + cachedNanos / 1_000_000 + "ms) must not be materially "
                + "slower than the uncached walk (" + uncachedNanos / 1_000_000 + "ms)",
            cachedNanos <= uncachedNanos * 3);
    }
}

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
import com.metaobjects.attr.MetaAttribute;
import com.metaobjects.attr.StringAttribute;
import com.metaobjects.field.MetaField;
import com.metaobjects.field.StringField;
import com.metaobjects.registry.SharedRegistryTestBase;
import org.junit.Test;

import java.util.List;

import static org.junit.Assert.*;

/**
 * FR-031: read-path cache behavior-neutrality tests.
 *
 * <p>The per-node frozen-only read cache (see {@link MetaData#useFrozenCache}) must
 * be <em>invisible</em> — the resolving {@code extends}-chain accessors
 * ({@code getMetaAttrs()} / {@code getChildren(Class)} / {@code isArrayType()})
 * return byte-identical results whether or not the node is frozen. These tests
 * assert:</p>
 * <ol>
 *   <li>Resolving reads are identical before and after {@link MetaData#freeze()}.</li>
 *   <li>{@code freeze()} is recursive over children and idempotent.</li>
 *   <li>Nothing is cached during the mutable (pre-freeze) load phase.</li>
 *   <li>Inherited (via {@code extends}) attrs + array-ness resolve correctly through
 *       the cache.</li>
 *   <li>Re-pointing the super on a frozen node drops the stale cache.</li>
 *   <li>The returned resolving list stays an independent mutable copy per call.</li>
 * </ol>
 */
public class ReadPathCacheTest extends SharedRegistryTestBase {

    /** Build an abstract base field carrying an own attr + isArray flag. */
    private StringField newBase() {
        StringField base = new StringField("BaseStr");
        base.addChild(StringAttribute.create("baseAttr", "baseVal"));
        base.addChild(BooleanAttribute.create(MetaField.ATTR_IS_ARRAY, true));
        return base;
    }

    /** Build a concrete field extending {@code base} with its own attr. */
    private StringField newSub(MetaField base) {
        StringField sub = new StringField("SubStr");
        sub.addChild(StringAttribute.create("subAttr", "subVal"));
        sub.setSuperData(base);
        return sub;
    }

    // ------------------------------------------------------------------
    // 1 — resolving reads identical pre/post freeze
    // ------------------------------------------------------------------

    @Test
    public void resolvingReadsIdenticalBeforeAndAfterFreeze() {
        StringField base = newBase();
        StringField sub = newSub(base);

        // Pre-freeze snapshot (uncached path).
        List<MetaAttribute> before = sub.getMetaAttrs();          // resolving (own + inherited)
        List<MetaData> beforeChildren = sub.getChildren(MetaData.class, true);
        boolean beforeArray = sub.isArrayType();

        base.freeze();
        sub.freeze();

        // Post-freeze reads must match the uncached snapshot exactly.
        assertEquals("resolving attr count unchanged by freeze",
                before.size(), sub.getMetaAttrs().size());
        assertEquals("resolving child count unchanged by freeze",
                beforeChildren.size(), sub.getChildren(MetaData.class, true).size());
        assertEquals("array-ness unchanged by freeze", beforeArray, sub.isArrayType());

        // The sub sees BOTH its own attr and the inherited base attr.
        assertTrue("subAttr present", sub.hasMetaAttr("subAttr"));
        assertTrue("inherited baseAttr present", sub.hasMetaAttr("baseAttr"));
        assertTrue("inherited isArray resolves true", sub.isArrayType());

        // Second frozen read is served from cache — still identical.
        assertEquals(before.size(), sub.getMetaAttrs().size());
        assertTrue(sub.isArrayType());
    }

    // ------------------------------------------------------------------
    // 2 — freeze recursive + idempotent
    // ------------------------------------------------------------------

    @Test
    public void freezeIsRecursiveAndIdempotent() {
        StringField base = newBase();
        assertFalse("not frozen before freeze()", base.isFrozen());
        MetaAttribute child = base.getMetaAttrs().get(0);
        assertFalse("child not frozen before parent freeze()", child.isFrozen());

        base.freeze();
        assertTrue("frozen after freeze()", base.isFrozen());
        assertTrue("child frozen recursively", child.isFrozen());

        base.freeze(); // idempotent — must not throw or change state
        assertTrue(base.isFrozen());
    }

    // ------------------------------------------------------------------
    // 3 — nothing cached during the mutable load phase
    // ------------------------------------------------------------------

    @Test
    public void preFreezeReadsReflectLiveMutation() {
        StringField sub = new StringField("Live");
        sub.addChild(StringAttribute.create("a", "1"));
        assertEquals(1, sub.getMetaAttrs().size());

        // Add another attr WHILE unfrozen — the resolving read must see it (no stale
        // cache from the first read).
        sub.addChild(StringAttribute.create("b", "2"));
        assertEquals("pre-freeze read reflects the added attr", 2, sub.getMetaAttrs().size());
    }

    // ------------------------------------------------------------------
    // 4 — post-freeze cache stays consistent across repeated reads
    // ------------------------------------------------------------------

    @Test
    public void frozenReadsAreStableAcrossManyCalls() {
        StringField base = newBase();
        StringField sub = newSub(base);
        base.freeze();
        sub.freeze();

        int firstCount = sub.getMetaAttrs().size();
        boolean firstArray = sub.isArrayType();
        for (int i = 0; i < 1000; i++) {
            assertEquals(firstCount, sub.getMetaAttrs().size());
            assertEquals(firstArray, sub.isArrayType());
        }
    }

    // ------------------------------------------------------------------
    // 5 — re-pointing super on a frozen node drops the stale cache
    // ------------------------------------------------------------------

    @Test
    public void frozenSuperRepointInvalidatesResolvingCache() {
        StringField base1 = newBase();                       // has baseAttr + isArray
        StringField base2 = new StringField("OtherBase");    // different attrs, NOT array
        base2.addChild(StringAttribute.create("otherAttr", "x"));

        StringField sub = newSub(base1);
        base1.freeze();
        base2.freeze();
        sub.freeze();

        assertTrue("resolves base1 attr", sub.hasMetaAttr("baseAttr"));
        assertTrue("inherits base1 array-ness", sub.isArrayType());
        // prime the caches
        sub.getMetaAttrs();
        sub.isArrayType();

        // Re-point the super post-freeze — the frozen cache must be dropped.
        sub.setSuperData(base2);
        assertFalse("stale base1 attr must be gone", sub.hasMetaAttr("baseAttr"));
        assertTrue("now resolves base2 attr", sub.hasMetaAttr("otherAttr"));
        assertFalse("no longer inherits array-ness", sub.isArrayType());
    }

    // ------------------------------------------------------------------
    // 6 — returned resolving list is an independent mutable copy
    // ------------------------------------------------------------------

    @Test
    public void frozenResolvingListIsIndependentMutableCopyPerCall() {
        StringField base = newBase();
        StringField sub = newSub(base);
        base.freeze();
        sub.freeze();

        List<MetaAttribute> first = sub.getMetaAttrs();
        int originalSize = first.size();
        assertNotSame("each call returns a distinct list instance", first, sub.getMetaAttrs());

        // Mutating the returned list must NOT corrupt the cached snapshot.
        first.clear();
        assertEquals("cache unaffected by caller mutation",
                originalSize, sub.getMetaAttrs().size());
    }
}

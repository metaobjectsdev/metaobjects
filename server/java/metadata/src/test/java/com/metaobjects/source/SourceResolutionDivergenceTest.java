/*
 * Copyright 2003 Doug Mealing LLC dba Meta Objects
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
package com.metaobjects.source;

import com.metaobjects.MetaData;
import com.metaobjects.MetaDataException;
import com.metaobjects.loader.InMemoryStringSource;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.MetaObject;
import com.metaobjects.registry.SharedRegistryTestBase;
import org.junit.Test;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

import static org.junit.Assert.*;

/**
 * {@link SourceResolution} refuses an object whose {@code @role: primary} sources
 * disagree on a physical name — in BOTH directions — and the RUNTIME-facing accessors
 * on {@link MetaObject} inherit that refusal.
 *
 * <p>This is the door the codegen-only guard never covered. OMDB resolves the physical
 * table it reads and writes through {@code MetaObject.getPrimaryRdbTableName()}, which
 * goes through no generator at all — so while the refusal lived in each codegen module's
 * {@code resolveObjectNames}, a divergent object silently bound the inherited PARENT's
 * table on every runtime call. A refusal that depends on which consumer asked is not a
 * refusal.</p>
 *
 * <p>{@code ValidateOnePrimarySource} enforces "exactly one primary" over OWN children
 * only, and effective-children shadowing matches an own child over a super child only on
 * a {@code (type, name)} pair — so two {@code source.rdb} nodes with DIFFERENT explicit
 * names at two levels of an {@code extends} chain never collide and both survive the
 * resolving source walk. Each fixture is asserted to load with ZERO errors first: a
 * guard test whose fixture the loader would reject proves nothing.</p>
 */
public class SourceResolutionDivergenceTest extends SharedRegistryTestBase {

    /**
     * Direction 1 — the inherited primary is READ-ONLY. An {@code object.entity} may not
     * carry a read-only primary ({@code ERR_ENTITY_PRIMARY_SOURCE_READONLY}), so the
     * read-only half is an abstract {@code object.projection}; an ENTITY extending one is
     * legal (only a PROJECTION is restricted to extending projections).
     */
    private static final String READ_ONLY_INHERITED =
        "{ \"metadata.root\": { \"package\": \"acme\", \"children\": ["
      + "  { \"object.entity\": { \"name\": \"Base\", \"children\": ["
      + "      { \"source.rdb\": { \"name\": \"s\", \"@table\": \"bases\" } },"
      + "      { \"field.long\": { \"name\": \"id\" } },"
      + "      { \"identity.primary\": { \"name\": \"pk\", \"@fields\": [\"id\"] } } ] } },"
      + "  { \"object.projection\": { \"name\": \"ParentWeird\", \"abstract\": true, \"children\": ["
      + "      { \"source.rdb\": { \"name\": \"viewSrc\", \"@kind\": \"view\", \"@view\": \"v_parent\" } },"
      + "      { \"field.long\": { \"name\": \"id\", \"extends\": \"Base.id\" } } ] } },"
      + "  { \"object.entity\": { \"name\": \"ChildWeird\", \"extends\": \"ParentWeird\", \"children\": ["
      + "      { \"source.rdb\": { \"name\": \"tableSrc\", \"@table\": \"child_table\" } },"
      + "      { \"identity.primary\": { \"name\": \"pk\", \"@fields\": [\"id\"] } } ] } }"
      + "] } }";

    /**
     * Direction 2 — BOTH primaries writable. Nothing exotic: two plain
     * {@code object.entity} declarations, each naming its own table. This is the direction
     * a writability-based comparison could never see, and the one that reaches
     * {@link MetaObject#findPrimaryWritableSource()}.
     */
    private static final String BOTH_WRITABLE =
        "{ \"metadata.root\": { \"package\": \"acme\", \"children\": ["
      + "  { \"object.entity\": { \"name\": \"ParentWeird\", \"abstract\": true, \"children\": ["
      + "      { \"source.rdb\": { \"name\": \"parentSrc\", \"@table\": \"parent_table\" } },"
      + "      { \"field.long\": { \"name\": \"id\" } } ] } },"
      + "  { \"object.entity\": { \"name\": \"ChildWeird\", \"extends\": \"ParentWeird\", \"children\": ["
      + "      { \"source.rdb\": { \"name\": \"childSrc\", \"@table\": \"child_table\" } },"
      + "      { \"identity.primary\": { \"name\": \"pk\", \"@fields\": [\"id\"] } } ] } }"
      + "] } }";

    private MetaObject loadObject(String canonical, String id, String name) {
        MetaDataLoader loader = createTestLoader(
            "SourceResolutionDivergenceTest-" + id, Collections.emptyList());
        loader.load(List.of(new InMemoryStringSource(canonical, id + ".json")));
        assertEquals("fixture must load cleanly", Collections.emptyList(), loader.getErrors());
        for (MetaData child : loader.getRoot().getChildren(MetaData.class, false)) {
            if (child instanceof MetaObject && child.getName().endsWith(name)) {
                return (MetaObject) child;
            }
        }
        throw new IllegalStateException("no object named " + name);
    }

    private void assertNamesBoth(MetaDataException e, String otherName) {
        // Each substring asserted separately, so a message dropping one still fails.
        assertTrue(e.getMessage(), e.getMessage().contains("ChildWeird"));
        assertTrue(e.getMessage(), e.getMessage().contains(otherName));
        assertTrue(e.getMessage(), e.getMessage().contains("child_table"));
    }

    private void assertRefused(String canonical, String id, String otherName) {
        MetaObject child = loadObject(canonical, id, "ChildWeird");

        // Pin the reachability MECHANISM: both sources survive the child merge. If one
        // shadowed the other there would be no divergence and this would pass vacuously.
        List<String> primaries = new ArrayList<>();
        for (MetaSource s : child.getSources(true)) {
            if (MetaSource.ROLE_PRIMARY.equals(s.getRole())) primaries.add(s.getPhysicalName());
        }
        Collections.sort(primaries);
        List<String> expected = new ArrayList<>(List.of(otherName, "child_table"));
        Collections.sort(expected);
        assertEquals(expected, primaries);

        try {
            SourceResolution.primaryRdbSource(child);
            fail("expected primaryRdbSource to refuse, naming both physical names");
        } catch (MetaDataException e) {
            assertNamesBoth(e, otherName);
        }
        try {
            SourceResolution.refuseDivergentPrimaries(child);
            fail("expected refuseDivergentPrimaries to refuse");
        } catch (MetaDataException e) {
            assertNamesBoth(e, otherName);
        }
    }

    @Test
    public void direction1_readOnlyInheritedPrimaryBesideWritableOwnPrimaryIsRefused() {
        assertRefused(READ_ONLY_INHERITED, "divergent-ro", "v_parent");
    }

    @Test
    public void direction2_twoWritablePrimariesDisagreeingOnATableNameIsRefused() {
        assertRefused(BOTH_WRITABLE, "divergent-w", "parent_table");
    }

    /**
     * The runtime door. {@code getPrimaryRdbTableName()} is what OMDB's
     * {@code SimpleMappingHandlerDB.getTableRef} calls to decide which physical table to
     * read and write; before the refusal moved into the metadata module it answered
     * {@code "parent_table"} here, for an entity that declares {@code "child_table"}.
     */
    @Test
    public void theRuntimeTableNameAccessorRefusesToo() {
        MetaObject child = loadObject(BOTH_WRITABLE, "divergent-runtime", "ChildWeird");
        try {
            child.findPrimaryWritableSource();
            fail("expected findPrimaryWritableSource to refuse");
        } catch (MetaDataException e) {
            assertNamesBoth(e, "parent_table");
        }
        try {
            child.getPrimaryRdbTableName();
            fail("expected getPrimaryRdbTableName to refuse");
        } catch (MetaDataException e) {
            assertNamesBoth(e, "parent_table");
        }
    }

    /**
     * The guard is about DISAGREEMENT, not about the count. Refusing two primaries that
     * name the same relation would make it stricter than the invariant it protects: an
     * object has ONE physical name, not one source declaration.
     */
    @Test
    public void twoPrimariesAgreeingOnAPhysicalNameAreNotRefused() {
        String canonical =
            "{ \"metadata.root\": { \"package\": \"acme\", \"children\": ["
          + "  { \"object.entity\": { \"name\": \"ParentSame\", \"abstract\": true, \"children\": ["
          + "      { \"source.rdb\": { \"name\": \"parentSrc\", \"@table\": \"same_table\" } },"
          + "      { \"field.long\": { \"name\": \"id\" } } ] } },"
          + "  { \"object.entity\": { \"name\": \"ChildSame\", \"extends\": \"ParentSame\", \"children\": ["
          + "      { \"source.rdb\": { \"name\": \"childSrc\", \"@table\": \"same_table\" } },"
          + "      { \"identity.primary\": { \"name\": \"pk\", \"@fields\": [\"id\"] } } ] } }"
          + "] } }";
        MetaObject child = loadObject(canonical, "divergent-same", "ChildSame");
        assertEquals("same_table", SourceResolution.primaryRdbSource(child).getPhysicalName());
        assertEquals("same_table", child.getPrimaryRdbTableName());
    }

    /**
     * #248 — participation in the database derives from a declared primary source, never
     * from the object subtype. An {@code object.value} has none, ever.
     */
    @Test
    public void anObjectWithNoPrimarySourceResolvesToNullRatherThanRefusing() {
        String canonical =
            "{ \"metadata.root\": { \"package\": \"acme\", \"children\": ["
          + "  { \"object.value\": { \"name\": \"Money\", \"children\": ["
          + "      { \"field.long\": { \"name\": \"cents\" } } ] } }"
          + "] } }";
        MetaObject money = loadObject(canonical, "divergent-none", "Money");
        assertNull(SourceResolution.primaryRdbSource(money));
        SourceResolution.refuseDivergentPrimaries(money); // must not throw on zero primaries
    }
}

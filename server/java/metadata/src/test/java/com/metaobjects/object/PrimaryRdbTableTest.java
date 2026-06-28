/*
 * Copyright 2026 Doug Mealing LLC dba Meta Objects
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
package com.metaobjects.object;

import com.metaobjects.loader.InMemoryStringSource;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.registry.SharedRegistryTestBase;
import com.metaobjects.source.MetaSource;
import org.junit.Test;

import java.util.Collection;
import java.util.Collections;
import java.util.List;
import java.util.Optional;

import static org.junit.Assert.*;

/**
 * Tests for {@link MetaObject#getPrimaryRdbTableName()} /
 * {@link MetaObject#getPrimaryRdbViewName()} — the source-v2 ADR-0007 helpers
 * that replace the legacy object-level {@code @dbTable} / {@code @dbView}
 * attrs.
 *
 * <p>An object declares its physical table/view name via a {@code source.rdb}
 * child, NOT via an object-level attr. The helpers look up the primary
 * writable / read-only source (resp.) and return its {@code @table} value.</p>
 */
public class PrimaryRdbTableTest extends SharedRegistryTestBase {

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    private MetaDataLoader newTestLoader() {
        return createTestLoader("PrimaryRdbTableTest", Collections.emptyList());
    }

    private MetaDataLoader loadThrough(String canonical, String id) {
        MetaDataLoader loader = newTestLoader();
        loader.load(List.of(new InMemoryStringSource(canonical, id)));
        return loader;
    }

    // Minimal entity wrapper.
    private String entityWith(String name, String childrenJson) {
        // FR-024 B4b: a read-only-kind primary source makes the object a projection,
        // not an entity (an entity's primary source must be writable). A projection
        // carries no non-extending identity, so it is omitted in that case.
        String kinds = childrenJson.replaceAll("\\s+", "");
        boolean readOnly = kinds.contains("\"@kind\":\"view\"")
            || kinds.contains("\"@kind\":\"materializedView\"")
            || kinds.contains("\"@kind\":\"storedProc\"")
            || kinds.contains("\"@kind\":\"tableFunction\"");
        String subtype = readOnly ? "object.projection" : "object.entity";
        String identityChild = readOnly ? ""
            : ",    { \"identity.primary\": { \"@fields\": \"id\" } }";
        return "{ \"metadata.root\": { \"package\": \"acme\", \"children\": [" +
               "  { \"" + subtype + "\": { \"name\": \"" + name + "\", \"children\": [" +
               "    { \"field.long\": { \"name\": \"id\" } }," +
               childrenJson +
               identityChild +
               "  ] } }" +
               "] } }";
    }

    private MetaObject loadEntity(String canonical, String id, String fqn) {
        MetaDataLoader loader = loadThrough(canonical, id);
        MetaObject obj = loader.getMetaObjectByName(fqn);
        assertNotNull("entity '" + fqn + "' must load", obj);
        return obj;
    }

    // -----------------------------------------------------------------------
    // Case 1 — single source.rdb with @table → getPrimaryRdbTableName returns it
    // -----------------------------------------------------------------------

    @Test
    public void primaryRdbTableName_returnsTable_fromSourceRdb() {
        String canonical = entityWith("Product",
            "{ \"source.rdb\": { \"@table\": \"products\" } }");
        MetaObject product = loadEntity(canonical, "primary-rdb-single.json", "acme::Product");

        assertEquals("products", product.getPrimaryRdbTableName());
        assertNull("no read-only source declared", product.getPrimaryRdbViewName());
    }

    // -----------------------------------------------------------------------
    // Case 2 — no source → both helpers return null
    // -----------------------------------------------------------------------

    @Test
    public void primaryRdbTableName_returnsNull_whenNoSource() {
        String canonical = entityWith("Floater",
            "{ \"field.string\": { \"name\": \"label\" } }");
        MetaObject floater = loadEntity(canonical, "primary-rdb-no-source.json", "acme::Floater");

        assertNull(floater.getPrimaryRdbTableName());
        assertNull(floater.getPrimaryRdbViewName());
        assertTrue("getSources() must be empty when no source declared",
            floater.getSources().isEmpty());
    }

    // -----------------------------------------------------------------------
    // Case 3 — read-only source (@kind: view) → only getPrimaryRdbViewName resolves
    // -----------------------------------------------------------------------

    @Test
    public void primaryRdbViewName_returnsTable_whenSourceIsView() {
        String canonical = entityWith("ProductSummary",
            "{ \"source.rdb\": { \"@table\": \"v_product_summary\", \"@kind\": \"view\" } }");
        MetaObject view = loadEntity(canonical, "primary-rdb-view.json", "acme::ProductSummary");

        assertNull("the primary source is read-only — no writable table",
            view.getPrimaryRdbTableName());
        assertEquals("v_product_summary", view.getPrimaryRdbViewName());
    }

    // -----------------------------------------------------------------------
    // Case 4 — primary + replica (both kind=table, both writable) → primary wins
    // -----------------------------------------------------------------------

    @Test
    public void primaryRdbTableName_skipsReplica_returnsPrimary() {
        String canonical = entityWith("Product",
            "{ \"source.rdb\": { \"name\": \"mainSrc\", \"@table\": \"products\" } }," +
            "{ \"source.rdb\": { \"name\": \"replicaSrc\", \"@table\": \"products_replica\"," +
            "    \"@role\": \"replica\" } }");
        MetaObject product = loadEntity(canonical, "primary-rdb-replica.json", "acme::Product");

        assertEquals("products", product.getPrimaryRdbTableName());

        Collection<MetaSource> sources = product.getSources();
        assertEquals("both sources must be present", 2, sources.size());
    }

    // -----------------------------------------------------------------------
    // Case 5 — findPrimaryWritableSource / findPrimaryReadOnlySource semantics
    // -----------------------------------------------------------------------

    @Test
    public void findPrimaryWritableSource_returnsTheTable() {
        String canonical = entityWith("Product",
            "{ \"source.rdb\": { \"@table\": \"products\" } }");
        MetaObject product = loadEntity(canonical, "primary-find-writable.json", "acme::Product");

        Optional<MetaSource> src = product.findPrimaryWritableSource();
        assertTrue("must find the writable source", src.isPresent());
        assertEquals("products", src.get().getTableName());
        assertTrue(src.get().isWritable());
        assertEquals(MetaSource.ROLE_PRIMARY, src.get().getRole());

        assertFalse("no read-only source",
            product.findPrimaryReadOnlySource().isPresent());
    }

    @Test
    public void findPrimaryReadOnlySource_returnsTheView() {
        String canonical = entityWith("ProductSummary",
            "{ \"source.rdb\": { \"@table\": \"v_product_summary\", \"@kind\": \"view\" } }");
        MetaObject view = loadEntity(canonical, "primary-find-readonly.json", "acme::ProductSummary");

        Optional<MetaSource> src = view.findPrimaryReadOnlySource();
        assertTrue("must find the read-only source", src.isPresent());
        assertEquals("v_product_summary", src.get().getTableName());
        assertTrue(src.get().isReadOnly());

        assertFalse("no writable source on the entity itself",
            view.findPrimaryWritableSource().isPresent());
    }
}

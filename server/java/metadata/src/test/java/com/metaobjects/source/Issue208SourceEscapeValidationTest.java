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

import com.metaobjects.ErrorCode;
import com.metaobjects.MetaDataException;
import com.metaobjects.loader.InMemoryStringSource;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.registry.SharedRegistryTestBase;
import com.metaobjects.util.ErrorMessageConstants;
import org.junit.Test;

import java.net.URI;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/**
 * #208 — DDL-ownership escape valves ({@code @sql} / {@code @unmanaged} on
 * {@code source.rdb}) loader validation (design doc §5, rules R1–R6).
 *
 * <p>One test per rule: R1–R5 are hard errors, R6 is a WARN (not an error), plus
 * a positive case that must load with zero errors and zero warnings. Mirrors
 * {@code packages/metadata/test/validate-source-escapes.test.ts} in the TS
 * reference port.</p>
 */
public class Issue208SourceEscapeValidationTest extends SharedRegistryTestBase {

    private MetaDataLoader newTestLoader() {
        return createTestLoader("Issue208SourceEscapeValidationTest",
            java.util.Collections.<URI>emptyList());
    }

    private MetaDataLoader loadThrough(String canonical, String id) {
        MetaDataLoader loader = newTestLoader();
        loader.load(List.of(new InMemoryStringSource(canonical, id)));
        return loader;
    }

    // =======================================================================
    // R1 — @sql AND @unmanaged on the SAME source → ERR_SQL_BODY_WITH_UNMANAGED
    // =======================================================================

    @Test
    public void r1SqlAndUnmanagedOnSameSourceIsError() {
        String doc = """
            { "metadata.root": { "package": "acme", "children": [
              { "object.projection": { "name": "H", "children": [
                { "source.rdb": { "@kind": "view", "@view": "v", "@sql": "SELECT 1", "@unmanaged": true } },
                { "field.long": { "name": "id" } }
              ] } }
            ] } }
            """;
        try {
            loadThrough(doc, "issue208-r1.json");
            fail("Expected MetaDataException for @sql + @unmanaged on the same source");
        } catch (MetaDataException e) {
            assertTrue("expected ERR_SQL_BODY_WITH_UNMANAGED; got " + e.getMessage(),
                e.getCode().filter(c -> c == ErrorCode.ERR_SQL_BODY_WITH_UNMANAGED).isPresent());
        }
    }

    // =======================================================================
    // R2 — @sql on a writable @kind ("table", the default) → ERR_SQL_BODY_ON_WRITABLE_KIND
    // =======================================================================

    @Test
    public void r2SqlOnWritableKindIsError() {
        String doc = """
            { "metadata.root": { "package": "acme", "children": [
              { "object.entity": { "name": "H", "children": [
                { "source.rdb": { "@table": "t", "@sql": "SELECT 1" } },
                { "field.long": { "name": "id" } },
                { "identity.primary": { "name": "id", "@fields": ["id"] } }
              ] } }
            ] } }
            """;
        try {
            loadThrough(doc, "issue208-r2.json");
            fail("Expected MetaDataException for @sql on a writable @kind");
        } catch (MetaDataException e) {
            assertTrue("expected ERR_SQL_BODY_ON_WRITABLE_KIND; got " + e.getMessage(),
                e.getCode().filter(c -> c == ErrorCode.ERR_SQL_BODY_ON_WRITABLE_KIND).isPresent());
        }
    }

    // =======================================================================
    // R3 — @sql present but empty / whitespace-only → ERR_BAD_ATTR_VALUE
    // =======================================================================

    @Test
    public void r3SqlEmptyStringIsError() {
        String doc = """
            { "metadata.root": { "package": "acme", "children": [
              { "object.projection": { "name": "H", "children": [
                { "source.rdb": { "@kind": "view", "@view": "v", "@sql": "" } },
                { "field.long": { "name": "id" } }
              ] } }
            ] } }
            """;
        try {
            loadThrough(doc, "issue208-r3.json");
            fail("Expected MetaDataException for empty-string @sql");
        } catch (MetaDataException e) {
            assertTrue("expected ERR_BAD_ATTR_VALUE; got " + e.getMessage(),
                e.getCode().filter(c -> c == ErrorCode.ERR_BAD_ATTR_VALUE).isPresent());
        }
    }

    @Test
    public void r3bSqlWhitespaceOnlyIsError() {
        String doc = """
            { "metadata.root": { "package": "acme", "children": [
              { "object.projection": { "name": "H", "children": [
                { "source.rdb": { "@kind": "view", "@view": "v", "@sql": "   " } },
                { "field.long": { "name": "id" } }
              ] } }
            ] } }
            """;
        try {
            loadThrough(doc, "issue208-r3b.json");
            fail("Expected MetaDataException for whitespace-only @sql");
        } catch (MetaDataException e) {
            assertTrue("expected ERR_BAD_ATTR_VALUE; got " + e.getMessage(),
                e.getCode().filter(c -> c == ErrorCode.ERR_BAD_ATTR_VALUE).isPresent());
        }
    }

    // =======================================================================
    // R4 — origin.*-bearing own field under an @sql host → ERR_ORIGIN_UNDER_SQL_BODY
    // =======================================================================

    @Test
    public void r4OriginUnderSqlBodyIsError() {
        String doc = """
            { "metadata.root": { "package": "acme", "children": [
              { "object.entity": { "name": "Base", "children": [
                { "field.long": { "name": "id" } },
                { "field.string": { "name": "title" } },
                { "identity.primary": { "name": "id", "@fields": "id" } }
              ] } },
              { "object.projection": { "name": "H", "children": [
                { "source.rdb": { "@kind": "view", "@view": "v_h", "@sql": "SELECT id, title FROM base" } },
                { "field.long": { "name": "id", "extends": "acme::Base.id" } },
                { "field.string": { "name": "displayTitle", "children": [
                  { "origin.passthrough": { "@from": "acme::Base.title" } }
                ] } },
                { "identity.primary": { "name": "id", "extends": "acme::Base.id" } }
              ] } }
            ] } }
            """;
        try {
            loadThrough(doc, "issue208-r4.json");
            fail("Expected MetaDataException for origin.* field under an @sql host");
        } catch (MetaDataException e) {
            assertTrue("expected ERR_ORIGIN_UNDER_SQL_BODY; got " + e.getMessage(),
                e.getCode().filter(c -> c == ErrorCode.ERR_ORIGIN_UNDER_SQL_BODY).isPresent());
        }
    }

    // =======================================================================
    // R5 — object.projection @filter (#207) + @sql host → ERR_ORIGIN_UNDER_SQL_BODY
    // =======================================================================

    @Test
    public void r5ProjectionFilterUnderSqlBodyIsError() {
        String doc = """
            { "metadata.root": { "package": "acme", "children": [
              { "object.entity": { "name": "Order", "children": [
                { "source.rdb": { "@table": "orders" } },
                { "field.uuid": { "name": "id" } },
                { "field.string": { "name": "status" } },
                { "identity.primary": { "name": "id", "@fields": ["id"] } }
              ] } },
              { "object.projection": { "name": "ActiveOrders", "@filter": { "status": { "ne": "archived" } }, "children": [
                { "source.rdb": {
                    "@kind": "view",
                    "@view": "v_active_orders",
                    "@sql": "SELECT * FROM orders WHERE status <> 'archived'"
                } },
                { "field.uuid": { "name": "id", "extends": "acme::Order.id" } },
                { "field.string": { "name": "status", "extends": "acme::Order.status" } },
                { "identity.primary": { "name": "id", "extends": "acme::Order.id" } }
              ] } }
            ] } }
            """;
        try {
            loadThrough(doc, "issue208-r5.json");
            fail("Expected MetaDataException for @filter + @sql host on a projection");
        } catch (MetaDataException e) {
            assertTrue("expected ERR_ORIGIN_UNDER_SQL_BODY; got " + e.getMessage(),
                e.getCode().filter(c -> c == ErrorCode.ERR_ORIGIN_UNDER_SQL_BODY).isPresent());
        }
    }

    // =======================================================================
    // R6 — origin.*-bearing own field under an @unmanaged host → WARN, not error
    // =======================================================================

    @Test
    public void r6OriginUnderUnmanagedIsWarnNotError() {
        String doc = """
            { "metadata.root": { "package": "acme", "children": [
              { "object.entity": { "name": "Base", "children": [
                { "field.long": { "name": "id" } },
                { "field.string": { "name": "title" } },
                { "identity.primary": { "name": "id", "@fields": "id" } }
              ] } },
              { "object.projection": { "name": "H", "children": [
                { "source.rdb": { "@kind": "view", "@view": "v_h", "@unmanaged": true } },
                { "field.long": { "name": "id", "extends": "acme::Base.id" } },
                { "field.string": { "name": "displayTitle", "children": [
                  { "origin.passthrough": { "@from": "acme::Base.title" } }
                ] } },
                { "identity.primary": { "name": "id", "extends": "acme::Base.id" } }
              ] } }
            ] } }
            """;
        // Must load cleanly (no thrown exception) — R6 is a WARN, not an error.
        MetaDataLoader loader = loadThrough(doc, "issue208-r6.json");
        boolean warnSeen = false;
        for (LoaderWarning w : loader.getEnvelopeWarnings()) {
            if (ErrorMessageConstants.WARN_ORIGIN_UNDER_UNMANAGED.equals(w.code())) {
                warnSeen = true;
                break;
            }
        }
        assertTrue("expected WARN_ORIGIN_UNDER_UNMANAGED in envelope warnings; got "
            + loader.getEnvelopeWarnings(), warnSeen);
    }

    // =======================================================================
    // Positive — a valid @sql view projection (extends-bound fields, no origins)
    // loads with zero errors and zero warnings.
    // =======================================================================

    @Test
    public void positiveSqlViewProjectionLoadsClean() {
        String doc = """
            { "metadata.root": { "package": "acme", "children": [
              { "object.entity": { "name": "Order", "children": [
                { "source.rdb": { "@table": "orders" } },
                { "field.uuid": { "name": "id" } },
                { "field.string": { "name": "status" } },
                { "identity.primary": { "name": "id", "@fields": ["id"] } }
              ] } },
              { "object.projection": { "name": "OrderSummary", "children": [
                { "source.rdb": {
                    "@kind": "view",
                    "@view": "v_order_summary",
                    "@sql": "SELECT id, status FROM orders"
                } },
                { "field.uuid": { "name": "id", "extends": "acme::Order.id" } },
                { "field.string": { "name": "status", "extends": "acme::Order.status" } },
                { "identity.primary": { "name": "id", "extends": "acme::Order.id" } }
              ] } }
            ] } }
            """;
        MetaDataLoader loader = loadThrough(doc, "issue208-positive.json");
        assertEquals("expected zero envelope warnings; got " + loader.getEnvelopeWarnings(),
            0, loader.getEnvelopeWarnings().size());
    }
}

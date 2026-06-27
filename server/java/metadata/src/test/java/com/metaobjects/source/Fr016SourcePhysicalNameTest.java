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
import com.metaobjects.MetaData;
import com.metaobjects.MetaDataException;
import com.metaobjects.io.json.CanonicalJsonSerializer;
import com.metaobjects.loader.InMemoryStringSource;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.MetaObject;
import com.metaobjects.registry.SharedRegistryTestBase;
import com.metaobjects.util.ErrorMessageConstants;
import org.junit.Test;

import java.net.URI;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/**
 * FR-016 / ADR-0018 — Java port behavior tests for {@code source.rdb}
 * per-kind physical-name aliases.
 *
 * <p>Covers the cross-port contract: constants exposure, attr-schema
 * registration, four-step {@link MetaSource#getPhysicalName()} resolution,
 * loader validation outcomes, and the canonical-serializer legacy
 * {@code @table} → kind-matching-alias rewrite.</p>
 *
 * <p>Mirrors {@code packages/metadata/test/fr016-source-name-and-kind-aliases.test.ts}
 * in the TS reference port.</p>
 */
public class Fr016SourcePhysicalNameTest extends SharedRegistryTestBase {

    // -----------------------------------------------------------------------
    // Helpers — single-source-per-entity test fixtures
    // -----------------------------------------------------------------------

    private MetaDataLoader newTestLoader() {
        return createTestLoader("Fr016SourcePhysicalNameTest",
            java.util.Collections.<URI>emptyList());
    }

    private MetaDataLoader loadThrough(String canonical, String id) {
        MetaDataLoader loader = newTestLoader();
        loader.load(List.of(new InMemoryStringSource(canonical, id)));
        return loader;
    }

    /** Build a one-entity model whose source.rdb body is the given JSON snippet. */
    private String oneSourceEntity(String entityName, String sourceBodyJson) {
        // FR-024 B4b: a read-only-kind primary source makes the object a projection,
        // not an entity (an entity's primary source must be writable). The object
        // subtype is irrelevant to the source physical-name resolution under test;
        // a projection carries no non-extending identity, so it is omitted.
        boolean readOnly = sourceBodyJson.contains("\"view\"")
            || sourceBodyJson.contains("\"materializedView\"")
            || sourceBodyJson.contains("\"storedProc\"")
            || sourceBodyJson.contains("\"tableFunction\"");
        String subtype = readOnly ? "object.projection" : "object.entity";
        String identityChild = readOnly ? ""
            : ",    { \"identity.primary\": { \"@fields\": \"id\" } }";
        return "{ \"metadata.root\": { \"package\": \"demo\", \"children\": [" +
               "  { \"" + subtype + "\": { \"name\": \"" + entityName + "\", \"children\": [" +
               "    { \"source.rdb\": " + sourceBodyJson + " }," +
               "    { \"field.long\": { \"name\": \"id\" } }" +
               identityChild +
               "  ] } }" +
               "] } }";
    }

    /** Helper: return the first MetaSource on the first object in the loaded tree. */
    private MetaSource firstSource(MetaDataLoader loader) {
        for (MetaData rootChild : loader.getRoot().getChildren(MetaData.class, false)) {
            if (rootChild instanceof MetaObject) {
                for (MetaData c : rootChild.getChildren(MetaData.class, false)) {
                    if (c instanceof MetaSource) return (MetaSource) c;
                }
            }
        }
        throw new IllegalStateException("no source on first entity");
    }

    // =======================================================================
    // 1 — Constants exposure
    // =======================================================================

    @Test
    public void perKindAttrConstantsHaveKindWordValues() {
        assertEquals("table",            MetaSource.ATTR_TABLE);
        assertEquals("view",             MetaSource.ATTR_VIEW);
        assertEquals("materializedView", MetaSource.ATTR_MATERIALIZED_VIEW);
        assertEquals("proc",             MetaSource.ATTR_PROC);
        assertEquals("function",         MetaSource.ATTR_FUNCTION);
    }

    @Test
    public void physicalNameAttrByKindMapsEveryKindToItsAlias() {
        assertEquals(MetaSource.ATTR_TABLE,
            MetaSource.PHYSICAL_NAME_ATTR_BY_KIND.get(MetaSource.KIND_TABLE));
        assertEquals(MetaSource.ATTR_VIEW,
            MetaSource.PHYSICAL_NAME_ATTR_BY_KIND.get(MetaSource.KIND_VIEW));
        assertEquals(MetaSource.ATTR_MATERIALIZED_VIEW,
            MetaSource.PHYSICAL_NAME_ATTR_BY_KIND.get(MetaSource.KIND_MATERIALIZED_VIEW));
        assertEquals(MetaSource.ATTR_PROC,
            MetaSource.PHYSICAL_NAME_ATTR_BY_KIND.get(MetaSource.KIND_STORED_PROC));
        assertEquals(MetaSource.ATTR_FUNCTION,
            MetaSource.PHYSICAL_NAME_ATTR_BY_KIND.get(MetaSource.KIND_TABLE_FUNCTION));
    }

    // =======================================================================
    // 2 — Attr-schema registration: every kind-aware alias loads cleanly
    // =======================================================================

    @Test
    public void sourceRdbAcceptsViewAttrWithKindView() {
        loadThrough(oneSourceEntity("Demo",
            "{ \"@kind\": \"view\", \"@view\": \"v_customer_summary\" }"),
            "fr016-view.json");
    }

    @Test
    public void sourceRdbAcceptsMaterializedViewAttrWithKind() {
        loadThrough(oneSourceEntity("Demo",
            "{ \"@kind\": \"materializedView\", \"@materializedView\": \"mv_x\" }"),
            "fr016-mv.json");
    }

    @Test
    public void sourceRdbAcceptsProcAttrWithKindStoredProc() {
        loadThrough(oneSourceEntity("Demo",
            "{ \"@kind\": \"storedProc\", \"@proc\": \"fn_get_demo\" }"),
            "fr016-proc.json");
    }

    @Test
    public void sourceRdbAcceptsFunctionAttrWithKindTableFunction() {
        loadThrough(oneSourceEntity("Demo",
            "{ \"@kind\": \"tableFunction\", \"@function\": \"fn_demo_list\" }"),
            "fr016-fn.json");
    }

    // =======================================================================
    // 3 — Four-step physicalName resolution
    // =======================================================================

    @Test
    public void step1KindMatchingTableForDefaultTableKind() {
        MetaDataLoader l = loadThrough(
            oneSourceEntity("Customer", "{ \"@table\": \"customers\" }"),
            "fr016-step1-table.json");
        assertEquals("customers", firstSource(l).getPhysicalName());
    }

    @Test
    public void step1KindMatchingViewForViewKind() {
        MetaDataLoader l = loadThrough(
            oneSourceEntity("CustomerSummary",
                "{ \"@kind\": \"view\", \"@view\": \"v_customer_summary\" }"),
            "fr016-step1-view.json");
        assertEquals("v_customer_summary", firstSource(l).getPhysicalName());
    }

    @Test
    public void step1KindMatchingProcForStoredProcKind() {
        MetaDataLoader l = loadThrough(
            oneSourceEntity("PhaseSummary",
                "{ \"@kind\": \"storedProc\", \"@proc\": \"fn_get_phase_summary\" }"),
            "fr016-step1-proc.json");
        assertEquals("fn_get_phase_summary", firstSource(l).getPhysicalName());
    }

    @Test
    public void step1KindMatchingMaterializedView() {
        MetaDataLoader l = loadThrough(
            oneSourceEntity("Agg",
                "{ \"@kind\": \"materializedView\", \"@materializedView\": \"mv_agg\" }"),
            "fr016-step1-mv.json");
        assertEquals("mv_agg", firstSource(l).getPhysicalName());
    }

    @Test
    public void step1KindMatchingFunctionForTableFunction() {
        MetaDataLoader l = loadThrough(
            oneSourceEntity("List",
                "{ \"@kind\": \"tableFunction\", \"@function\": \"fn_list\" }"),
            "fr016-step1-fn.json");
        assertEquals("fn_list", firstSource(l).getPhysicalName());
    }

    @Test
    public void step2LegacyTableForNonTableKind() {
        // Legacy: @table with non-table @kind still resolves (and emits a warning).
        MetaDataLoader l = loadThrough(
            oneSourceEntity("PhaseSummary",
                "{ \"@kind\": \"storedProc\", \"@table\": \"fn_legacy_phase_summary\" }"),
            "fr016-step2-legacy.json");
        assertEquals("fn_legacy_phase_summary", firstSource(l).getPhysicalName());
    }

    @Test
    public void step3DerivesFromSourceStructuralName() {
        MetaDataLoader l = loadThrough(
            oneSourceEntity("Order", "{ \"name\": \"Customers\" }"),
            "fr016-step3-name.json");
        // snake_case("Customers") = "customers"
        assertEquals("customers", firstSource(l).getPhysicalName());
    }

    @Test
    public void step3SourceNameDerivationAlsoWorksForNonTableKind() {
        MetaDataLoader l = loadThrough(
            oneSourceEntity("OrderView",
                "{ \"name\": \"OrdersDaily\", \"@kind\": \"view\" }"),
            "fr016-step3-view.json");
        assertEquals("orders_daily", firstSource(l).getPhysicalName());
    }

    @Test
    public void step4EntityNameFallback() {
        // No alias, no source name → pluralize(snake_case(entity.name)).
        MetaDataLoader l = loadThrough(
            oneSourceEntity("Customer", "{ }"),
            "fr016-step4-entity.json");
        assertEquals("customers", firstSource(l).getPhysicalName());
    }

    // =======================================================================
    // 4 — Loader validation
    // =======================================================================

    @Test
    public void errPhysicalNameKindMismatchViewAttrWithStoredProc() {
        try {
            loadThrough(oneSourceEntity("Demo",
                "{ \"@kind\": \"storedProc\", \"@view\": \"v_x\" }"),
                "fr016-mismatch-view-proc.json");
            fail("Expected MetaDataException for @view with @kind: storedProc");
        } catch (MetaDataException e) {
            assertTrue("expected ERR_PHYSICAL_NAME_KIND_MISMATCH; got " + e.getMessage(),
                e.getCode().filter(c -> c == ErrorCode.ERR_PHYSICAL_NAME_KIND_MISMATCH).isPresent());
        }
    }

    @Test
    public void errPhysicalNameKindMismatchProcAttrWithView() {
        try {
            loadThrough(oneSourceEntity("Demo",
                "{ \"@kind\": \"view\", \"@proc\": \"fn_x\" }"),
                "fr016-mismatch-proc-view.json");
            fail("Expected MetaDataException for @proc with @kind: view");
        } catch (MetaDataException e) {
            assertTrue("expected ERR_PHYSICAL_NAME_KIND_MISMATCH; got " + e.getMessage(),
                e.getCode().filter(c -> c == ErrorCode.ERR_PHYSICAL_NAME_KIND_MISMATCH).isPresent());
        }
    }

    @Test
    public void errPhysicalNameMultipleBothTableAndView() {
        try {
            loadThrough(oneSourceEntity("Demo",
                "{ \"@table\": \"t_x\", \"@view\": \"v_x\" }"),
                "fr016-multi-table-view.json");
            fail("Expected MetaDataException for @table + @view");
        } catch (MetaDataException e) {
            assertTrue("expected ERR_PHYSICAL_NAME_MULTIPLE; got " + e.getMessage(),
                e.getCode().filter(c -> c == ErrorCode.ERR_PHYSICAL_NAME_MULTIPLE).isPresent());
        }
    }

    @Test
    public void errPhysicalNameMultipleBothViewAndProc() {
        try {
            loadThrough(oneSourceEntity("Demo",
                "{ \"@view\": \"v_x\", \"@proc\": \"fn_x\" }"),
                "fr016-multi-view-proc.json");
            fail("Expected MetaDataException for @view + @proc");
        } catch (MetaDataException e) {
            assertTrue("expected ERR_PHYSICAL_NAME_MULTIPLE; got " + e.getMessage(),
                e.getCode().filter(c -> c == ErrorCode.ERR_PHYSICAL_NAME_MULTIPLE).isPresent());
        }
    }

    @Test
    public void warnLegacyPhysicalNameAliasOnTableForViewKind() {
        MetaDataLoader loader = loadThrough(
            oneSourceEntity("Demo", "{ \"@kind\": \"view\", \"@table\": \"v_x\" }"),
            "fr016-warn-legacy.json");
        boolean warnSeen = false;
        for (LoaderWarning w : loader.getEnvelopeWarnings()) {
            if (ErrorMessageConstants.WARN_LEGACY_PHYSICAL_NAME_ALIAS.equals(w.code())) {
                warnSeen = true;
                break;
            }
        }
        assertTrue("expected WARN_LEGACY_PHYSICAL_NAME_ALIAS in envelope warnings; got "
            + loader.getEnvelopeWarnings(), warnSeen);
    }

    @Test
    public void noErrorWhenTableUsedWithDefaultKindTable() {
        // Pure happy path: @table with default kind (table) is canonical.
        MetaDataLoader loader = loadThrough(
            oneSourceEntity("Demo", "{ \"@table\": \"demos\" }"),
            "fr016-default-kind.json");
        for (LoaderWarning w : loader.getEnvelopeWarnings()) {
            assertFalse("must NOT warn WARN_LEGACY_PHYSICAL_NAME_ALIAS for default kind",
                ErrorMessageConstants.WARN_LEGACY_PHYSICAL_NAME_ALIAS.equals(w.code()));
        }
    }

    @Test
    public void emptyStringAliasValueRaisesErrBadAttrValue() {
        try {
            loadThrough(
                oneSourceEntity("Demo", "{ \"@kind\": \"view\", \"@view\": \"\" }"),
                "fr016-empty-string.json");
            fail("Expected MetaDataException for empty-string @view");
        } catch (MetaDataException e) {
            assertTrue("expected ERR_BAD_ATTR_VALUE; got " + e.getMessage(),
                e.getCode().filter(c -> c == ErrorCode.ERR_BAD_ATTR_VALUE).isPresent());
        }
    }

    // =======================================================================
    // 5 — Canonical-serializer rewrite (legacy @table → kind-matching alias)
    // =======================================================================

    @Test
    public void canonicalSerializerRewritesLegacyTableForKindView() {
        MetaDataLoader loader = loadThrough(
            oneSourceEntity("OldStyleView", "{ \"@kind\": \"view\", \"@table\": \"v_old\" }"),
            "fr016-serializer-view.json");
        String out = CanonicalJsonSerializer.canonicalSerialize(loader.getRoot());
        assertTrue("canonical output must contain @view: \"v_old\"; got\n" + out,
            out.contains("\"@view\": \"v_old\""));
        assertFalse("canonical output must NOT contain legacy @table: \"v_old\"; got\n" + out,
            out.contains("\"@table\": \"v_old\""));
    }

    @Test
    public void canonicalSerializerRewritesLegacyTableForKindStoredProc() {
        MetaDataLoader loader = loadThrough(
            oneSourceEntity("OldStyleProc",
                "{ \"@kind\": \"storedProc\", \"@table\": \"fn_x\" }"),
            "fr016-serializer-proc.json");
        String out = CanonicalJsonSerializer.canonicalSerialize(loader.getRoot());
        assertTrue("canonical output must contain @proc: \"fn_x\"; got\n" + out,
            out.contains("\"@proc\": \"fn_x\""));
        assertFalse("canonical output must NOT contain legacy @table: \"fn_x\"; got\n" + out,
            out.contains("\"@table\": \"fn_x\""));
    }

    @Test
    public void canonicalSerializerRewritesLegacyTableForKindMaterializedView() {
        MetaDataLoader loader = loadThrough(
            oneSourceEntity("OldStyleMv",
                "{ \"@kind\": \"materializedView\", \"@table\": \"mv_x\" }"),
            "fr016-serializer-mv.json");
        String out = CanonicalJsonSerializer.canonicalSerialize(loader.getRoot());
        assertTrue("canonical output must contain @materializedView: \"mv_x\"; got\n" + out,
            out.contains("\"@materializedView\": \"mv_x\""));
        assertFalse("canonical output must NOT contain legacy @table: \"mv_x\"; got\n" + out,
            out.contains("\"@table\": \"mv_x\""));
    }

    @Test
    public void canonicalSerializerIsNoOpForCanonicalInput() {
        // Already canonical: @kind: table + @table is the identity case.
        MetaDataLoader loader = loadThrough(
            oneSourceEntity("Customer", "{ \"@table\": \"customers\" }"),
            "fr016-serializer-noop.json");
        String out = CanonicalJsonSerializer.canonicalSerialize(loader.getRoot());
        assertTrue("canonical output must still carry @table: \"customers\"; got\n" + out,
            out.contains("\"@table\": \"customers\""));
    }

    @Test
    public void canonicalSerializerPreservesAlreadyCanonicalView() {
        // Already canonical: @kind: view + @view → identity round-trip.
        MetaDataLoader loader = loadThrough(
            oneSourceEntity("OrderView",
                "{ \"@kind\": \"view\", \"@view\": \"v_orders\" }"),
            "fr016-serializer-canon-view.json");
        String out = CanonicalJsonSerializer.canonicalSerialize(loader.getRoot());
        assertTrue("canonical output must contain @view: \"v_orders\"; got\n" + out,
            out.contains("\"@view\": \"v_orders\""));
        assertFalse("must NOT have a stray @table alias",
            out.contains("\"@table\":"));
    }
}

package com.metaobjects.relationship;

import com.metaobjects.ErrorCode;
import com.metaobjects.MetaData;
import com.metaobjects.MetaDataException;
import com.metaobjects.attr.StringAttribute;
import com.metaobjects.loader.InMemoryMetaDataSource;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.registry.SharedRegistryTestBase;
import org.junit.Test;

import java.util.Collections;
import java.util.List;

import static org.junit.Assert.*;

/**
 * Tests for {@code @onDelete} / {@code @onUpdate} referential-action attrs on relationship nodes.
 *
 * <p>Cross-language contract: {@code REFERENTIAL_ACTIONS = {cascade, set-null, restrict, no-action}}
 * (kebab-case, no setDefault). Matches the TS migrate-ts {@code FkAction} union.</p>
 *
 * <p>Default-derivation (composition→cascade, aggregation→set-null, association→restrict;
 * {@code @onUpdate} default cascade) lives in consumer code, not in the loader.
 * The constants {@link MetaRelationship#ON_DELETE_DEFAULT_BY_SUBTYPE} and
 * {@link MetaRelationship#ON_UPDATE_DEFAULT} are exported here for the deriver.</p>
 */
public class RelationshipReferentialActionsTest extends SharedRegistryTestBase {

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    private MetaDataLoader newTestLoader() {
        return createTestLoader("RelationshipReferentialActionsTest", Collections.emptyList());
    }

    /**
     * Load the given canonical JSON through the full loader pipeline.
     * Propagates any {@link MetaDataException} thrown during parse or validation.
     */
    private MetaDataLoader loadThrough(String canonical, String id) {
        MetaDataLoader loader = newTestLoader();
        loader.load(List.of(new InMemoryMetaDataSource(canonical, id)));
        return loader;
    }

    /** Minimal entity with one relationship child. */
    private String entityWithRelationship(String relJson) {
        return "{ \"metadata.root\": { \"package\": \"acme\", \"children\": ["
             + "  { \"object.entity\": { \"name\": \"Order\", \"children\": ["
             + "    { \"field.long\": { \"name\": \"id\" } },"
             + relJson + ","
             + "    { \"identity.primary\": { \"@fields\": \"id\" } }"
             + "  ] } }"
             + "] } }";
    }

    // -----------------------------------------------------------------------
    // 1 — Constants correctness
    // -----------------------------------------------------------------------

    @Test
    public void attrConstantsHaveExpectedValues() {
        assertEquals("ATTR_ON_DELETE", "onDelete", MetaRelationship.ATTR_ON_DELETE);
        assertEquals("ATTR_ON_UPDATE", "onUpdate", MetaRelationship.ATTR_ON_UPDATE);
    }

    @Test
    public void referentialActionConstantsHaveExpectedValues() {
        assertEquals("ACTION_CASCADE",   "cascade",   MetaRelationship.ACTION_CASCADE);
        assertEquals("ACTION_SET_NULL",  "set-null",  MetaRelationship.ACTION_SET_NULL);
        assertEquals("ACTION_RESTRICT",  "restrict",  MetaRelationship.ACTION_RESTRICT);
        assertEquals("ACTION_NO_ACTION", "no-action", MetaRelationship.ACTION_NO_ACTION);
    }

    @Test
    public void referentialActionsSetContainsFourValues() {
        assertEquals("REFERENTIAL_ACTIONS must have exactly 4 members", 4,
                MetaRelationship.REFERENTIAL_ACTIONS.size());
        assertTrue("cascade",   MetaRelationship.REFERENTIAL_ACTIONS.contains("cascade"));
        assertTrue("set-null",  MetaRelationship.REFERENTIAL_ACTIONS.contains("set-null"));
        assertTrue("restrict",  MetaRelationship.REFERENTIAL_ACTIONS.contains("restrict"));
        assertTrue("no-action", MetaRelationship.REFERENTIAL_ACTIONS.contains("no-action"));
        assertFalse("setDefault must NOT be in REFERENTIAL_ACTIONS",
                MetaRelationship.REFERENTIAL_ACTIONS.contains("setDefault"));
        assertFalse("set_default must NOT be in REFERENTIAL_ACTIONS",
                MetaRelationship.REFERENTIAL_ACTIONS.contains("set_default"));
    }

    // -----------------------------------------------------------------------
    // 2 — ON_DELETE_DEFAULT_BY_SUBTYPE + ON_UPDATE_DEFAULT (rollout defaults)
    // -----------------------------------------------------------------------

    @Test
    public void onDeleteDefaultsBySubtypeMatchRolloutDecision() {
        assertEquals("composition default onDelete should be cascade",
                MetaRelationship.ACTION_CASCADE,
                MetaRelationship.ON_DELETE_DEFAULT_BY_SUBTYPE.get(CompositionRelationship.SUBTYPE_COMPOSITION));
        assertEquals("aggregation default onDelete should be set-null",
                MetaRelationship.ACTION_SET_NULL,
                MetaRelationship.ON_DELETE_DEFAULT_BY_SUBTYPE.get(AggregationRelationship.SUBTYPE_AGGREGATION));
        assertEquals("association default onDelete should be restrict",
                MetaRelationship.ACTION_RESTRICT,
                MetaRelationship.ON_DELETE_DEFAULT_BY_SUBTYPE.get(AssociationRelationship.SUBTYPE_ASSOCIATION));
    }

    @Test
    public void onUpdateDefaultIsCascade() {
        assertEquals("ON_UPDATE_DEFAULT should be cascade",
                MetaRelationship.ACTION_CASCADE, MetaRelationship.ON_UPDATE_DEFAULT);
    }

    // -----------------------------------------------------------------------
    // 3 — Accessor defaults: null when attrs are absent
    // -----------------------------------------------------------------------

    @Test
    public void getOnDeleteRawReturnsNullWhenAbsent() {
        CompositionRelationship rel = new CompositionRelationship("items");
        assertNull("getOnDeleteRaw() should return null when @onDelete is unset", rel.getOnDeleteRaw());
    }

    @Test
    public void getOnUpdateRawReturnsNullWhenAbsent() {
        AggregationRelationship rel = new AggregationRelationship("members");
        assertNull("getOnUpdateRaw() should return null when @onUpdate is unset", rel.getOnUpdateRaw());
    }

    // -----------------------------------------------------------------------
    // 4 — Accessors return set values (unit-level, no loader)
    // -----------------------------------------------------------------------

    @Test
    public void getOnDeleteRawReturnsSetValue() {
        CompositionRelationship rel = new CompositionRelationship("items");
        StringAttribute attr = new StringAttribute(MetaRelationship.ATTR_ON_DELETE);
        attr.setValueAsString(MetaRelationship.ACTION_CASCADE);
        rel.addChild(attr);

        assertEquals("getOnDeleteRaw() should return the set value",
                MetaRelationship.ACTION_CASCADE, rel.getOnDeleteRaw());
    }

    @Test
    public void getOnUpdateRawReturnsSetValue() {
        AssociationRelationship rel = new AssociationRelationship("customer");
        StringAttribute attr = new StringAttribute(MetaRelationship.ATTR_ON_UPDATE);
        attr.setValueAsString(MetaRelationship.ACTION_RESTRICT);
        rel.addChild(attr);

        assertEquals("getOnUpdateRaw() should return the set value",
                MetaRelationship.ACTION_RESTRICT, rel.getOnUpdateRaw());
    }

    // -----------------------------------------------------------------------
    // 5 — All four valid values accepted through the loader
    // -----------------------------------------------------------------------

    @Test
    public void allValidOnDeleteValuesAccepted() {
        for (String action : MetaRelationship.REFERENTIAL_ACTIONS) {
            String json = entityWithRelationship(
                "{ \"relationship.composition\": { \"name\": \"items\","
                + " \"@targetObject\": \"Item\", \"@onDelete\": \"" + action + "\" } }");
            MetaDataLoader loader = loadThrough(json, "onDelete-" + action + ".json");

            MetaData order = loader.getRoot().getChildOfType("object", "acme::Order");
            assertNotNull("Order should exist for action=" + action, order);

            MetaData rel = order.getChildOfType(MetaRelationship.TYPE_RELATIONSHIP, "acme::items");
            assertNotNull("relationship.composition 'acme::items' should exist for action=" + action, rel);
            assertTrue("node must be a MetaRelationship", rel instanceof MetaRelationship);
            assertEquals("getOnDeleteRaw() should return '" + action + "'",
                    action, ((MetaRelationship) rel).getOnDeleteRaw());
        }
    }

    @Test
    public void allValidOnUpdateValuesAccepted() {
        for (String action : MetaRelationship.REFERENTIAL_ACTIONS) {
            String json = entityWithRelationship(
                "{ \"relationship.aggregation\": { \"name\": \"members\","
                + " \"@targetObject\": \"Member\", \"@onUpdate\": \"" + action + "\" } }");
            MetaDataLoader loader = loadThrough(json, "onUpdate-" + action + ".json");

            MetaData order = loader.getRoot().getChildOfType("object", "acme::Order");
            assertNotNull("Order should exist for action=" + action, order);

            MetaData rel = order.getChildOfType(MetaRelationship.TYPE_RELATIONSHIP, "acme::members");
            assertNotNull("relationship.aggregation 'acme::members' should exist for action=" + action, rel);
            assertTrue("node must be a MetaRelationship", rel instanceof MetaRelationship);
            assertEquals("getOnUpdateRaw() should return '" + action + "'",
                    action, ((MetaRelationship) rel).getOnUpdateRaw());
        }
    }

    // -----------------------------------------------------------------------
    // 6 — Both attrs on same node round-trip
    // -----------------------------------------------------------------------

    @Test
    public void onDeleteAndOnUpdateBothRoundTrip() {
        String json = entityWithRelationship(
            "{ \"relationship.composition\": { \"name\": \"sections\","
            + " \"@targetObject\": \"Section\","
            + " \"@onDelete\": \"cascade\","
            + " \"@onUpdate\": \"no-action\" } }");
        MetaDataLoader loader = loadThrough(json, "both-attrs-roundtrip.json");

        MetaData order = loader.getRoot().getChildOfType("object", "acme::Order");
        assertNotNull(order);
        MetaData rel = order.getChildOfType(MetaRelationship.TYPE_RELATIONSHIP, "acme::sections");
        assertNotNull(rel);
        assertTrue(rel instanceof MetaRelationship);
        MetaRelationship metaRel = (MetaRelationship) rel;

        assertEquals("@onDelete should round-trip as cascade",   "cascade",   metaRel.getOnDeleteRaw());
        assertEquals("@onUpdate should round-trip as no-action", "no-action", metaRel.getOnUpdateRaw());
    }

    // -----------------------------------------------------------------------
    // 7 — Invalid @onDelete value → ERR_BAD_ATTR_VALUE
    // -----------------------------------------------------------------------

    @Test
    public void invalidOnDeleteValueRaisesError() {
        String json = entityWithRelationship(
            "{ \"relationship.composition\": { \"name\": \"items\","
            + " \"@targetObject\": \"Item\", \"@onDelete\": \"setDefault\" } }");
        try {
            loadThrough(json, "onDelete-invalid.json");
            fail("Expected MetaDataException for invalid @onDelete value 'setDefault'");
        } catch (MetaDataException e) {
            boolean hasCode = e.getCode()
                .map(c -> c == ErrorCode.ERR_BAD_ATTR_VALUE)
                .orElse(false);
            boolean hasMsg = e.getMessage() != null
                && e.getMessage().contains("ERR_BAD_ATTR_VALUE");
            assertTrue("Exception must signal ERR_BAD_ATTR_VALUE (via code or message): "
                    + e.getMessage(), hasCode || hasMsg);
        }
    }

    @Test
    public void invalidOnDeleteValueBogusRaisesError() {
        String json = entityWithRelationship(
            "{ \"relationship.association\": { \"name\": \"customer\","
            + " \"@targetObject\": \"Customer\", \"@onDelete\": \"bogus\" } }");
        try {
            loadThrough(json, "onDelete-bogus.json");
            fail("Expected MetaDataException for invalid @onDelete value 'bogus'");
        } catch (MetaDataException e) {
            boolean hasCode = e.getCode()
                .map(c -> c == ErrorCode.ERR_BAD_ATTR_VALUE)
                .orElse(false);
            boolean hasMsg = e.getMessage() != null
                && e.getMessage().contains("ERR_BAD_ATTR_VALUE");
            assertTrue("Exception must signal ERR_BAD_ATTR_VALUE (via code or message): "
                    + e.getMessage(), hasCode || hasMsg);
        }
    }

    // -----------------------------------------------------------------------
    // 8 — Invalid @onUpdate value → ERR_BAD_ATTR_VALUE
    // -----------------------------------------------------------------------

    @Test
    public void invalidOnUpdateValueRaisesError() {
        String json = entityWithRelationship(
            "{ \"relationship.aggregation\": { \"name\": \"members\","
            + " \"@targetObject\": \"Member\", \"@onUpdate\": \"setDefault\" } }");
        try {
            loadThrough(json, "onUpdate-invalid.json");
            fail("Expected MetaDataException for invalid @onUpdate value 'setDefault'");
        } catch (MetaDataException e) {
            boolean hasCode = e.getCode()
                .map(c -> c == ErrorCode.ERR_BAD_ATTR_VALUE)
                .orElse(false);
            boolean hasMsg = e.getMessage() != null
                && e.getMessage().contains("ERR_BAD_ATTR_VALUE");
            assertTrue("Exception must signal ERR_BAD_ATTR_VALUE (via code or message): "
                    + e.getMessage(), hasCode || hasMsg);
        }
    }

    @Test
    public void invalidOnUpdateValueBogusRaisesError() {
        String json = entityWithRelationship(
            "{ \"relationship.composition\": { \"name\": \"sections\","
            + " \"@targetObject\": \"Section\", \"@onUpdate\": \"DELETE\" } }");
        try {
            loadThrough(json, "onUpdate-bogus.json");
            fail("Expected MetaDataException for invalid @onUpdate value 'DELETE'");
        } catch (MetaDataException e) {
            boolean hasCode = e.getCode()
                .map(c -> c == ErrorCode.ERR_BAD_ATTR_VALUE)
                .orElse(false);
            boolean hasMsg = e.getMessage() != null
                && e.getMessage().contains("ERR_BAD_ATTR_VALUE");
            assertTrue("Exception must signal ERR_BAD_ATTR_VALUE (via code or message): "
                    + e.getMessage(), hasCode || hasMsg);
        }
    }

    // -----------------------------------------------------------------------
    // 9 — Absent attrs are fine (no validation error)
    // -----------------------------------------------------------------------

    @Test
    public void absentReferentialAttrsAreValid() {
        // No @onDelete / @onUpdate — should load cleanly and return nulls.
        String json = entityWithRelationship(
            "{ \"relationship.composition\": { \"name\": \"items\","
            + " \"@targetObject\": \"Item\" } }");
        MetaDataLoader loader = loadThrough(json, "no-referential-attrs.json");

        MetaData order = loader.getRoot().getChildOfType("object", "acme::Order");
        assertNotNull(order);
        MetaData rel = order.getChildOfType(MetaRelationship.TYPE_RELATIONSHIP, "acme::items");
        assertNotNull(rel);
        assertTrue(rel instanceof MetaRelationship);
        MetaRelationship metaRel = (MetaRelationship) rel;

        assertNull("getOnDeleteRaw() should be null when absent", metaRel.getOnDeleteRaw());
        assertNull("getOnUpdateRaw() should be null when absent", metaRel.getOnUpdateRaw());
    }
}

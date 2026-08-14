package com.metaobjects.requirement;

import com.metaobjects.ErrorCode;
import com.metaobjects.MetaData;
import com.metaobjects.MetaDataException;
import com.metaobjects.MetaRoot;
import com.metaobjects.loader.InMemoryStringSource;
import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.registry.SharedRegistryTestBase;
import org.junit.Test;

import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

/**
 * Tests for the {@code requirement.*} types (the capability ledger as registered
 * metamodel vocabulary — requirements-as-metadata ruling, Amendment 3).
 *
 * <p>Covers:
 * <ol>
 *   <li>A {@code requirement.functional} loads at the DOCUMENT ROOT with its
 *       required attrs, and its resolving accessors read back.</li>
 *   <li>Hierarchy is NESTING — a {@code requirement.functional} admits nested
 *       {@code requirement} children to arbitrary depth.</li>
 *   <li>A {@code requirement.architectural} loads (no {@code @level}).</li>
 *   <li>A typo'd {@code @status} is refused by the LOADER, not by a hand-written
 *       string comparison — the point of registering the ledger.</li>
 *   <li>An unregistered attr on a requirement is {@code ERR_UNKNOWN_ATTR} in strict mode.</li>
 * </ol>
 * </p>
 */
public class RequirementTest extends SharedRegistryTestBase {

    // ---------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------

    private MetaDataLoader strictLoader(String name) {
        MetaDataLoader loader = new MetaDataLoader(
                LoaderOptions.create(false, false, true),
                MetaDataLoader.SUBTYPE_MANUAL, name);
        loader.setSourceURIs(java.util.Collections.emptyList());
        loader.init();
        return loader;
    }

    private MetaRoot load(MetaDataLoader loader, String json) {
        loader.load(List.of(new InMemoryStringSource(json, "test.json")));
        return loader.getRoot();
    }

    private static MetaRequirement firstRequirement(MetaData parent) {
        for (MetaData child : parent.getChildren(MetaData.class, false)) {
            if (child instanceof MetaRequirement) {
                return (MetaRequirement) child;
            }
        }
        return null;
    }

    // ---------------------------------------------------------------------------
    // (1) requirement.functional loads at the document root
    // ---------------------------------------------------------------------------

    @Test
    public void functionalRequirement_basicLoad_succeeds() {
        String json = "{ \"metadata.root\": { \"package\": \"acme::test\", \"children\": ["
            + "  { \"requirement.functional\": { \"name\": \"orderPlacement\","
            + "      \"@level\": 4,"
            + "      \"@status\": \"live\","
            + "      \"@statement\": \"A shopper can place an order.\","
            + "      \"@violation\": \"An order cannot be created through any surface.\","
            + "      \"@implementedBy\": [\"acme::shop::Order\"],"
            + "      \"@verifiedBy\": [\"OrderRoutesTest#placesAnOrder\"] } }"
            + "] } }";

        MetaDataLoader loader = strictLoader("test-requirement-functional");
        MetaRoot root = load(loader, json);

        assertTrue("No load errors: " + loader.getErrors(), loader.getErrors().isEmpty());

        MetaRequirement req = firstRequirement(root);
        assertNotNull("requirement.functional child found", req);
        assertEquals(MetaRequirement.TYPE_REQUIREMENT, req.getType());
        assertEquals(MetaRequirement.SUBTYPE_FUNCTIONAL, req.getSubType());
        assertTrue("isFunctional()", req.isFunctional());
        assertEquals(Integer.valueOf(4), req.getLevel());
        assertEquals(MetaRequirement.STATUS_LIVE, req.getStatus());
        assertEquals("A shopper can place an order.", req.getStatement());
        assertEquals(List.of("acme::shop::Order"), req.getImplementedBy());
        assertEquals(List.of("OrderRoutesTest#placesAnOrder"), req.getVerifiedBy());
        assertTrue("L4 is at the link floor", req.mayReferenceModel());
        assertTrue("live requires live nodes", req.requiresLiveNodes());
    }

    // ---------------------------------------------------------------------------
    // (2) Hierarchy IS nesting — nested requirement children
    // ---------------------------------------------------------------------------

    @Test
    public void functionalRequirement_nestsChildRequirements() {
        String json = "{ \"metadata.root\": { \"package\": \"acme::test\", \"children\": ["
            + "  { \"requirement.functional\": { \"name\": \"shop\","
            + "      \"@level\": 1,"
            + "      \"@status\": \"live\","
            + "      \"@statement\": \"The shop sells things.\","
            + "      \"@violation\": \"Nothing can be bought.\","
            + "      \"children\": ["
            + "        { \"requirement.functional\": { \"name\": \"checkout\","
            + "            \"@level\": 2,"
            + "            \"@status\": \"partial\","
            + "            \"@statement\": \"A shopper can check out.\","
            + "            \"@violation\": \"Checkout cannot complete.\","
            + "            \"children\": ["
            + "              { \"requirement.functional\": { \"name\": \"payment\","
            + "                  \"@level\": 3,"
            + "                  \"@status\": \"live\","
            + "                  \"@statement\": \"A shopper can pay.\","
            + "                  \"@violation\": \"No payment can be taken.\" } }"
            + "            ] } }"
            + "      ] } }"
            + "] } }";

        MetaDataLoader loader = strictLoader("test-requirement-nesting");
        MetaRoot root = load(loader, json);

        assertTrue("No load errors: " + loader.getErrors(), loader.getErrors().isEmpty());

        MetaRequirement l1 = firstRequirement(root);
        assertNotNull("L1 requirement found", l1);
        assertEquals(Integer.valueOf(1), l1.getLevel());

        MetaRequirement l2 = firstRequirement(l1);
        assertNotNull("nested L2 requirement found", l2);
        assertEquals(Integer.valueOf(2), l2.getLevel());

        MetaRequirement l3 = firstRequirement(l2);
        assertNotNull("nested L3 requirement found", l3);
        assertEquals(Integer.valueOf(3), l3.getLevel());
        assertEquals(1, l2.getChildRequirements().size());
    }

    // ---------------------------------------------------------------------------
    // (3) requirement.architectural loads (level-less by definition)
    // ---------------------------------------------------------------------------

    @Test
    public void architecturalRequirement_basicLoad_succeeds() {
        String json = "{ \"metadata.root\": { \"package\": \"acme::test\", \"children\": ["
            + "  { \"requirement.architectural\": { \"name\": \"uuidPrimaryKeys\","
            + "      \"@status\": \"live\","
            + "      \"@statement\": \"Every entity has a uuid primary key.\","
            + "      \"@violation\": \"An entity with a composite string key.\","
            + "      \"@implementedBy\": [\"acme::shop::Order\", \"acme::shop::Customer\"] } }"
            + "] } }";

        MetaDataLoader loader = strictLoader("test-requirement-architectural");
        MetaRoot root = load(loader, json);

        assertTrue("No load errors: " + loader.getErrors(), loader.getErrors().isEmpty());

        MetaRequirement req = firstRequirement(root);
        assertNotNull("requirement.architectural child found", req);
        assertEquals(MetaRequirement.SUBTYPE_ARCHITECTURAL, req.getSubType());
        assertTrue("isArchitectural()", req.isArchitectural());
        assertEquals("a FLAT architectural node carries no level", null, req.getLevel());
        assertEquals(List.of("acme::shop::Order", "acme::shop::Customer"), req.getImplementedBy());
        assertTrue("architectural may always reference the model", req.mayReferenceModel());
    }

    // ---------------------------------------------------------------------------
    // (3b) requirement.architectural DOES nest -- it declares the same
    //      nested-requirement child rule as functional.
    //
    //      This test previously asserted the opposite, on the reasoning that an
    //      architectural requirement is object-independent and so has no tier to
    //      contain. That reasoning holds for a FLAT policy and stopped being the
    //      whole story when `@level` became optional on architectural: levelling
    //      is opt-in so a quality taxonomy (an ISO/IEC 25010 characteristic at
    //      L1, its sub-characteristic at L2) can organise the non-functional set
    //      the same way a capability taxonomy organises the functional one.
    //      Declaring the child rule on `functional` only made an architectural
    //      node nestable under a FUNCTIONAL parent but never under another
    //      architectural one -- an omission rather than a design.
    // ---------------------------------------------------------------------------

    @Test
    public void architecturalRequirement_nests() {
        String json = "{ \"metadata.root\": { \"package\": \"acme::test\", \"children\": ["
            + "  { \"requirement.architectural\": { \"name\": \"uuidPrimaryKeys\","
            + "      \"@status\": \"live\","
            + "      \"@statement\": \"Every entity has a uuid primary key.\","
            + "      \"@violation\": \"An entity with a composite string key.\","
            + "      \"children\": ["
            + "        { \"requirement.functional\": { \"name\": \"nested\","
            + "            \"@level\": 4,"
            + "            \"@status\": \"live\","
            + "            \"@statement\": \"A capability.\","
            + "            \"@violation\": \"It is gone.\" } }"
            + "      ] } }"
            + "] } }";

        MetaDataLoader loader = strictLoader("test-requirement-architectural-nesting");
        MetaRoot root = load(loader, json);

        String messages = loader.getErrors().stream()
            .map(Throwable::getMessage).reduce("", (a, b) -> a + " | " + b);
        assertTrue("a nested requirement loads clean under architectural; messages=" + messages,
            loader.getErrors().isEmpty());

        MetaRequirement req = firstRequirement(root);
        assertNotNull("requirement.architectural child found", req);
        assertEquals(1, req.getChildren().stream()
            .filter(c -> MetaRequirement.TYPE_REQUIREMENT.equals(c.getType())).count());
    }

    // ---------------------------------------------------------------------------
    // (3c) A LEVELLED architectural tree -- the shape the optional @level exists
    //      for, and the one that was inexpressible while only `functional`
    //      declared the nested-requirement child rule.
    // ---------------------------------------------------------------------------

    @Test
    public void architecturalRequirement_levelledTreeLoads() {
        String json = "{ \"metadata.root\": { \"package\": \"acme::test\", \"children\": ["
            + "  { \"requirement.architectural\": { \"name\": \"security\","
            + "      \"@level\": 1,"
            + "      \"@status\": \"live\","
            + "      \"@statement\": \"The system protects the data it holds.\","
            + "      \"@violation\": \"A record readable by someone with no claim to it.\","
            + "      \"children\": ["
            + "        { \"requirement.architectural\": { \"name\": \"integrity\","
            + "            \"@level\": 2,"
            + "            \"@status\": \"partial\","
            + "            \"@disposition\": \"deferred\","
            + "            \"@trackedBy\": [\"acme/platform#412\"],"
            + "            \"@statement\": \"A stored value changes only under control.\","
            + "            \"@violation\": \"A number that changed with nothing explaining it.\","
            + "            \"children\": ["
            + "              { \"requirement.architectural\": { \"name\": \"ordersAreAppendOnly\","
            + "                  \"@level\": 4,"
            + "                  \"@status\": \"live\","
            + "                  \"@statement\": \"An order row is appended, never mutated.\","
            + "                  \"@violation\": \"An order total edited in place.\","
            + "                  \"@implementedBy\": [\"acme::shop::Order\"] } }"
            + "            ] } }"
            + "      ] } }"
            + "] } }";

        MetaDataLoader loader = strictLoader("test-requirement-architectural-levelled");
        MetaRoot root = load(loader, json);

        String messages = loader.getErrors().stream()
            .map(Throwable::getMessage).reduce("", (a, b) -> a + " | " + b);
        assertTrue("a levelled architectural tree loads clean; messages=" + messages,
            loader.getErrors().isEmpty());

        MetaRequirement l1 = firstRequirement(root);
        assertNotNull("L1 architectural found", l1);
        assertEquals(Integer.valueOf(1), l1.getLevel());
        // An organisational tier may not reference the model, on either subtype,
        // once it has opted into a tree by carrying a level.
        assertTrue("L1 is organisational", !l1.mayReferenceModel());

        MetaRequirement l2 = (MetaRequirement) l1.getChildren().stream()
            .filter(c -> c instanceof MetaRequirement).findFirst().orElseThrow();
        assertEquals("deferred", l2.getDisposition());
        assertEquals(List.of("acme/platform#412"), l2.getTrackedBy());
        assertTrue("partial has outstanding work", l2.hasOutstandingWork());

        MetaRequirement l4 = (MetaRequirement) l2.getChildren().stream()
            .filter(c -> c instanceof MetaRequirement).findFirst().orElseThrow();
        assertTrue("the link floor may reference the model", l4.mayReferenceModel());
        assertEquals(List.of("acme::shop::Order"), l4.getImplementedBy());
    }

    // ---------------------------------------------------------------------------
    // (4) A typo'd @status is refused by the LOADER
    // ---------------------------------------------------------------------------

    @Test
    public void requirement_badStatus_rejected() {
        String json = "{ \"metadata.root\": { \"package\": \"acme::test\", \"children\": ["
            + "  { \"requirement.functional\": { \"name\": \"typo\","
            + "      \"@level\": 4,"
            + "      \"@status\": \"abandonned\","
            + "      \"@statement\": \"A capability.\","
            + "      \"@violation\": \"It is gone.\" } }"
            + "] } }";

        MetaDataLoader loader = strictLoader("test-requirement-bad-status");
        MetaDataException caught = null;
        try {
            load(loader, json);
        } catch (MetaDataException e) {
            caught = e;
        }

        String messages = loader.getErrors().stream()
            .map(Throwable::getMessage).reduce("", (a, b) -> a + " " + b);
        if (caught != null) {
            messages += " " + caught.getMessage();
        }
        boolean rejected = caught != null || !loader.getErrors().isEmpty();
        assertTrue("a typo'd @status must be refused by the loader; messages=" + messages, rejected);
        assertTrue("the error names the offending value; messages=" + messages,
            messages.contains("abandonned"));
    }

    // ---------------------------------------------------------------------------
    // (5) An unregistered attr on a requirement is ERR_UNKNOWN_ATTR (strict)
    // ---------------------------------------------------------------------------

    @Test
    public void requirement_unknownAttr_rejected_strict() {
        String json = "{ \"metadata.root\": { \"package\": \"acme::test\", \"children\": ["
            + "  { \"requirement.functional\": { \"name\": \"stray\","
            + "      \"@level\": 4,"
            + "      \"@status\": \"live\","
            + "      \"@statement\": \"A capability.\","
            + "      \"@violation\": \"It is gone.\","
            + "      \"@parent\": \"somethingElse\" } }"
            + "] } }";

        MetaDataLoader loader = strictLoader("test-requirement-unknown-attr");
        try {
            load(loader, json);
            boolean hasUnknownAttr = loader.getErrors().stream()
                .anyMatch(e -> e.getCode().map(c -> c == ErrorCode.ERR_UNKNOWN_ATTR).orElse(false));
            assertTrue("ERR_UNKNOWN_ATTR for @parent on requirement.functional "
                + "(hierarchy is nesting, not a parent attr): " + loader.getErrors(), hasUnknownAttr);
        } catch (MetaDataException e) {
            assertEquals("ERR_UNKNOWN_ATTR thrown for @parent on requirement.functional",
                ErrorCode.ERR_UNKNOWN_ATTR, e.getCode().orElse(null));
        }
    }
}

package com.metaobjects.field;

import com.metaobjects.ErrorCode;
import com.metaobjects.MetaDataException;
import com.metaobjects.loader.InMemoryStringSource;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.registry.SharedRegistryTestBase;
import org.junit.Test;

import java.util.Collections;
import java.util.List;

import static org.junit.Assert.*;

/**
 * Tests for {@code field.enum}'s optional {@code @intValueMap} attribute — an
 * explicit per-member integer value map ({@code {member: int}}) that switches the
 * field's DB persistence from string+CHECK to integer+CHECK.
 *
 * <p>Cross-language contract (mirrors the TS/C# ports): {@code attr.intMap}
 * (Java: {@link com.metaobjects.attr.IntMapAttribute}) is a generic object-shaped
 * attribute whose values must all be integers; {@code field.enum} layers its own
 * semantic rules on top (key-set exactly equals {@code @values}, no duplicate int
 * values) — both enforced via {@code ERR_BAD_ATTR_VALUE}, no new error code.</p>
 */
public class EnumFieldIntValueMapTest extends SharedRegistryTestBase {

    // -----------------------------------------------------------------------
    // Helpers — mirrors EnumFieldTest's loading idiom exactly.
    // -----------------------------------------------------------------------

    private MetaDataLoader newTestLoader() {
        return createTestLoader("EnumFieldIntValueMapTest", Collections.emptyList());
    }

    private MetaDataLoader loadThrough(String canonical, String id) {
        MetaDataLoader loader = newTestLoader();
        loader.load(List.of(new InMemoryStringSource(canonical, id)));
        return loader;
    }

    private static String model(String extra) {
        return "{ \"metadata.root\": { \"package\": \"acme\", \"children\": [" +
            "{ \"object.entity\": { \"name\": \"Order\", \"children\": [" +
            "{ \"field.long\": { \"name\": \"id\" } }," +
            "{ \"field.enum\": { \"name\": \"status\", \"@values\": [\"DRAFT\",\"PUBLISHED\",\"ARCHIVED\"]" + extra + " } }," +
            "{ \"identity.primary\": { \"@fields\": \"id\" } }" +
            "]}}]}}";
    }

    private MetaDataException loadExpectingError(String json, String id) {
        try {
            loadThrough(json, id);
            fail("Expected MetaDataException");
            throw new AssertionError("unreachable");
        } catch (MetaDataException e) {
            return e;
        }
    }

    // -----------------------------------------------------------------------
    // Tests
    // -----------------------------------------------------------------------

    @Test
    public void validIntValueMapWithMatchingKeysAndUniqueIntsLoadsClean() {
        loadThrough(
            model(", \"@intValueMap\": {\"DRAFT\": 0, \"PUBLISHED\": 5, \"ARCHIVED\": 9}"),
            "intvaluemap-valid-test.json");
        // No exception — success is the assertion.
    }

    @Test
    public void noIntValueMapStillLoadsCleanStringBackedDefault() {
        loadThrough(model(""), "intvaluemap-absent-test.json");
        // No exception — success is the assertion.
    }

    @Test
    public void missingMemberKeyIsRejected() {
        MetaDataException ex = loadExpectingError(
            model(", \"@intValueMap\": {\"DRAFT\": 0, \"PUBLISHED\": 5}"),
            "intvaluemap-missing-member-test.json");
        assertEquals(ErrorCode.ERR_BAD_ATTR_VALUE, ex.getCode().orElseThrow());
        assertTrue(ex.getMessage().contains("ARCHIVED"));
    }

    @Test
    public void extraKeyNotInValuesIsRejected() {
        MetaDataException ex = loadExpectingError(
            model(", \"@intValueMap\": {\"DRAFT\": 0, \"PUBLISHED\": 5, \"ARCHIVED\": 9, \"RETRACTED\": 12}"),
            "intvaluemap-extra-key-test.json");
        assertEquals(ErrorCode.ERR_BAD_ATTR_VALUE, ex.getCode().orElseThrow());
        assertTrue(ex.getMessage().contains("RETRACTED"));
    }

    @Test
    public void nonIntegerValueIsRejected() {
        MetaDataException ex = loadExpectingError(
            model(", \"@intValueMap\": {\"DRAFT\": \"zero\", \"PUBLISHED\": 5, \"ARCHIVED\": 9}"),
            "intvaluemap-non-integer-test.json");
        assertEquals(ErrorCode.ERR_BAD_ATTR_VALUE, ex.getCode().orElseThrow());
    }

    @Test
    public void duplicateIntValueAcrossMembersIsRejected() {
        MetaDataException ex = loadExpectingError(
            model(", \"@intValueMap\": {\"DRAFT\": 0, \"PUBLISHED\": 0, \"ARCHIVED\": 9}"),
            "intvaluemap-duplicate-test.json");
        assertEquals(ErrorCode.ERR_BAD_ATTR_VALUE, ex.getCode().orElseThrow());
        assertTrue(ex.getMessage().contains("DRAFT") && ex.getMessage().contains("PUBLISHED"));
    }
}

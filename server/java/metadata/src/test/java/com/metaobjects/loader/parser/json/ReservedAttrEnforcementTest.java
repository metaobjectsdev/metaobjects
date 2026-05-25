package com.metaobjects.loader.parser.json;

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
 * Tests that the canonical JSON parser enforces {@code ERR_RESERVED_ATTR}:
 * a structural keyword ({@code name}, {@code package}, {@code extends},
 * {@code abstract}, {@code overlay}, {@code isArray}, {@code children},
 * {@code value}) must be written bare — never as an {@code @}-prefixed
 * attribute.
 *
 * <p>Mirrors ADR-0006 §D1 and the TypeScript {@code parser-core.ts}
 * {@code applyInlineAttrsAndUnknownKeys} enforcement path.</p>
 */
public class ReservedAttrEnforcementTest extends SharedRegistryTestBase {

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    private MetaDataLoader newTestLoader() {
        return createTestLoader("ReservedAttrEnforcement", Collections.emptyList());
    }

    /**
     * Load the given canonical JSON string through the full loader pipeline.
     * Propagates any {@link MetaDataException} thrown during parse or validation.
     */
    private void loadThrough(String canonical, String id) {
        MetaDataLoader loader = newTestLoader();
        loader.load(List.of(new InMemoryStringSource(canonical, id)));
    }

    /**
     * Minimal entity wrapper with a single child node (the string to inject).
     */
    private String entityWith(String childNodeJson) {
        return "{ \"metadata.root\": { \"package\": \"acme\", \"children\": ["
            + "  { \"object.entity\": { \"name\": \"Widget\", \"children\": ["
            + "    { \"field.long\": { \"name\": \"id\" } },"
            + "    " + childNodeJson + ","
            + "    { \"identity.primary\": { \"@fields\": \"id\" } }"
            + "  ] } }"
            + "] } }";
    }

    /**
     * Assert that loading {@code canonical} throws a {@link MetaDataException}
     * with {@link ErrorCode#ERR_RESERVED_ATTR} (either via the structured code
     * field or the embedded message string — mirrors the MetaSourceTest pattern).
     */
    private void assertReservedAttrError(String canonical, String id, String reserved) {
        try {
            loadThrough(canonical, id);
            fail("Expected MetaDataException (ERR_RESERVED_ATTR) for @" + reserved + ", but no exception was thrown");
        } catch (MetaDataException e) {
            boolean hasCode = e.getCode()
                .map(c -> c == ErrorCode.ERR_RESERVED_ATTR)
                .orElse(false);
            boolean hasMsg = e.getMessage() != null
                && e.getMessage().contains("ERR_RESERVED_ATTR");
            assertTrue(
                "Exception must signal ERR_RESERVED_ATTR (via code or message) for @" + reserved
                    + "; actual message: " + e.getMessage(),
                hasCode || hasMsg);
        }
    }

    // -----------------------------------------------------------------------
    // 1 — @isArray on a field.object → ERR_RESERVED_ATTR
    // -----------------------------------------------------------------------

    @Test
    public void atIsArrayOnFieldObjectRaisesReservedAttrError() {
        // @isArray is the @-prefixed form of the reserved structural key "isArray"
        String canonical = entityWith(
            "{ \"field.string\": { \"name\": \"tag\", \"@isArray\": true } }");
        assertReservedAttrError(canonical, "reserved-isArray-test.json", "isArray");
    }

    // -----------------------------------------------------------------------
    // 2 — @name on a field → ERR_RESERVED_ATTR
    // -----------------------------------------------------------------------

    @Test
    public void atNameOnFieldRaisesReservedAttrError() {
        // "name" is a reserved structural key; @name must be rejected
        String canonical = entityWith(
            "{ \"field.string\": { \"name\": \"label\", \"@name\": \"bad\" } }");
        assertReservedAttrError(canonical, "reserved-name-test.json", "name");
    }

    // -----------------------------------------------------------------------
    // 3 — @package on a field → ERR_RESERVED_ATTR
    // -----------------------------------------------------------------------

    @Test
    public void atPackageOnFieldRaisesReservedAttrError() {
        String canonical = entityWith(
            "{ \"field.string\": { \"name\": \"code\", \"@package\": \"acme\" } }");
        assertReservedAttrError(canonical, "reserved-package-test.json", "package");
    }

    // -----------------------------------------------------------------------
    // 4 — @children on a field → ERR_RESERVED_ATTR
    // -----------------------------------------------------------------------

    @Test
    public void atChildrenOnFieldRaisesReservedAttrError() {
        String canonical = entityWith(
            "{ \"field.string\": { \"name\": \"notes\", \"@children\": [] } }");
        assertReservedAttrError(canonical, "reserved-children-test.json", "children");
    }

    // -----------------------------------------------------------------------
    // 5 — @extends on a field → ERR_RESERVED_ATTR
    // -----------------------------------------------------------------------

    @Test
    public void atExtendsOnFieldRaisesReservedAttrError() {
        String canonical = entityWith(
            "{ \"field.string\": { \"name\": \"code\", \"@extends\": \"Base\" } }");
        assertReservedAttrError(canonical, "reserved-extends-test.json", "extends");
    }

    // -----------------------------------------------------------------------
    // 6 — @abstract on a field → ERR_RESERVED_ATTR
    // -----------------------------------------------------------------------

    @Test
    public void atAbstractOnFieldRaisesReservedAttrError() {
        String canonical = entityWith(
            "{ \"field.string\": { \"name\": \"code\", \"@abstract\": true } }");
        assertReservedAttrError(canonical, "reserved-abstract-test.json", "abstract");
    }

    // -----------------------------------------------------------------------
    // 7 — @overlay on a field → ERR_RESERVED_ATTR
    // -----------------------------------------------------------------------

    @Test
    public void atOverlayOnFieldRaisesReservedAttrError() {
        String canonical = entityWith(
            "{ \"field.string\": { \"name\": \"code\", \"@overlay\": true } }");
        assertReservedAttrError(canonical, "reserved-overlay-test.json", "overlay");
    }

    // -----------------------------------------------------------------------
    // 8 — @value on a field → ERR_RESERVED_ATTR
    // -----------------------------------------------------------------------

    @Test
    public void atValueOnFieldRaisesReservedAttrError() {
        String canonical = entityWith(
            "{ \"field.string\": { \"name\": \"code\", \"@value\": \"x\" } }");
        assertReservedAttrError(canonical, "reserved-value-test.json", "value");
    }

    // -----------------------------------------------------------------------
    // 9 — BARE isArray: true on a field.string → no ERR_RESERVED_ATTR (accepted)
    // -----------------------------------------------------------------------

    @Test
    public void bareIsArrayOnFieldStringIsAccepted() {
        // Structural keys written bare are valid — the parser handles them before attrs
        String canonical = entityWith(
            "{ \"field.string\": { \"name\": \"tags\", \"isArray\": true } }");
        // Should load without error
        loadThrough(canonical, "bare-isArray-test.json");
    }

    // -----------------------------------------------------------------------
    // 10 — Normal @maxLength on field.string → no ERR_RESERVED_ATTR
    // -----------------------------------------------------------------------

    @Test
    public void normalAttrMaxLengthIsAccepted() {
        String canonical = entityWith(
            "{ \"field.string\": { \"name\": \"code\", \"@maxLength\": 64 } }");
        // Should load without error
        loadThrough(canonical, "normal-maxLength-test.json");
    }

    // -----------------------------------------------------------------------
    // 11 — Normal @objectRef on field.object → no ERR_RESERVED_ATTR
    // -----------------------------------------------------------------------

    @Test
    public void normalAttrObjectRefIsAccepted() {
        // Provide a minimal entity for the ref target in the same document
        String canonical =
            "{ \"metadata.root\": { \"package\": \"acme\", \"children\": ["
            + "  { \"object.entity\": { \"name\": \"Address\", \"children\": ["
            + "    { \"field.long\": { \"name\": \"id\" } },"
            + "    { \"identity.primary\": { \"@fields\": \"id\" } }"
            + "  ] } },"
            + "  { \"object.entity\": { \"name\": \"Widget\", \"children\": ["
            + "    { \"field.long\": { \"name\": \"id\" } },"
            + "    { \"field.object\": { \"name\": \"address\", \"@objectRef\": \"acme::Address\" } },"
            + "    { \"identity.primary\": { \"@fields\": \"id\" } }"
            + "  ] } }"
            + "] } }";
        // Should load without error
        loadThrough(canonical, "normal-objectRef-test.json");
    }
}

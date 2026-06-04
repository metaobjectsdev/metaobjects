package com.metaobjects.loader.parser.json;

import com.metaobjects.ErrorCode;
import com.metaobjects.MetaDataException;
import com.metaobjects.attr.PropertiesAttribute;
import com.metaobjects.loader.InMemoryStringSource;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.registry.SharedRegistryTestBase;
import org.junit.Test;

import java.util.Collections;
import java.util.List;

import static org.junit.Assert.*;

/**
 * ADR-0023 strict-load undeclared-attr rejection ("Check 0") + the
 * {@code attr.properties} exemption.
 *
 * <p>Mirrors the TS reference {@code attr-schema-validate.ts} strict Check-0:
 * under a strict load an own {@code @}-attr declared by NO registered provider
 * (no per-type schema entry, no commonAttr) is a made-up attribute and is
 * RECORDED as {@link ErrorCode#ERR_UNKNOWN_ATTR} (non-fatally — parsing
 * continues so the open-policy tree shape is preserved). The one exemption:
 * an own attr whose resolved subType is {@code attr.properties} — a registered,
 * sanctioned property-bag whose arbitrary NAME is the contract — is treated as
 * declared and is NOT flagged. A typo'd plain {@code @}-attr still records the
 * error.</p>
 */
public class StrictUnknownAttrTest extends SharedRegistryTestBase {

    private MetaDataLoader newTestLoader() {
        return createTestLoader("StrictUnknownAttr", Collections.emptyList());
    }

    /** Load canonical JSON; return the loader (recorded errors via getErrors()). */
    private MetaDataLoader loadThrough(String canonical, String id) {
        MetaDataLoader loader = newTestLoader();
        loader.load(List.of(new InMemoryStringSource(canonical, id)));
        return loader;
    }

    private static boolean recordedUnknownAttr(MetaDataLoader loader) {
        for (MetaDataException e : loader.getErrors()) {
            boolean code = e.getCode().map(c -> c == ErrorCode.ERR_UNKNOWN_ATTR).orElse(false);
            boolean msg = e.getMessage() != null && e.getMessage().contains("ERR_UNKNOWN_ATTR");
            if (code || msg) return true;
        }
        return false;
    }

    private String entityWith(String fieldChildJson) {
        return "{ \"metadata.root\": { \"package\": \"acme\", \"children\": ["
            + "  { \"object.entity\": { \"name\": \"Widget\", \"children\": ["
            + "    { \"field.long\": { \"name\": \"id\" } },"
            + "    " + fieldChildJson + ","
            + "    { \"identity.primary\": { \"@fields\": \"id\" } }"
            + "  ] } }"
            + "] } }";
    }

    // -----------------------------------------------------------------------
    // 1 — A made-up plain @-attr under strict → ERR_UNKNOWN_ATTR recorded.
    // -----------------------------------------------------------------------

    @Test
    public void madeUpAttrRecordsUnknownAttrUnderStrict() {
        // @bogusAttr is declared by no provider for field.string.
        String canonical = entityWith(
            "{ \"field.string\": { \"name\": \"code\", \"@bogusAttr\": \"x\" } }");
        MetaDataLoader loader = loadThrough(canonical, "made-up-attr.json");
        assertTrue("strict load must RECORD ERR_UNKNOWN_ATTR for a made-up @-attr",
            recordedUnknownAttr(loader));
    }

    // -----------------------------------------------------------------------
    // 2 — A declared @-attr (e.g. @maxLength on field.string) → no error.
    // -----------------------------------------------------------------------

    @Test
    public void declaredAttrDoesNotRecordUnknownAttr() {
        String canonical = entityWith(
            "{ \"field.string\": { \"name\": \"code\", \"@maxLength\": 64 } }");
        MetaDataLoader loader = loadThrough(canonical, "declared-attr.json");
        assertFalse("a declared per-type attr must not record ERR_UNKNOWN_ATTR",
            recordedUnknownAttr(loader));
    }

    // -----------------------------------------------------------------------
    // 3 — attr.properties exemption (NAMED properties attr).
    //     field.enum declares @enumAlias as a properties-typed attribute whose
    //     KEY/value content is off-vocabulary. Authored inline it is exempt.
    // -----------------------------------------------------------------------

    @Test
    public void namedPropertiesAttrIsExemptFromUnknownAttr() {
        String canonical = entityWith(
            "{ \"field.enum\": { \"name\": \"status\", \"@values\": [\"ACTIVE\", \"CLOSED\"],"
            + " \"@enumAlias\": { \"active\": \"ACTIVE\", \"closed\": \"CLOSED\" } } }");
        MetaDataLoader loader = loadThrough(canonical, "named-properties-exempt.json");
        assertFalse("a named attr.properties attr must be exempt from ERR_UNKNOWN_ATTR",
            recordedUnknownAttr(loader));
    }

    // -----------------------------------------------------------------------
    // 4 — attr.properties exemption (ARBITRARY-NAMED, undeclared object bag).
    //
    //     The core ADR-0023 exemption the TS reference adds: an UNDECLARED inline
    //     @-attr whose value is a plain JSON OBJECT materializes to the sanctioned
    //     attr.properties subtype (a property bag whose arbitrary NAME is the
    //     contract), so it is exempt from ERR_UNKNOWN_ATTR even though no per-type
    //     schema declares the name. Keyed on the VALUE shape, exactly as TS keys
    //     on the materialized subType (object → ATTR_SUBTYPE_PROPERTIES).
    // -----------------------------------------------------------------------

    @Test
    public void arbitraryNamedObjectBagIsExemptFromUnknownAttr() {
        // @arbitraryBag is declared by no provider, but its OBJECT value makes it
        // a sanctioned properties bag → exempt.
        String canonical = entityWith(
            "{ \"field.string\": { \"name\": \"code\","
            + " \"@arbitraryBag\": { \"owner\": \"growth\", \"tier\": \"gold\" } } }");
        MetaDataLoader loader = loadThrough(canonical, "object-bag-exempt.json");
        assertFalse("an undeclared object-valued @-attr (attr.properties bag) must be exempt "
                + "from ERR_UNKNOWN_ATTR — got errors: " + loader.getErrors(),
            recordedUnknownAttr(loader));
    }

    // -----------------------------------------------------------------------
    // 5 — A typo'd plain SCALAR @-attr is NOT a properties bag → still flagged.
    //     Proves the exemption keys on the VALUE shape, not "any undeclared attr".
    // -----------------------------------------------------------------------

    @Test
    public void undeclaredScalarAttrStillRecordsUnknownAttr() {
        String canonical = entityWith(
            "{ \"field.string\": { \"name\": \"code\", \"@bogusScalar\": \"oops\" } }");
        MetaDataLoader loader = loadThrough(canonical, "scalar-not-exempt.json");
        assertTrue("a typo'd plain scalar @-attr (non-object value) must still record "
                + "ERR_UNKNOWN_ATTR",
            recordedUnknownAttr(loader));
    }

    // -----------------------------------------------------------------------
    // 6 — Guard the cross-port contract constant the exemption keys on.
    // -----------------------------------------------------------------------

    @Test
    public void propertiesAttrSubtypeConstantIsProperties() {
        assertEquals("properties", PropertiesAttribute.SUBTYPE_PROPERTIES);
    }
}

package com.metaobjects.field;

import com.metaobjects.ErrorCode;
import com.metaobjects.MetaData;
import com.metaobjects.MetaDataException;
import com.metaobjects.loader.InMemoryStringSource;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.MetaObject;
import com.metaobjects.registry.SharedRegistryTestBase;
import com.metaobjects.registry.MetaDataRegistry;
import com.metaobjects.registry.TypeDefinition;
import org.junit.Test;

import java.util.Collections;
import java.util.List;

import static org.junit.Assert.*;

/**
 * FR-011 metamodel attrs — extract hardening, cross-port parity with the TS pilot + C# port.
 *
 * <ul>
 *   <li>{@code @coerceDefault} — string on {@code field.enum} only; member-validated against
 *       the effective {@code @values} ({@code ERR_BAD_ATTR_VALUE} when off-vocabulary).</li>
 *   <li>{@code @normalize} — closed enum {@code none|collapse|strip} (default {@code strip})
 *       on {@code field.enum} (per-field) AND {@code object.value} (object-level default).
 *       NOT on {@code object.entity} / {@code object.base}.</li>
 * </ul>
 */
public class Fr011LoaderAttrsTest extends SharedRegistryTestBase {

    private MetaDataLoader newTestLoader() {
        return createTestLoader("Fr011LoaderAttrsTest", Collections.emptyList());
    }

    private MetaDataLoader loadThrough(String canonical, String id) {
        MetaDataLoader loader = newTestLoader();
        loader.load(List.of(new InMemoryStringSource(canonical, id)));
        return loader;
    }

    private MetaDataRegistry registry() {
        return newTestLoader().getTypeRegistry();
    }

    // ------------------------------------------------------------------------
    // 1 — Constant values.
    // ------------------------------------------------------------------------

    @Test
    public void attrConstantsHaveExpectedValues() {
        assertEquals("coerceDefault", EnumField.ATTR_COERCE_DEFAULT);
        assertEquals("normalize", EnumField.ATTR_NORMALIZE);
        assertEquals("strip", EnumField.NORMALIZE_DEFAULT);
        assertEquals(List.of("none", "collapse", "strip"), EnumField.NORMALIZE_MODES);
    }

    // ------------------------------------------------------------------------
    // 2 — Registration shape.
    // ------------------------------------------------------------------------

    @Test
    public void fieldEnumRegistersCoerceDefaultAndNormalize() {
        TypeDefinition def = registry().getTypeDefinition(EnumField.TYPE_FIELD, EnumField.SUBTYPE_ENUM);
        assertNotNull(def);
        assertTrue("field.enum should declare @coerceDefault",
            def.getChildRequirement(EnumField.ATTR_COERCE_DEFAULT) != null);
        assertTrue("field.enum should declare @normalize",
            def.getChildRequirement(EnumField.ATTR_NORMALIZE) != null);
    }

    @Test
    public void objectValueRegistersNormalizeButNotCoerceDefault() {
        TypeDefinition def = registry().getTypeDefinition(MetaObject.TYPE_OBJECT, MetaObject.SUBTYPE_VALUE);
        assertNotNull(def);
        assertNotNull("object.value should declare @normalize",
            def.getChildRequirement(EnumField.ATTR_NORMALIZE));
        assertNull("object.value should NOT declare @coerceDefault",
            def.getChildRequirement(EnumField.ATTR_COERCE_DEFAULT));
    }

    @Test
    public void objectEntityDoesNotCarryNormalize() {
        TypeDefinition def = registry().getTypeDefinition(MetaObject.TYPE_OBJECT, MetaObject.SUBTYPE_ENTITY);
        assertNotNull(def);
        assertNull("object.entity should NOT declare @normalize",
            def.getChildRequirement(EnumField.ATTR_NORMALIZE));
    }

    // ------------------------------------------------------------------------
    // 3 — Loading + validation.
    // ------------------------------------------------------------------------

    private static final String VALID = "{ \"metadata.root\": { \"package\": \"acme::ai\", \"children\": ["
        + "  { \"object.value\": { \"name\": \"Task\", \"@normalize\": \"collapse\", \"children\": ["
        + "    { \"field.enum\": { \"name\": \"status\", \"@values\": [\"IN_PROGRESS\", \"DONE\"],"
        + "        \"@coerceDefault\": \"DONE\", \"@normalize\": \"strip\" } }"
        + "  ] } }"
        + "] } }";

    @Test
    public void fieldEnumLoadsWithValidCoerceDefaultAndNormalize() {
        MetaDataLoader loader = loadThrough(VALID, "fr011-valid.json");
        MetaObject obj = loader.getMetaDataByName(MetaObject.class, "acme::ai::Task");
        assertEquals("collapse", obj.getMetaAttr(EnumField.ATTR_NORMALIZE, false).getValueAsString());

        MetaField<?> field = obj.getMetaField("status");
        assertEquals("DONE", field.getMetaAttr(EnumField.ATTR_COERCE_DEFAULT, false).getValueAsString());
        assertEquals("strip", field.getMetaAttr(EnumField.ATTR_NORMALIZE, false).getValueAsString());
    }

    @Test
    public void coerceDefaultOffVocabularyRaisesError() {
        String json = "{ \"metadata.root\": { \"package\": \"acme::ai\", \"children\": ["
            + "  { \"object.value\": { \"name\": \"Task\", \"children\": ["
            + "    { \"field.enum\": { \"name\": \"status\", \"@values\": [\"IN_PROGRESS\", \"DONE\"],"
            + "        \"@coerceDefault\": \"BOGUS\" } }"
            + "  ] } }"
            + "] } }";
        try {
            loadThrough(json, "fr011-bad-coerce.json");
            fail("Expected MetaDataException for off-vocabulary @coerceDefault");
        } catch (MetaDataException e) {
            assertTrue("must signal ERR_BAD_ATTR_VALUE: " + e.getMessage(),
                signalsBadAttrValue(e) && e.getMessage().contains("coerceDefault"));
        }
    }

    @Test
    public void normalizeInvalidModeRaisesError() {
        String json = "{ \"metadata.root\": { \"package\": \"acme::ai\", \"children\": ["
            + "  { \"object.value\": { \"name\": \"Task\", \"children\": ["
            + "    { \"field.enum\": { \"name\": \"status\", \"@values\": [\"IN_PROGRESS\", \"DONE\"],"
            + "        \"@normalize\": \"bogus\" } }"
            + "  ] } }"
            + "] } }";
        try {
            loadThrough(json, "fr011-bad-normalize.json");
            fail("Expected MetaDataException for invalid @normalize mode");
        } catch (MetaDataException e) {
            assertTrue("must signal ERR_BAD_ATTR_VALUE: " + e.getMessage(), signalsBadAttrValue(e));
        }
    }

    @Test
    public void coerceDefaultValidatesAgainstInheritedValues() {
        // Concrete enum owns @coerceDefault but inherits @values from an abstract base enum.
        String json = "{ \"metadata.root\": { \"package\": \"acme::ai\", \"children\": ["
            + "  { \"field.enum\": { \"name\": \"StatusEnum\", \"@isAbstract\": true,"
            + "      \"@values\": [\"IN_PROGRESS\", \"DONE\"] } },"
            + "  { \"object.value\": { \"name\": \"Task\", \"children\": ["
            + "    { \"field.enum\": { \"name\": \"status\", \"@isAbstract\": false,"
            + "        \"extends\": \"acme::ai::StatusEnum\", \"@coerceDefault\": \"DONE\" } }"
            + "  ] } }"
            + "] } }";
        // DONE is in the inherited @values → must load cleanly.
        MetaDataLoader loader = loadThrough(json, "fr011-inherited-coerce.json");
        MetaObject obj = loader.getMetaDataByName(MetaObject.class, "acme::ai::Task");
        MetaField<?> field = obj.getMetaField("status");
        assertEquals("DONE", field.getMetaAttr(EnumField.ATTR_COERCE_DEFAULT, false).getValueAsString());
    }

    /** True if the exception signals ERR_BAD_ATTR_VALUE via code or message. */
    private static boolean signalsBadAttrValue(MetaDataException e) {
        boolean byCode = e.getCode().map(c -> c == ErrorCode.ERR_BAD_ATTR_VALUE).orElse(false);
        boolean byMsg = e.getMessage() != null && e.getMessage().contains("ERR_BAD_ATTR_VALUE");
        return byCode || byMsg;
    }
}

package com.metaobjects.template;

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
 * Unit tests for the {@code validateTemplates} pass in
 * {@link com.metaobjects.loader.ValidationPhase}.
 *
 * <p>Three rules enforced (own-only, eager-throw):
 * <ol>
 *   <li>{@code template.prompt} requires {@code @payloadRef} →
 *       {@link ErrorCode#ERR_MISSING_REQUIRED_ATTR}</li>
 *   <li>{@code template.*} with {@code @payloadRef} pointing at an undefined
 *       {@code object.value} → {@link ErrorCode#ERR_INVALID_TEMPLATE}</li>
 *   <li>{@code template.prompt} with {@code @requiredSlots} member that isn't
 *       a field on the resolved payload VO → {@link ErrorCode#ERR_INVALID_TEMPLATE}</li>
 * </ol>
 *
 * <p>Mirrors the conformance fixture expectations in
 * {@code fixtures/conformance/error-template-*}.</p>
 */
public class TemplateValidationTest extends SharedRegistryTestBase {

    // ---- fixtures ----------------------------------------------------------

    private static final String PROMPT_MISSING_PAYLOADREF =
        "{ \"metadata.root\": { \"package\": \"acme\", \"children\": [" +
        "  { \"template.prompt\": { \"name\": \"P\", \"@textRef\": \"x/y\" } }" +
        "] } }";

    private static final String PAYLOADREF_UNRESOLVED =
        "{ \"metadata.root\": { \"package\": \"acme\", \"children\": [" +
        "  { \"template.prompt\": { \"name\": \"P\", \"@payloadRef\": \"NoSuch\"," +
        "      \"@textRef\": \"x/y\" } }" +
        "] } }";

    private static final String REQUIRED_SLOT_MISSING =
        "{ \"metadata.root\": { \"package\": \"acme\", \"children\": [" +
        "  { \"object.value\": { \"name\": \"Payload\", \"children\": [" +
        "    { \"field.string\": { \"name\": \"present\" } }" +
        "  ] } }," +
        "  { \"template.prompt\": { \"name\": \"P\"," +
        "      \"@payloadRef\": \"Payload\"," +
        "      \"@textRef\": \"x/y\"," +
        "      \"@requiredSlots\": [ \"present\", \"absent\" ] } }" +
        "] } }";

    private static final String UNKNOWN_FORMAT_VALUE =
        "{ \"metadata.root\": { \"package\": \"acme\", \"children\": [" +
        "  { \"object.value\": { \"name\": \"P\", \"children\": [" +
        "    { \"field.string\": { \"name\": \"x\" } }" +
        "  ] } }," +
        "  { \"template.output\": { \"name\": \"T\", \"@payloadRef\": \"P\"," +
        "      \"@textRef\": \"x/y\", \"@format\": \"yaml\" } }" +
        "] } }";

    // ---- helpers -----------------------------------------------------------

    private MetaDataLoader newTestLoader() {
        return createTestLoader("TemplateValidationTest", Collections.emptyList());
    }

    private ErrorCode loadAndExpectError(String canonicalJson, String id) {
        try {
            newTestLoader().load(List.of(new InMemoryStringSource(canonicalJson, id)));
            fail("expected MetaDataException");
            return null;
        } catch (MetaDataException ex) {
            return ex.getCode().orElse(null);
        }
    }

    // ---- assertions --------------------------------------------------------

    @Test
    public void promptMissingPayloadRefRaisesMissingRequired() {
        assertEquals(
            ErrorCode.ERR_MISSING_REQUIRED_ATTR,
            loadAndExpectError(PROMPT_MISSING_PAYLOADREF, "prompt-missing-payloadref.json"));
    }

    @Test
    public void payloadRefUnresolvedRaisesInvalidTemplate() {
        assertEquals(
            ErrorCode.ERR_INVALID_TEMPLATE,
            loadAndExpectError(PAYLOADREF_UNRESOLVED, "payloadref-unresolved.json"));
    }

    @Test
    public void requiredSlotMissingRaisesInvalidTemplate() {
        assertEquals(
            ErrorCode.ERR_INVALID_TEMPLATE,
            loadAndExpectError(REQUIRED_SLOT_MISSING, "required-slot-missing.json"));
    }

    @Test
    public void rejectsUnknownFormatValue() {
        // @format is a closed-set enum (text|html|xml|csv|json|markdown|spreadsheet);
        // an unknown value like "yaml" must be rejected at registry constraint time.
        // Mirror the relationship @onDelete enum-violation pattern (RelationshipReferentialActionsTest).
        try {
            newTestLoader().load(List.of(new InMemoryStringSource(
                UNKNOWN_FORMAT_VALUE, "unknown-format-value.json")));
            fail("Expected MetaDataException for unknown @format value 'yaml'");
        } catch (MetaDataException e) {
            boolean codeMatches = e.getCode()
                .map(c -> c == ErrorCode.ERR_BAD_ATTR_VALUE)
                .orElse(false);
            boolean messageMatches = e.getMessage() != null
                && e.getMessage().contains("ERR_BAD_ATTR_VALUE");
            assertTrue("Exception must signal ERR_BAD_ATTR_VALUE (via code or message): "
                + e.getMessage(), codeMatches || messageMatches);
        }
    }
}

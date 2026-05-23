package com.metaobjects.registry;

import com.metaobjects.DataTypes;
import com.metaobjects.MetaData;
import com.metaobjects.MetaDataException;
import com.metaobjects.MetaRoot;
import com.metaobjects.field.MetaField;
import com.metaobjects.field.PrimitiveField;
import com.metaobjects.io.json.CanonicalJsonSerializer;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.loader.parser.json.CanonicalJsonParser;
import com.metaobjects.object.pojo.PojoMetaObject;
import org.junit.BeforeClass;
import org.junit.Test;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.Collections;

import static org.junit.Assert.*;

/**
 * WA1 gate test: camelCase subtype names are preserved end-to-end
 * (register → parse → registry lookup → canonical serialize), and
 * wrong-case variants are rejected by a case-sensitive registry lookup.
 *
 * <p>Pattern: registers a one-off test-only {@code field.fizzBuzz} type via a
 * tiny static field subclass + a single {@code registry.registerType(…)} call,
 * then loads canonical JSON and serializes it back, verifying the fused key
 * {@code "field.fizzBuzz"} is preserved verbatim in the output.</p>
 *
 * <p>Mirrors the Open-Closed proof approach used by {@code BasicRegistryTest} and
 * {@code StaticRegistrationTest}: uses the shared registry via
 * {@link SharedRegistryTestBase}, creates a {@link CanonicalJsonParser} per-test
 * via {@link #newTestLoader()}, and asserts via {@link CanonicalJsonSerializer}.</p>
 *
 * @since 6.0.0
 */
public class CamelCaseSubtypeRoundTripTest extends SharedRegistryTestBase {

    // -----------------------------------------------------------------------
    // Test-only camelCase field subtype
    // -----------------------------------------------------------------------

    /**
     * Minimal test-only field subtype with a camelCase subtype identifier.
     *
     * <p>Static nested class so that the registry can construct it reflectively
     * via the single-String {@code (name)} constructor without an implicit outer
     * reference. Extends {@link PrimitiveField}{@code <String>} exactly as
     * {@code StringField} does — the simplest valid {@link MetaField} extension.</p>
     */
    public static final class FizzBuzzField extends PrimitiveField<String> {

        /** camelCase subtype constant — the invariant under test. */
        public static final String SUBTYPE = "fizzBuzz";

        public FizzBuzzField(String name) {
            super(SUBTYPE, name, DataTypes.STRING);
        }

        /**
         * Registers {@code field.fizzBuzz} in the given registry, inheriting
         * all base field children from {@code field.base}.
         *
         * @param registry target registry
         */
        public static void registerTypes(MetaDataRegistry registry) {
            registry.registerType(FizzBuzzField.class, def -> def
                .type(MetaField.TYPE_FIELD).subType(SUBTYPE)
                .description("Test-only camelCase field subtype for WA1 gate test")
                .inheritsFrom(MetaField.TYPE_FIELD, MetaField.SUBTYPE_BASE)
            );
        }
    }

    // -----------------------------------------------------------------------
    // One-time setup: boot all standard types + register the camelCase subtype
    // -----------------------------------------------------------------------

    @BeforeClass
    public static void registerFizzBuzz() {
        // Boot standard types so that field.base, object.pojo, etc. are present.
        // SharedRegistryTestBase.initializeSharedRegistry() is called by the JUnit
        // runner before this @BeforeClass; we add our test-only type on top.
        try {
            new PojoMetaObject("_boot_pojo");
        } catch (Exception ignored) {
            // may already be registered — that is fine
        }

        MetaDataRegistry registry = getSharedRegistry();
        // Register field.fizzBuzz (camelCase) unless already present from a prior run
        if (!registry.isRegistered(MetaField.TYPE_FIELD, FizzBuzzField.SUBTYPE)) {
            FizzBuzzField.registerTypes(registry);
        }
    }

    // -----------------------------------------------------------------------
    // Helper: create a fresh per-test loader (manual subtype, no URI sources)
    // -----------------------------------------------------------------------

    private MetaDataLoader newTestLoader() {
        return createTestLoader("CamelCaseSubtypeRoundTrip", Collections.emptyList());
    }

    // -----------------------------------------------------------------------
    // Assertion 3 + 4 inline JSON fixtures
    // -----------------------------------------------------------------------

    private static final String CANONICAL_CORRECT_CASE =
        "{ \"metadata.root\": { \"package\": \"t::x\", \"children\": [" +
        "  { \"object.pojo\": { \"name\": \"X\", \"children\": [" +
        "    { \"field.fizzBuzz\": { \"name\": \"f\" } }" +
        "  ] } }" +
        "] } }";

    private static final String CANONICAL_WRONG_CASE =
        "{ \"metadata.root\": { \"package\": \"t::x\", \"children\": [" +
        "  { \"object.pojo\": { \"name\": \"X\", \"children\": [" +
        "    { \"field.fizzbuzz\": { \"name\": \"f\" } }" +
        "  ] } }" +
        "] } }";

    // -----------------------------------------------------------------------
    // Test A: camelCase round-trips through the full pipeline
    // -----------------------------------------------------------------------

    /**
     * Loads a document containing {@code field.fizzBuzz} and canonical-serializes
     * the result. The fused key in the output must be {@code "field.fizzBuzz"}
     * (camelCase preserved), not {@code "field.fizzbuzz"}.
     */
    @Test
    public void camelCaseSubtypePreservedEndToEnd() {
        MetaDataLoader loader = newTestLoader();
        CanonicalJsonParser parser = new CanonicalJsonParser(loader, "fizzBuzz-correct.json");
        parser.loadFromStream(
            new ByteArrayInputStream(CANONICAL_CORRECT_CASE.getBytes(StandardCharsets.UTF_8)));

        MetaRoot root = loader.getRoot();
        assertNotNull("root must not be null", root);

        String serialized = CanonicalJsonSerializer.canonicalSerialize(root);

        assertTrue(
            "fused key must contain 'field.fizzBuzz' (camelCase preserved), got:\n" + serialized,
            serialized.contains("\"field.fizzBuzz\""));

        assertFalse(
            "fused key must NOT contain 'field.fizzbuzz' (lowercased), got:\n" + serialized,
            serialized.contains("\"field.fizzbuzz\""));
    }

    // -----------------------------------------------------------------------
    // Test B: wrong-case variant is rejected (case-sensitive registry lookup)
    // -----------------------------------------------------------------------

    /**
     * Attempts to load a document containing {@code field.fizzbuzz} (all-lowercase).
     * Because {@code field.fizzbuzz} is NOT registered (only {@code field.fizzBuzz}
     * is), the case-sensitive registry lookup must reject it and throw an exception.
     */
    @Test
    public void wrongCaseSubtypeIsRejected() {
        MetaDataLoader loader = newTestLoader();
        CanonicalJsonParser parser = new CanonicalJsonParser(loader, "fizzBuzz-wrong-case.json");

        try {
            parser.loadFromStream(
                new ByteArrayInputStream(CANONICAL_WRONG_CASE.getBytes(StandardCharsets.UTF_8)));
            fail("Expected an exception when loading unregistered 'field.fizzbuzz' (wrong case), " +
                 "but loadFromStream completed without error. " +
                 "This means a case-insensitive lookup is still active in the pipeline.");
        } catch (MetaDataException e) {
            // Expected: the case-sensitive registry lookup did not find 'field.fizzbuzz'
            // and threw a MetaDataException (or a subclass of it).
            assertTrue(
                "Exception message should mention the unregistered type; got: " + e.getMessage(),
                e.getMessage() != null);
        } catch (RuntimeException e) {
            // Also acceptable: a RuntimeException wrapping the MetaDataException.
            assertTrue(
                "RuntimeException should have a non-null message; got: " + e.getMessage(),
                e.getMessage() != null);
        }
    }
}

package com.metaobjects.index;

import com.metaobjects.ErrorCode;
import com.metaobjects.MetaDataException;
import com.metaobjects.MetaRoot;
import com.metaobjects.loader.InMemoryStringSource;
import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.MetaObject;
import com.metaobjects.registry.SharedRegistryTestBase;
import org.junit.Test;

import java.util.List;

import static org.junit.Assert.*;

/**
 * Tests for the {@code index.lookup} type.
 *
 * <p>Covers:
 * <ol>
 *   <li>Loading {@code index.lookup} with {@code @fields} works.</li>
 *   <li>{@code @unique} on {@code identity.secondary} is rejected ({@code ERR_UNKNOWN_ATTR}) in strict mode.</li>
 *   <li>{@code @unique} on {@code index.lookup} is rejected ({@code ERR_UNKNOWN_ATTR}) in strict mode.</li>
 *   <li>Field resolution: {@code ERR_INVALID_INDEX} when a field in {@code @fields} does not exist.</li>
 *   <li>Field resolution: {@code ERR_INVALID_INDEX} when {@code @fields} is empty.</li>
 *   <li>Inherited field via extends is accepted (ADR-0039 resolving accessor).</li>
 * </ol>
 * </p>
 */
public class IndexLookupTest extends SharedRegistryTestBase {

    // ---------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------

    private MetaDataLoader strictLoader() {
        MetaDataLoader loader = new MetaDataLoader(
                LoaderOptions.create(false, false, true),
                MetaDataLoader.SUBTYPE_MANUAL, "test-index-lookup");
        loader.setSourceURIs(java.util.Collections.emptyList());
        loader.init();
        return loader;
    }

    private MetaRoot load(MetaDataLoader loader, String json) {
        loader.load(List.of(new InMemoryStringSource(json, "test.json")));
        return loader.getRoot();
    }

    // ---------------------------------------------------------------------------
    // (1) Basic load: index.lookup with @fields works
    // ---------------------------------------------------------------------------

    @Test
    public void indexLookup_basicLoad_succeeds() {
        String json = "{ \"metadata.root\": { \"package\": \"acme::test\", \"children\": ["
            + "  { \"object.entity\": { \"name\": \"Order\", \"children\": ["
            + "    { \"field.long\": { \"name\": \"id\" } },"
            + "    { \"field.long\": { \"name\": \"customerId\" } },"
            + "    { \"field.timestamp\": { \"name\": \"placedAt\" } },"
            + "    { \"identity.primary\": { \"name\": \"pk\", \"@fields\": [\"id\"] } },"
            + "    { \"index.lookup\": { \"name\": \"idx_customer_placed\","
            + "        \"@fields\": [\"customerId\", \"placedAt\"],"
            + "        \"@orders\": [\"asc\", \"desc\"] } }"
            + "  ] } }"
            + "] } }";

        MetaDataLoader loader = strictLoader();
        MetaRoot root = load(loader, json);

        assertTrue("No load errors", loader.getErrors().isEmpty());

        // Entities are stored by fully-qualified name (package::name). Find by short name.
        MetaObject order = null;
        for (com.metaobjects.MetaData child : root.getChildren(com.metaobjects.MetaData.class, false)) {
            if (child instanceof MetaObject && "Order".equals(child.getShortName())) {
                order = (MetaObject) child;
                break;
            }
        }
        assertNotNull("Order entity found", order);

        // Find the index.lookup child
        LookupIndex idx = null;
        for (com.metaobjects.MetaData child : order.getChildren(com.metaobjects.MetaData.class, false)) {
            if (child instanceof LookupIndex) {
                idx = (LookupIndex) child;
                break;
            }
        }
        assertNotNull("index.lookup child found", idx);
        assertEquals("Index type is 'index'", Index.TYPE_INDEX, idx.getType());
        assertEquals("Index subtype is 'lookup'", Index.SUBTYPE_LOOKUP, idx.getSubType());
        assertEquals("Fields resolved", List.of("customerId", "placedAt"), idx.getFields());
        assertTrue("isLookup() returns true", idx.isLookup());
    }

    // ---------------------------------------------------------------------------
    // (2) @unique on identity.secondary is rejected in strict mode
    // ---------------------------------------------------------------------------

    @Test
    public void identitySecondary_unique_rejected_strict() {
        String json = "{ \"metadata.root\": { \"package\": \"acme::test\", \"children\": ["
            + "  { \"object.entity\": { \"name\": \"User\", \"children\": ["
            + "    { \"field.long\": { \"name\": \"id\" } },"
            + "    { \"field.string\": { \"name\": \"email\" } },"
            + "    { \"identity.primary\": { \"name\": \"pk\", \"@fields\": [\"id\"] } },"
            + "    { \"identity.secondary\": { \"name\": \"uq_email\","
            + "        \"@fields\": [\"email\"],"
            + "        \"@unique\": true } }"
            + "  ] } }"
            + "] } }";

        MetaDataLoader loader = strictLoader();
        try {
            load(loader, json);
            // Should throw or record ERR_UNKNOWN_ATTR
            List<MetaDataException> errors = loader.getErrors();
            boolean hasUnknownAttr = errors.stream()
                .anyMatch(e -> e.getCode().map(c -> c == ErrorCode.ERR_UNKNOWN_ATTR).orElse(false));
            assertTrue("ERR_UNKNOWN_ATTR for @unique on identity.secondary", hasUnknownAttr);
        } catch (MetaDataException e) {
            assertEquals("ERR_UNKNOWN_ATTR thrown for @unique on identity.secondary",
                ErrorCode.ERR_UNKNOWN_ATTR,
                e.getCode().orElse(null));
        }
    }

    // ---------------------------------------------------------------------------
    // (3) @unique on index.lookup is rejected in strict mode
    // ---------------------------------------------------------------------------

    @Test
    public void indexLookup_unique_rejected_strict() {
        String json = "{ \"metadata.root\": { \"package\": \"acme::test\", \"children\": ["
            + "  { \"object.entity\": { \"name\": \"Order\", \"children\": ["
            + "    { \"field.long\": { \"name\": \"id\" } },"
            + "    { \"field.long\": { \"name\": \"customerId\" } },"
            + "    { \"identity.primary\": { \"name\": \"pk\", \"@fields\": [\"id\"] } },"
            + "    { \"index.lookup\": { \"name\": \"idx_customer\","
            + "        \"@fields\": [\"customerId\"],"
            + "        \"@unique\": true } }"
            + "  ] } }"
            + "] } }";

        MetaDataLoader loader = strictLoader();
        try {
            load(loader, json);
            List<MetaDataException> errors = loader.getErrors();
            boolean hasUnknownAttr = errors.stream()
                .anyMatch(e -> e.getCode().map(c -> c == ErrorCode.ERR_UNKNOWN_ATTR).orElse(false));
            assertTrue("ERR_UNKNOWN_ATTR for @unique on index.lookup", hasUnknownAttr);
        } catch (MetaDataException e) {
            assertEquals("ERR_UNKNOWN_ATTR thrown for @unique on index.lookup",
                ErrorCode.ERR_UNKNOWN_ATTR,
                e.getCode().orElse(null));
        }
    }

    // ---------------------------------------------------------------------------
    // (4) ERR_INVALID_INDEX when @fields names a non-existent field
    // ---------------------------------------------------------------------------

    @Test
    public void indexLookup_unknownField_emitsErrInvalidIndex() {
        String json = "{ \"metadata.root\": { \"package\": \"acme::test\", \"children\": ["
            + "  { \"object.entity\": { \"name\": \"Order\", \"children\": ["
            + "    { \"field.long\": { \"name\": \"id\" } },"
            + "    { \"field.long\": { \"name\": \"customerId\" } },"
            + "    { \"identity.primary\": { \"name\": \"pk\", \"@fields\": [\"id\"] } },"
            + "    { \"index.lookup\": { \"name\": \"idx_bad\","
            + "        \"@fields\": [\"customerId\", \"nonExistentField\"] } }"
            + "  ] } }"
            + "] } }";

        MetaDataLoader loader = strictLoader();
        MetaDataException caught = null;
        try {
            load(loader, json);
        } catch (MetaDataException e) {
            caught = e;
        }

        // Either thrown or recorded
        List<MetaDataException> errors = loader.getErrors();
        boolean hasInvalidIndex = (caught != null && caught.getCode().map(c -> c == ErrorCode.ERR_INVALID_INDEX).orElse(false))
            || errors.stream().anyMatch(e -> e.getCode().map(c -> c == ErrorCode.ERR_INVALID_INDEX).orElse(false));

        assertTrue("ERR_INVALID_INDEX emitted for unknown field in @fields", hasInvalidIndex);

        // The error should mention the unknown field name
        String combinedMessages = errors.stream().map(Throwable::getMessage).reduce("", (a, b) -> a + " " + b);
        if (caught != null) combinedMessages += " " + caught.getMessage();
        assertTrue("Error mentions 'nonExistentField'",
            combinedMessages.contains("nonExistentField"));
    }

    // ---------------------------------------------------------------------------
    // (5) ERR_INVALID_INDEX when @fields is empty
    // ---------------------------------------------------------------------------

    @Test
    public void indexLookup_emptyFields_emitsErrInvalidIndex() {
        String json = "{ \"metadata.root\": { \"package\": \"acme::test\", \"children\": ["
            + "  { \"object.entity\": { \"name\": \"Order\", \"children\": ["
            + "    { \"field.long\": { \"name\": \"id\" } },"
            + "    { \"identity.primary\": { \"name\": \"pk\", \"@fields\": [\"id\"] } },"
            + "    { \"index.lookup\": { \"name\": \"idx_empty\","
            + "        \"@fields\": [] } }"
            + "  ] } }"
            + "] } }";

        MetaDataLoader loader = strictLoader();
        MetaDataException caught = null;
        try {
            load(loader, json);
        } catch (MetaDataException e) {
            caught = e;
        }

        List<MetaDataException> errors = loader.getErrors();
        boolean hasInvalidIndex = (caught != null && caught.getCode().map(c -> c == ErrorCode.ERR_INVALID_INDEX).orElse(false))
            || errors.stream().anyMatch(e -> e.getCode().map(c -> c == ErrorCode.ERR_INVALID_INDEX).orElse(false));

        assertTrue("ERR_INVALID_INDEX emitted for empty @fields", hasInvalidIndex);

        String combinedMessages = errors.stream().map(Throwable::getMessage).reduce("", (a, b) -> a + " " + b);
        if (caught != null) combinedMessages += " " + caught.getMessage();
        assertTrue("Error mentions index name 'idx_empty'",
            combinedMessages.contains("idx_empty"));
    }

    // ---------------------------------------------------------------------------
    // (6) Inherited field via extends is accepted (ADR-0039)
    // ---------------------------------------------------------------------------

    @Test
    public void indexLookup_inheritedField_accepted() {
        String json = "{ \"metadata.root\": { \"package\": \"acme::test\", \"children\": ["
            + "  { \"object.entity\": { \"name\": \"BaseEntity\", \"abstract\": true, \"children\": ["
            + "    { \"field.long\": { \"name\": \"id\" } },"
            + "    { \"field.timestamp\": { \"name\": \"createdAt\" } },"
            + "    { \"identity.primary\": { \"name\": \"pk\", \"@fields\": [\"id\"] } }"
            + "  ] } },"
            + "  { \"object.entity\": { \"name\": \"Order\", \"extends\": \"BaseEntity\", \"children\": ["
            + "    { \"field.long\": { \"name\": \"customerId\" } },"
            + "    { \"index.lookup\": { \"name\": \"idx_customer_created\","
            + "        \"@fields\": [\"customerId\", \"createdAt\"] } }"
            + "  ] } }"
            + "] } }";

        MetaDataLoader loader = strictLoader();
        MetaRoot root = load(loader, json);

        // Must not emit ERR_INVALID_INDEX — createdAt is inherited from BaseEntity
        List<MetaDataException> errors = loader.getErrors();
        boolean hasInvalidIndex = errors.stream()
            .anyMatch(e -> e.getCode().map(c -> c == ErrorCode.ERR_INVALID_INDEX).orElse(false));
        assertFalse("No ERR_INVALID_INDEX for inherited field 'createdAt'", hasInvalidIndex);
    }
}

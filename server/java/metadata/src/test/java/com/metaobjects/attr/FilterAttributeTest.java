package com.metaobjects.attr;

import com.metaobjects.DataTypes;
import com.metaobjects.MetaRoot;
import com.metaobjects.io.json.CanonicalJsonSerializer;
import com.metaobjects.registry.MetaDataRegistry;
import com.metaobjects.registry.SharedRegistryTestBase;
import org.junit.Before;
import org.junit.Test;

import java.util.List;
import java.util.Map;

import static org.junit.Assert.*;

/**
 * Tests for {@link FilterAttribute} — self-registering attr.filter implementation.
 *
 * <p>Verifies:</p>
 * <ol>
 *   <li>Registration: attr.filter is registered with DataTypes.OBJECT and is creatable via the registry.</li>
 *   <li>Desugar rules:
 *     <ul>
 *       <li>Scalar value → {@code {eq: value}}</li>
 *       <li>Array value → {@code {in: [...]}}</li>
 *       <li>JSON null → {@code {isNull: true}}</li>
 *       <li>Explicit op object → pass through unchanged</li>
 *       <li>{@code or}/{@code and} composition keys recurse into sub-filter arrays</li>
 *     </ul>
 *   </li>
 *   <li>Round-trip: getValueAsString() returns valid JSON that re-parses to the same desugared map.</li>
 * </ol>
 */
public class FilterAttributeTest extends SharedRegistryTestBase {

    @Before
    public void ensureFilterAttributeRegistered() {
        // Force FilterAttribute class loading so its static registration fires
        try {
            new FilterAttribute("_boot_filter");
        } catch (Exception ignored) {
            // Registration errors are acceptable if already registered
        }
    }

    // -----------------------------------------------------------------------
    // Registration tests
    // -----------------------------------------------------------------------

    @Test
    public void filterAttributeSubtypeConstantIsCorrect() {
        assertEquals("filter", FilterAttribute.SUBTYPE_FILTER);
    }

    @Test
    public void filterAttributeDataTypeIsObject() {
        FilterAttribute attr = new FilterAttribute("testFilter");
        assertEquals(DataTypes.OBJECT, attr.getDataType());
    }

    @Test
    public void filterAttributeIsCreatableViaRegistry() {
        MetaDataRegistry registry = MetaDataRegistry.getInstance();
        assertTrue("attr.filter should be registered in the type registry",
            registry.isRegistered(MetaAttribute.TYPE_ATTR, FilterAttribute.SUBTYPE_FILTER));

        Object instance = registry.createInstance(
            MetaAttribute.TYPE_ATTR, FilterAttribute.SUBTYPE_FILTER, "myFilter");
        assertNotNull("Registry should create a FilterAttribute instance", instance);
        assertTrue("Created instance should be a FilterAttribute",
            instance instanceof FilterAttribute);
    }

    // -----------------------------------------------------------------------
    // Desugar rule: scalar → {eq: value}
    // -----------------------------------------------------------------------

    @Test
    public void scalarBooleanDesugarsToEq() {
        FilterAttribute attr = new FilterAttribute("subscribed");
        // {"subscribed":true} → {subscribed: {eq: true}}
        attr.setValueAsString("{\"subscribed\":true}");

        Map<String, Object> val = attr.getValue();
        assertNotNull(val);
        assertTrue("subscribed key should be present", val.containsKey("subscribed"));

        @SuppressWarnings("unchecked")
        Map<String, Object> clause = (Map<String, Object>) val.get("subscribed");
        assertEquals("Boolean scalar should desugar to {eq: true}", true, clause.get("eq"));
        assertFalse("No isNull key expected", clause.containsKey("isNull"));
    }

    @Test
    public void scalarStringDesugarsToEq() {
        FilterAttribute attr = new FilterAttribute("status");
        attr.setValueAsString("{\"status\":\"active\"}");

        Map<String, Object> val = attr.getValue();
        @SuppressWarnings("unchecked")
        Map<String, Object> clause = (Map<String, Object>) val.get("status");
        assertEquals("String scalar should desugar to {eq: 'active'}", "active", clause.get("eq"));
    }

    @Test
    public void scalarNumberDesugarsToEq() {
        FilterAttribute attr = new FilterAttribute("count");
        attr.setValueAsString("{\"count\":42}");

        Map<String, Object> val = attr.getValue();
        @SuppressWarnings("unchecked")
        Map<String, Object> clause = (Map<String, Object>) val.get("count");
        Object eqVal = clause.get("eq");
        assertNotNull("Numeric scalar should desugar to {eq: N}", eqVal);
        assertEquals("Number value should be 42", 42L, ((Number) eqVal).longValue());
    }

    // -----------------------------------------------------------------------
    // Desugar rule: array → {in: [...]}
    // -----------------------------------------------------------------------

    @Test
    public void arrayDesugarsToIn() {
        FilterAttribute attr = new FilterAttribute("status");
        attr.setValueAsString("{\"status\":[\"active\",\"pending\"]}");

        Map<String, Object> val = attr.getValue();
        @SuppressWarnings("unchecked")
        Map<String, Object> clause = (Map<String, Object>) val.get("status");

        assertTrue("Array should desugar to {in: [...]}", clause.containsKey("in"));
        @SuppressWarnings("unchecked")
        List<Object> inList = (List<Object>) clause.get("in");
        assertEquals("in list should have 2 elements", 2, inList.size());
        assertEquals("active", inList.get(0));
        assertEquals("pending", inList.get(1));
    }

    // -----------------------------------------------------------------------
    // Desugar rule: null → {isNull: true}
    // -----------------------------------------------------------------------

    @Test
    public void nullValueDesugarsToIsNull() {
        FilterAttribute attr = new FilterAttribute("deletedAt");
        attr.setValueAsString("{\"deletedAt\":null}");

        Map<String, Object> val = attr.getValue();
        @SuppressWarnings("unchecked")
        Map<String, Object> clause = (Map<String, Object>) val.get("deletedAt");

        assertTrue("null should desugar to {isNull: true}", clause.containsKey("isNull"));
        assertEquals(true, clause.get("isNull"));
        assertFalse("No eq key expected for isNull", clause.containsKey("eq"));
    }

    // -----------------------------------------------------------------------
    // Desugar rule: explicit op object → pass through
    // -----------------------------------------------------------------------

    @Test
    public void explicitOpObjectPassesThroughUnchanged() {
        FilterAttribute attr = new FilterAttribute("createdAt");
        attr.setValueAsString("{\"createdAt\":{\"gte\":\"2024-01-01\"}}");

        Map<String, Object> val = attr.getValue();
        @SuppressWarnings("unchecked")
        Map<String, Object> clause = (Map<String, Object>) val.get("createdAt");

        assertTrue("Explicit op object should pass through with 'gte' key", clause.containsKey("gte"));
        assertEquals("2024-01-01", clause.get("gte"));
        assertFalse("No eq wrapping of an explicit op", clause.containsKey("eq"));
    }

    @Test
    public void explicitLikeOpPassesThroughUnchanged() {
        FilterAttribute attr = new FilterAttribute("name");
        attr.setValueAsString("{\"name\":{\"like\":\"%smith%\"}}");

        Map<String, Object> val = attr.getValue();
        @SuppressWarnings("unchecked")
        Map<String, Object> clause = (Map<String, Object>) val.get("name");
        // Explicit {like: "%smith%"} passes through — keys are op names, not field names
        assertEquals("%smith%", clause.get("like"));
        assertFalse("Should not be wrapped in eq", clause.containsKey("eq"));
    }

    // -----------------------------------------------------------------------
    // Desugar rule: or/and composition recurses into sub-filter arrays
    // -----------------------------------------------------------------------

    @Test
    public void orCompositionRecursesIntoSubFilters() {
        FilterAttribute attr = new FilterAttribute("composedFilter");
        // { "or": [ {"status": "active"}, {"status": "pending"} ] }
        attr.setValueAsString("{\"or\":[{\"status\":\"active\"},{\"status\":\"pending\"}]}");

        Map<String, Object> val = attr.getValue();
        assertNotNull(val);
        assertTrue("Composed filter should have 'or' key", val.containsKey("or"));

        @SuppressWarnings("unchecked")
        List<Object> orList = (List<Object>) val.get("or");
        assertEquals("or list should have 2 elements", 2, orList.size());

        // Each sub-filter should have been desugared: "active" scalar → {eq: "active"}
        @SuppressWarnings("unchecked")
        Map<String, Object> first = (Map<String, Object>) orList.get(0);
        assertTrue("First sub-filter should have 'status' key", first.containsKey("status"));
        @SuppressWarnings("unchecked")
        Map<String, Object> firstClause = (Map<String, Object>) first.get("status");
        assertEquals("active", firstClause.get("eq"));

        @SuppressWarnings("unchecked")
        Map<String, Object> second = (Map<String, Object>) orList.get(1);
        @SuppressWarnings("unchecked")
        Map<String, Object> secondClause = (Map<String, Object>) second.get("status");
        assertEquals("pending", secondClause.get("eq"));
    }

    @Test
    public void andCompositionRecurses() {
        FilterAttribute attr = new FilterAttribute("combined");
        attr.setValueAsString("{\"and\":[{\"active\":true},{\"verified\":true}]}");

        Map<String, Object> val = attr.getValue();
        assertTrue(val.containsKey("and"));
        @SuppressWarnings("unchecked")
        List<Object> andList = (List<Object>) val.get("and");
        assertEquals(2, andList.size());

        @SuppressWarnings("unchecked")
        Map<String, Object> first = (Map<String, Object>) andList.get(0);
        @SuppressWarnings("unchecked")
        Map<String, Object> activeClause = (Map<String, Object>) first.get("active");
        assertEquals(true, activeClause.get("eq"));
    }

    // -----------------------------------------------------------------------
    // Multi-field filter
    // -----------------------------------------------------------------------

    @Test
    public void multiFieldFilterDesugarsEachField() {
        FilterAttribute attr = new FilterAttribute("multi");
        attr.setValueAsString("{\"subscribed\":true,\"deletedAt\":null,\"status\":[\"active\",\"trial\"]}");

        Map<String, Object> val = attr.getValue();
        assertEquals("Should have 3 fields", 3, val.size());

        // subscribed: true → {eq: true}
        @SuppressWarnings("unchecked")
        Map<String, Object> subscribed = (Map<String, Object>) val.get("subscribed");
        assertEquals(true, subscribed.get("eq"));

        // deletedAt: null → {isNull: true}
        @SuppressWarnings("unchecked")
        Map<String, Object> deletedAt = (Map<String, Object>) val.get("deletedAt");
        assertEquals(true, deletedAt.get("isNull"));

        // status: ["active","trial"] → {in: ["active","trial"]}
        @SuppressWarnings("unchecked")
        Map<String, Object> status = (Map<String, Object>) val.get("status");
        @SuppressWarnings("unchecked")
        List<Object> inList = (List<Object>) status.get("in");
        assertEquals(2, inList.size());
        assertEquals("active", inList.get(0));
    }

    // -----------------------------------------------------------------------
    // setValueAsObject with Map input
    // -----------------------------------------------------------------------

    @Test
    public void setValueAsObjectWithMapDesugars() {
        FilterAttribute attr = new FilterAttribute("fromMap");
        Map<String, Object> input = new java.util.LinkedHashMap<>();
        input.put("active", true);
        attr.setValueAsObject(input);

        Map<String, Object> val = attr.getValue();
        assertNotNull(val);
        @SuppressWarnings("unchecked")
        Map<String, Object> clause = (Map<String, Object>) val.get("active");
        assertEquals(true, clause.get("eq"));
    }

    @Test(expected = InvalidAttributeValueException.class)
    public void setValueAsObjectWithUnsupportedTypeThrows() {
        FilterAttribute attr = new FilterAttribute("bad");
        attr.setValueAsObject(12345); // Integer is not a supported input type
    }

    // -----------------------------------------------------------------------
    // getValueAsString round-trip
    // -----------------------------------------------------------------------

    @Test
    public void getValueAsStringReturnsValidJson() {
        FilterAttribute attr = new FilterAttribute("roundTrip");
        attr.setValueAsString("{\"email\":{\"like\":\"%@example.com\"}}");

        String json = attr.getValueAsString();
        assertNotNull(json);
        // Must contain the key and value
        assertTrue("JSON should contain 'email'", json.contains("email"));
        assertTrue("JSON should contain 'like'", json.contains("like"));
    }

    @Test
    public void nullValueSerializesToEmptyObject() {
        FilterAttribute attr = new FilterAttribute("nullFilter");
        attr.setValue(null);
        assertEquals("{}", attr.getValueAsString());
    }

    // -----------------------------------------------------------------------
    // Canonical serializer round-trip: FilterAttribute emits a JSON object,
    // NOT a quoted string like "{subscribed={eq=true}}"
    // -----------------------------------------------------------------------

    /**
     * Full canonical round-trip:
     * <ol>
     *   <li>Build a FilterAttribute with shorthand input
     *       {@code {"subscribed":true,"status":["a","b"]}}.</li>
     *   <li>Attach it to a MetaRoot and serialize via
     *       {@link CanonicalJsonSerializer#canonicalSerialize}.</li>
     *   <li>Assert that the emitted {@code @filter} value is a JSON object
     *       {@code {"subscribed":{"eq":true},"status":{"in":["a","b"]}}}
     *       — not a quoted Java-Map toString like
     *       {@code "{subscribed={eq=true}, ...}"}.</li>
     * </ol>
     */
    @Test
    public void canonicalSerializerEmitsFilterAsJsonObject() {
        // Build the attribute — shorthand desugar fires inside setValueAsString
        FilterAttribute attr = new FilterAttribute("filter");
        attr.setValueAsString("{\"subscribed\":true,\"status\":[\"a\",\"b\"]}");

        // Attach to a MetaRoot so the serializer has a tree to walk
        MetaRoot root = new MetaRoot("test::roundtrip");
        root.addMetaAttr(attr);

        String json = CanonicalJsonSerializer.canonicalSerialize(root);

        // Must contain the key
        assertTrue("@filter key must be present in serialized output, got: " + json,
                json.contains("\"@filter\""));

        // Must NOT be a quoted string (the broken form before this fix)
        assertFalse("@filter value must NOT be a quoted Java-Map toString, got: " + json,
                json.contains("\"@filter\": \"{"));

        // Must be a JSON object — begins with { in the output
        // Look for the pattern:  "@filter": {
        assertTrue("@filter value must be a JSON object (not a quoted string), got: " + json,
                json.contains("\"@filter\": {"));

        // Assert desugared content: subscribed → {eq: true}
        assertTrue("subscribed should appear as a field in the filter object, got: " + json,
                json.contains("\"subscribed\""));
        assertTrue("subscribed should be desugared to {eq: true}, got: " + json,
                json.contains("\"eq\": true"));

        // Assert desugared content: status → {in: ["a","b"]}
        assertTrue("status should appear as a field in the filter object, got: " + json,
                json.contains("\"status\""));
        assertTrue("status should be desugared to {in: [...]}, got: " + json,
                json.contains("\"in\""));
        assertTrue("in array should contain \"a\", got: " + json,
                json.contains("\"a\""));
        assertTrue("in array should contain \"b\", got: " + json,
                json.contains("\"b\""));
    }
}

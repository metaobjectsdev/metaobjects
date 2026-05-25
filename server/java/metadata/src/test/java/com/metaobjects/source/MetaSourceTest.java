package com.metaobjects.source;

import com.metaobjects.ErrorCode;
import com.metaobjects.MetaData;
import com.metaobjects.MetaDataException;
import com.metaobjects.loader.InMemoryStringSource;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.registry.MetaDataRegistry;
import com.metaobjects.registry.SharedRegistryTestBase;
import com.metaobjects.registry.TypeDefinition;
import org.junit.Before;
import org.junit.Test;

import java.util.Collections;
import java.util.List;

import static org.junit.Assert.*;

/**
 * Tests for {@link MetaSource} / {@link RdbSource} — metatype registration,
 * accessor defaults, read-only derivation, and @kind/@role enum validation.
 *
 * <p>Mirrors the pattern from {@link com.metaobjects.relationship.MetaRelationshipTest}
 * and {@link com.metaobjects.field.EnumFieldTest}.</p>
 */
public class MetaSourceTest extends SharedRegistryTestBase {

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    private MetaDataLoader newTestLoader() {
        return createTestLoader("MetaSourceTest", Collections.emptyList());
    }

    /**
     * Load the given canonical JSON string through the full loader pipeline.
     * Propagates any {@link MetaDataException} thrown during parse or validation.
     */
    private MetaDataLoader loadThrough(String canonical, String id) {
        MetaDataLoader loader = newTestLoader();
        loader.load(List.of(new InMemoryStringSource(canonical, id)));
        return loader;
    }

    // Minimal canonical wrapper: an object.entity containing the given children JSON.
    private String entityWith(String childrenJson) {
        return "{ \"metadata.root\": { \"package\": \"acme\", \"children\": [" +
               "  { \"object.entity\": { \"name\": \"Product\", \"children\": [" +
               "    { \"field.long\": { \"name\": \"id\" } }," +
               childrenJson + "," +
               "    { \"identity.primary\": { \"@fields\": \"id\" } }" +
               "  ] } }" +
               "] } }";
    }

    // -----------------------------------------------------------------------
    // 1 — Registration: source.base and source.rdb are registered
    // -----------------------------------------------------------------------

    @Test
    public void sourceBaseIsRegistered() {
        MetaDataRegistry registry = MetaDataRegistry.getInstance();
        TypeDefinition def = registry.getTypeDefinition(MetaSource.TYPE_SOURCE, MetaSource.SUBTYPE_BASE);
        assertNotNull("source.base should be registered", def);
    }

    @Test
    public void sourceRdbIsRegistered() {
        MetaDataRegistry registry = MetaDataRegistry.getInstance();
        TypeDefinition def = registry.getTypeDefinition(MetaSource.TYPE_SOURCE, RdbSource.SUBTYPE_RDB);
        assertNotNull("source.rdb should be registered", def);
    }

    // -----------------------------------------------------------------------
    // 2 — Happy path: source.rdb with @table loads inside object.entity
    // -----------------------------------------------------------------------

    @Test
    public void rdbSourceWithTableLoads() {
        // When no explicit "name" key is provided, source nodes participate in
        // auto-naming (sequential <subType>N) — the canonical serializer suppresses
        // the auto-name on emit so the output stays byte-identical to the TS oracle.
        // First source.rdb under the entity gets auto-name "rdb1", qualified with the
        // document's default package "acme" → "acme::rdb1".
        String canonical = entityWith("{ \"source.rdb\": { \"@table\": \"products\" } }");
        MetaDataLoader loader = loadThrough(canonical, "source-rdb-table-test.json");

        MetaData product = loader.getRoot().getChildOfType("object", "acme::Product");
        assertNotNull("Product entity should exist", product);

        MetaData src = product.getChildOfType(MetaSource.TYPE_SOURCE, "acme::rdb1");
        assertNotNull("source.rdb child 'acme::rdb1' should exist", src);
        assertEquals("subtype should be rdb", RdbSource.SUBTYPE_RDB, src.getSubType());
        assertTrue("src must be a MetaSource", src instanceof MetaSource);
        assertEquals("@table attr should be 'products'",
            "products", ((MetaSource) src).getTableName());
    }

    // -----------------------------------------------------------------------
    // 3 — getTableName()
    // -----------------------------------------------------------------------

    @Test
    public void getTableNameReturnsTableAttr() {
        RdbSource src = new RdbSource("mySource");
        com.metaobjects.attr.StringAttribute tableAttr =
            new com.metaobjects.attr.StringAttribute(MetaSource.ATTR_TABLE);
        tableAttr.setValueAsString("products");
        src.addChild(tableAttr);

        assertEquals("getTableName should return @table value", "products", src.getTableName());
    }

    @Test
    public void getTableNameReturnsNullWhenAbsent() {
        RdbSource src = new RdbSource("mySource");
        assertNull("getTableName should return null when @table is unset", src.getTableName());
    }

    // -----------------------------------------------------------------------
    // 4 — getEffectiveKind() defaults to "table"
    // -----------------------------------------------------------------------

    @Test
    public void getEffectiveKindDefaultsToTable() {
        RdbSource src = new RdbSource("mySource");
        assertEquals("default kind should be 'table'",
            MetaSource.DEFAULT_KIND, src.getEffectiveKind());
        assertEquals("default kind should be the TABLE constant",
            MetaSource.KIND_TABLE, src.getEffectiveKind());
    }

    @Test
    public void getEffectiveKindReturnsExplicitValue() {
        RdbSource src = new RdbSource("mySource");
        com.metaobjects.attr.StringAttribute kindAttr =
            new com.metaobjects.attr.StringAttribute(MetaSource.ATTR_KIND);
        kindAttr.setValueAsString(MetaSource.KIND_VIEW);
        src.addChild(kindAttr);

        assertEquals("getEffectiveKind should return explicit @kind", MetaSource.KIND_VIEW, src.getEffectiveKind());
    }

    // -----------------------------------------------------------------------
    // 5 — getRole() defaults to "primary"
    // -----------------------------------------------------------------------

    @Test
    public void getRoleDefaultsToPrimary() {
        RdbSource src = new RdbSource("mySource");
        assertEquals("default role should be 'primary'",
            MetaSource.DEFAULT_ROLE, src.getRole());
        assertEquals("default role should be the PRIMARY constant",
            MetaSource.ROLE_PRIMARY, src.getRole());
    }

    @Test
    public void getRoleReturnsExplicitValue() {
        RdbSource src = new RdbSource("mySource");
        com.metaobjects.attr.StringAttribute roleAttr =
            new com.metaobjects.attr.StringAttribute(MetaSource.ATTR_ROLE);
        roleAttr.setValueAsString(MetaSource.ROLE_REPLICA);
        src.addChild(roleAttr);

        assertEquals("getRole should return explicit @role", MetaSource.ROLE_REPLICA, src.getRole());
    }

    // -----------------------------------------------------------------------
    // 6 — isReadOnly() / isWritable() derived from @kind
    // -----------------------------------------------------------------------

    @Test
    public void isReadOnlyFalseForDefaultKind() {
        RdbSource src = new RdbSource("mySource");
        assertFalse("table kind (default) should not be read-only", src.isReadOnly());
        assertTrue("table kind (default) should be writable", src.isWritable());
    }

    @Test
    public void isReadOnlyTrueForViewKind() {
        RdbSource src = new RdbSource("mySource");
        com.metaobjects.attr.StringAttribute kindAttr =
            new com.metaobjects.attr.StringAttribute(MetaSource.ATTR_KIND);
        kindAttr.setValueAsString(MetaSource.KIND_VIEW);
        src.addChild(kindAttr);

        assertTrue("view kind should be read-only", src.isReadOnly());
        assertFalse("view kind should not be writable", src.isWritable());
    }

    @Test
    public void isReadOnlyTrueForMaterializedView() {
        RdbSource src = new RdbSource("mySource");
        com.metaobjects.attr.StringAttribute kindAttr =
            new com.metaobjects.attr.StringAttribute(MetaSource.ATTR_KIND);
        kindAttr.setValueAsString(MetaSource.KIND_MATERIALIZED_VIEW);
        src.addChild(kindAttr);

        assertTrue("materializedView kind should be read-only", src.isReadOnly());
    }

    @Test
    public void isReadOnlyTrueForStoredProc() {
        RdbSource src = new RdbSource("mySource");
        com.metaobjects.attr.StringAttribute kindAttr =
            new com.metaobjects.attr.StringAttribute(MetaSource.ATTR_KIND);
        kindAttr.setValueAsString(MetaSource.KIND_STORED_PROC);
        src.addChild(kindAttr);

        assertTrue("storedProc kind should be read-only", src.isReadOnly());
    }

    @Test
    public void isReadOnlyTrueForTableFunction() {
        RdbSource src = new RdbSource("mySource");
        com.metaobjects.attr.StringAttribute kindAttr =
            new com.metaobjects.attr.StringAttribute(MetaSource.ATTR_KIND);
        kindAttr.setValueAsString(MetaSource.KIND_TABLE_FUNCTION);
        src.addChild(kindAttr);

        assertTrue("tableFunction kind should be read-only", src.isReadOnly());
    }

    @Test
    public void readOnlyKindsSetIsComplete() {
        assertTrue("READ_ONLY_KINDS must contain view",
            MetaSource.READ_ONLY_KINDS.contains(MetaSource.KIND_VIEW));
        assertTrue("READ_ONLY_KINDS must contain materializedView",
            MetaSource.READ_ONLY_KINDS.contains(MetaSource.KIND_MATERIALIZED_VIEW));
        assertTrue("READ_ONLY_KINDS must contain storedProc",
            MetaSource.READ_ONLY_KINDS.contains(MetaSource.KIND_STORED_PROC));
        assertTrue("READ_ONLY_KINDS must contain tableFunction",
            MetaSource.READ_ONLY_KINDS.contains(MetaSource.KIND_TABLE_FUNCTION));
        assertFalse("READ_ONLY_KINDS must NOT contain table",
            MetaSource.READ_ONLY_KINDS.contains(MetaSource.KIND_TABLE));
    }

    // -----------------------------------------------------------------------
    // 7 — @schema round-trips
    // -----------------------------------------------------------------------

    @Test
    public void getSchemaReturnsSchemaAttr() {
        RdbSource src = new RdbSource("mySource");
        com.metaobjects.attr.StringAttribute schemaAttr =
            new com.metaobjects.attr.StringAttribute(MetaSource.ATTR_SCHEMA);
        schemaAttr.setValueAsString("public");
        src.addChild(schemaAttr);

        assertEquals("getSchema should return @schema value", "public", src.getSchema());
    }

    @Test
    public void getSchemaReturnsNullWhenAbsent() {
        RdbSource src = new RdbSource("mySource");
        assertNull("getSchema should return null when @schema is unset", src.getSchema());
    }

    @Test
    public void schemaRoundTripsThroughLoader() {
        String canonical = entityWith(
            "{ \"source.rdb\": { \"@table\": \"products\", \"@schema\": \"public\" } }");
        MetaDataLoader loader = loadThrough(canonical, "source-rdb-schema-test.json");

        MetaData product = loader.getRoot().getChildOfType("object", "acme::Product");
        assertNotNull("Product entity should exist", product);

        // Source nodes are auto-named (sequential <subType>N); auto-name is suppressed
        // on canonical serialization. Lookup by the resolved qualified auto-name.
        MetaData src = product.getChildOfType(MetaSource.TYPE_SOURCE, "acme::rdb1");
        assertNotNull("source.rdb child 'acme::rdb1' should exist", src);
        assertTrue("src must be a MetaSource", src instanceof MetaSource);
        assertEquals("@schema should round-trip as 'public'",
            "public", ((MetaSource) src).getSchema());
    }

    // -----------------------------------------------------------------------
    // 8 — Bad @kind value → MetaDataException (ERR_BAD_ATTR_VALUE)
    // -----------------------------------------------------------------------

    @Test
    public void badKindValueRaisesError() {
        String canonical = entityWith(
            "{ \"source.rdb\": { \"@table\": \"products\", \"@kind\": \"bogus\" } }");
        try {
            loadThrough(canonical, "source-rdb-bad-kind-test.json");
            fail("Expected MetaDataException for invalid @kind value");
        } catch (MetaDataException e) {
            // Accept either a message containing ERR_BAD_ATTR_VALUE or the matching ErrorCode.
            boolean hasCode = e.getCode()
                .map(c -> c == ErrorCode.ERR_BAD_ATTR_VALUE)
                .orElse(false);
            boolean hasMsg = e.getMessage() != null &&
                e.getMessage().contains("ERR_BAD_ATTR_VALUE");
            assertTrue("Exception must signal ERR_BAD_ATTR_VALUE (via code or message): " + e.getMessage(),
                hasCode || hasMsg);
        }
    }

    // -----------------------------------------------------------------------
    // 9 — Bad @role value → MetaDataException (ERR_BAD_ATTR_VALUE)
    // -----------------------------------------------------------------------

    @Test
    public void badRoleValueRaisesError() {
        String canonical = entityWith(
            "{ \"source.rdb\": { \"@table\": \"products\", \"@role\": \"unknown\" } }");
        try {
            loadThrough(canonical, "source-rdb-bad-role-test.json");
            fail("Expected MetaDataException for invalid @role value");
        } catch (MetaDataException e) {
            boolean hasCode = e.getCode()
                .map(c -> c == ErrorCode.ERR_BAD_ATTR_VALUE)
                .orElse(false);
            boolean hasMsg = e.getMessage() != null &&
                e.getMessage().contains("ERR_BAD_ATTR_VALUE");
            assertTrue("Exception must signal ERR_BAD_ATTR_VALUE (via code or message): " + e.getMessage(),
                hasCode || hasMsg);
        }
    }

    // -----------------------------------------------------------------------
    // 10 — Constants correctness
    // -----------------------------------------------------------------------

    @Test
    public void constantsAreCorrect() {
        assertEquals("TYPE_SOURCE", "source", MetaSource.TYPE_SOURCE);
        assertEquals("SUBTYPE_BASE", "base", MetaSource.SUBTYPE_BASE);
        assertEquals("SUBTYPE_RDB", "rdb", RdbSource.SUBTYPE_RDB);

        assertEquals("ATTR_TABLE", "table", MetaSource.ATTR_TABLE);
        assertEquals("ATTR_KIND", "kind", MetaSource.ATTR_KIND);
        assertEquals("ATTR_ROLE", "role", MetaSource.ATTR_ROLE);
        assertEquals("ATTR_SCHEMA", "schema", MetaSource.ATTR_SCHEMA);

        assertEquals("KIND_TABLE", "table", MetaSource.KIND_TABLE);
        assertEquals("KIND_VIEW", "view", MetaSource.KIND_VIEW);
        assertEquals("KIND_MATERIALIZED_VIEW", "materializedView", MetaSource.KIND_MATERIALIZED_VIEW);
        assertEquals("KIND_STORED_PROC", "storedProc", MetaSource.KIND_STORED_PROC);
        assertEquals("KIND_TABLE_FUNCTION", "tableFunction", MetaSource.KIND_TABLE_FUNCTION);
        assertEquals("DEFAULT_KIND", "table", MetaSource.DEFAULT_KIND);

        assertEquals("ROLE_PRIMARY", "primary", MetaSource.ROLE_PRIMARY);
        assertEquals("ROLE_REPLICA", "replica", MetaSource.ROLE_REPLICA);
        assertEquals("ROLE_INDEX", "index", MetaSource.ROLE_INDEX);
        assertEquals("ROLE_CACHE", "cache", MetaSource.ROLE_CACHE);
        assertEquals("ROLE_PUBLISH", "publish", MetaSource.ROLE_PUBLISH);
        assertEquals("ROLE_MIRROR", "mirror", MetaSource.ROLE_MIRROR);
        assertEquals("DEFAULT_ROLE", "primary", MetaSource.DEFAULT_ROLE);
    }

    // -----------------------------------------------------------------------
    // 11 — Registry creates RdbSource via createInstance
    // -----------------------------------------------------------------------

    @Test
    public void registryCreatesRdbSource() {
        MetaDataRegistry registry = MetaDataRegistry.getInstance();
        MetaData src = registry.createInstance(
            MetaSource.TYPE_SOURCE, RdbSource.SUBTYPE_RDB, "registryTest");
        assertNotNull("Registry should create RdbSource instance", src);
        assertTrue("Instance must be a MetaSource", src instanceof MetaSource);
        assertEquals("Type must be source", MetaSource.TYPE_SOURCE, src.getType());
        assertEquals("SubType must be rdb", RdbSource.SUBTYPE_RDB, src.getSubType());
        assertEquals("Name must be set", "registryTest", src.getName());
    }

    // -----------------------------------------------------------------------
    // 12 — Canonical byte-parity: source.rdb with no authored name round-trips
    //      cleanly without emitting a spurious "name" key.
    //
    // This is the regression test for the cross-language divergence where Java's
    // parser used to fall back to name = subType for every nameless node, causing
    // the canonical serializer to emit `"name": "rdb"` on every source.rdb that
    // wasn't authored with a name — diverging from the TS oracle by exactly that
    // one key.
    // -----------------------------------------------------------------------

    @Test
    public void sourceRdbWithoutNameRoundTripsByteIdentical() throws Exception {
        // Authored shape — note the absence of any "name" key on the source.rdb body.
        // The canonical serializer must NOT emit a spurious "name" key on the
        // source.rdb node — that's the cross-language divergence this test guards.
        String authored =
            "{\n" +
            "  \"metadata.root\": {\n" +
            "    \"package\": \"acme::commerce\",\n" +
            "    \"children\": [\n" +
            "      {\n" +
            "        \"object.entity\": {\n" +
            "          \"name\": \"Customer\",\n" +
            "          \"children\": [\n" +
            "            { \"source.rdb\": { \"@table\": \"customers\" } },\n" +
            "            { \"field.long\": { \"name\": \"id\" } },\n" +
            "            { \"identity.primary\": { \"@fields\": [\"id\"] } }\n" +
            "          ]\n" +
            "        }\n" +
            "      }\n" +
            "    ]\n" +
            "  }\n" +
            "}";

        MetaDataLoader loader = loadThrough(authored, "source-rdb-byte-parity-test.json");

        String got =
            com.metaobjects.io.json.CanonicalJsonSerializer.canonicalSerialize(
                loader.getRoot()).trim();

        // The root-level divergence guard: no "name": "rdb..." anywhere in the
        // serialized output. Before the fix, this string would appear inside
        // the source.rdb body as "name": "rdb".
        assertFalse(
            "Serializer must NOT emit a spurious 'name' key for a nameless source.rdb:\n" + got,
            got.contains("\"name\": \"rdb"));

        // Extract the source.rdb body and assert it is exactly {"@table": "customers"}.
        com.google.gson.JsonObject gotRoot =
            com.google.gson.JsonParser.parseString(got).getAsJsonObject();
        com.google.gson.JsonObject metadataRoot =
            gotRoot.getAsJsonObject("metadata.root");
        com.google.gson.JsonArray rootChildren = metadataRoot.getAsJsonArray("children");
        com.google.gson.JsonObject entity = rootChildren.get(0).getAsJsonObject()
            .getAsJsonObject("object.entity");
        com.google.gson.JsonArray entityChildren = entity.getAsJsonArray("children");

        com.google.gson.JsonObject sourceBody = null;
        for (com.google.gson.JsonElement child : entityChildren) {
            com.google.gson.JsonObject wrapper = child.getAsJsonObject();
            if (wrapper.has("source.rdb")) {
                sourceBody = wrapper.getAsJsonObject("source.rdb");
                break;
            }
        }
        assertNotNull("serialized output must contain a source.rdb child", sourceBody);
        assertFalse("source.rdb body must NOT carry a 'name' key", sourceBody.has("name"));
        assertEquals("source.rdb body must carry only @table",
            "customers", sourceBody.get("@table").getAsString());
        assertEquals("source.rdb body must be exactly {@table: ...}",
            1, sourceBody.size());
    }
}

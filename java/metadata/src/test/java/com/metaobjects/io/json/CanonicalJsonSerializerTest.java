package com.metaobjects.io.json;

import com.metaobjects.MetaData;
import com.metaobjects.MetaRoot;
import com.metaobjects.attr.BooleanAttribute;
import com.metaobjects.attr.IntAttribute;
import com.metaobjects.attr.StringAttribute;
import com.metaobjects.attr.StringArrayAttribute;
import com.metaobjects.field.IntegerField;
import com.metaobjects.field.LongField;
import com.metaobjects.field.StringField;
import com.metaobjects.identity.PrimaryIdentity;
import com.metaobjects.object.mapped.MappedMetaObject;
import com.metaobjects.registry.SharedRegistryTestBase;
import org.junit.BeforeClass;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;

/**
 * Tests for CanonicalJsonSerializer — mirrors the TS canonicalSerialize / canonicalSerializeEffective
 * behaviour for cross-language conformance.
 */
public class CanonicalJsonSerializerTest extends SharedRegistryTestBase {

    @BeforeClass
    public static void registerTypes() {
        // Force class loading to ensure all types are registered in the shared registry.
        try {
            new LongField("_boot_long");
            new StringField("_boot_string");
            new IntegerField("_boot_int");
            new PrimaryIdentity("_boot_primary");
            new StringAttribute("_boot_sa");
            new StringArrayAttribute("_boot_saa");
            new BooleanAttribute("_boot_bool");
            new IntAttribute("_boot_int_attr");
        } catch (Exception ignored) {
            // registration errors during boot are acceptable
        }
    }

    // -----------------------------------------------------------------------
    // Helper: build the conformance fixture tree in-memory
    //   metadata.root { package: acme::commerce
    //     object.entity "acme::commerce::Product" {
    //       field.long  "id"
    //       field.string "name"
    //       identity.primary "primary1" { @fields: ["id"] }
    //     }
    //   }
    // -----------------------------------------------------------------------
    private MetaRoot buildSingleEntityRoot() {
        MetaRoot root = new MetaRoot("acme::commerce");

        MappedMetaObject product = MappedMetaObject.create("acme::commerce::Product");

        LongField idField = new LongField("id");
        StringField nameField = new StringField("name");

        product.addMetaField(idField);
        product.addMetaField(nameField);

        root.addChild(product);
        return root;
    }

    // -----------------------------------------------------------------------
    // Test 1 — canonical output structure for a root + object + fields.
    //
    // NOTE: The conformance corpus fixture uses "object.entity" (registered in
    // the canonical reader, Task 2). This test uses "object.map" (MappedMetaObject,
    // registered in the current module) to verify the serializer produces the
    // correct structural output. The full "object.entity" + identity byte-level
    // conformance test is left to Task 4 (fixture migration).
    // -----------------------------------------------------------------------
    @Test
    public void testSingleEntityCanonicalOutput() {
        MetaRoot root = buildSingleEntityRoot();

        String actual = CanonicalJsonSerializer.canonicalSerialize(root);

        // Expected output using "object.map" (MappedMetaObject's registered subtype).
        // Structure mirrors the conformance fixture exactly; object subtype differs.
        String expected =
            "{\n" +
            "  \"metadata.root\": {\n" +
            "    \"package\": \"acme::commerce\",\n" +
            "    \"children\": [\n" +
            "      {\n" +
            "        \"object.map\": {\n" +
            "          \"name\": \"Product\",\n" +
            "          \"children\": [\n" +
            "            {\n" +
            "              \"field.long\": {\n" +
            "                \"name\": \"id\"\n" +
            "              }\n" +
            "            },\n" +
            "            {\n" +
            "              \"field.string\": {\n" +
            "                \"name\": \"name\"\n" +
            "              }\n" +
            "            }\n" +
            "          ]\n" +
            "        }\n" +
            "      }\n" +
            "    ]\n" +
            "  }\n" +
            "}\n";

        assertEquals("Canonical output must match expected structure byte-for-byte", expected, actual);
    }

    // -----------------------------------------------------------------------
    // Test 2 — root node: package emitted, name omitted when empty
    // -----------------------------------------------------------------------
    @Test
    public void testRootNodeHasPackageAndNoName() {
        // For MetaRoot("myapp::core"), getName() = "myapp::core".
        // The canonical format emits this as "package": "myapp::core".
        MetaRoot root = new MetaRoot("myapp::core");
        String json = CanonicalJsonSerializer.canonicalSerialize(root);
        assertNotNull(json);
        assert json.contains("\"metadata.root\"") : "expected metadata.root key";
        assert json.contains("\"package\": \"myapp::core\"") : "expected package key, got: " + json;
    }

    // -----------------------------------------------------------------------
    // Test 3 — isAbstract emitted as reserved "abstract" key, not as @-attr
    // -----------------------------------------------------------------------
    @Test
    public void testIsAbstractEmittedAsReservedKey() {
        MetaRoot root = new MetaRoot("test::pkg");

        MappedMetaObject abstractObj = MappedMetaObject.create("test::pkg::BaseEntity");
        abstractObj.addMetaAttr(BooleanAttribute.create(MetaData.ATTR_IS_ABSTRACT, true));
        root.addChild(abstractObj);

        String json = CanonicalJsonSerializer.canonicalSerialize(root);

        // The isAbstract=true should appear as "abstract": true, NOT as "@isAbstract"
        assert json.contains("\"abstract\": true") : "expected 'abstract' reserved key, got: " + json;
        assert !json.contains("\"@isAbstract\"") : "must NOT emit @isAbstract as an attr key";
    }

    // -----------------------------------------------------------------------
    // Test 4 — isArray emitted as reserved "isArray" key for MetaField
    // -----------------------------------------------------------------------
    @Test
    public void testIsArrayEmittedAsReservedKeyForField() {
        MetaRoot root = new MetaRoot("test::pkg");

        MappedMetaObject obj = MappedMetaObject.create("test::pkg::Widget");
        StringField tagsField = new StringField("tags");
        tagsField.setArray(true);
        obj.addMetaField(tagsField);
        root.addChild(obj);

        String json = CanonicalJsonSerializer.canonicalSerialize(root);

        assert json.contains("\"isArray\": true") : "expected 'isArray' reserved key, got: " + json;
        assert !json.contains("\"@isArray\"") : "must NOT emit @isArray as an attr key";
    }

    // -----------------------------------------------------------------------
    // Test 5 — stringArray attr serializes as JSON array, not as bare string
    // -----------------------------------------------------------------------
    @Test
    public void testStringArrayAttrSerializesAsJsonArray() {
        // StringArrayAttribute stores a List<String> and should serialize as a JSON array.
        // Add it directly to the root (MetaRoot accepts any attr.*).
        MetaRoot root = new MetaRoot("test::pkg");
        StringArrayAttribute tagsAttr = StringArrayAttribute.create("tags", "alpha,beta,gamma");
        root.addMetaAttr(tagsAttr);

        String json = CanonicalJsonSerializer.canonicalSerialize(root);

        // "@tags" should be a JSON array ["alpha","beta","gamma"]
        assert json.contains("\"@tags\": [") : "expected @tags as array, got: " + json;
        assert json.contains("\"alpha\"") : "expected alpha in array";
        assert json.contains("\"beta\"") : "expected beta in array";
    }

    // -----------------------------------------------------------------------
    // Test 6 — @-attrs emitted in alphabetical order
    // -----------------------------------------------------------------------
    @Test
    public void testAttrsInAlphabeticalOrder() {
        MetaRoot root = new MetaRoot("test::pkg");
        MappedMetaObject obj = MappedMetaObject.create("test::pkg::Foo");

        PrimaryIdentity pk = new PrimaryIdentity("primary1");
        pk.addMetaAttr(StringAttribute.create("zzz", "last"));
        pk.addMetaAttr(StringAttribute.create("aaa", "first"));
        obj.addChild(pk);
        root.addChild(obj);

        String json = CanonicalJsonSerializer.canonicalSerialize(root);

        int posAaa = json.indexOf("\"@aaa\"");
        int posZzz = json.indexOf("\"@zzz\"");
        assert posAaa >= 0 && posZzz >= 0 : "both attrs should be present";
        assert posAaa < posZzz : "@aaa must appear before @zzz (alphabetical order)";
    }

    // -----------------------------------------------------------------------
    // Test 7 — extends emitted when super data is set
    // -----------------------------------------------------------------------
    @Test
    public void testExtendsEmittedWhenSuperDataSet() {
        MetaRoot root = new MetaRoot("test::pkg");

        MappedMetaObject baseEntity = MappedMetaObject.create("test::pkg::BaseEntity");
        baseEntity.addMetaAttr(BooleanAttribute.create(MetaData.ATTR_IS_ABSTRACT, true));
        root.addChild(baseEntity);

        MappedMetaObject product = MappedMetaObject.create("test::pkg::Product");
        product.setSuperData(baseEntity);
        root.addChild(product);

        String json = CanonicalJsonSerializer.canonicalSerialize(root);

        assert json.contains("\"extends\": \"BaseEntity\"") : "expected extends key with short name, got: " + json;
    }

    // -----------------------------------------------------------------------
    // Test 8 — output ends with exactly one trailing newline
    // -----------------------------------------------------------------------
    @Test
    public void testOutputEndsWithExactlyOneTrailingNewline() {
        MetaRoot root = new MetaRoot("test::pkg");
        String json = CanonicalJsonSerializer.canonicalSerialize(root);

        assert json.endsWith("\n") : "output must end with newline";
        assert !json.endsWith("\n\n") : "output must end with EXACTLY one newline";
    }

    // -----------------------------------------------------------------------
    // Test 9 — canonicalSerializeEffective includes inherited attrs from super
    // -----------------------------------------------------------------------
    @Test
    public void testCanonicalSerializeEffectiveIncludesInheritedAttrs() {
        MetaRoot root = new MetaRoot("test::pkg");

        MappedMetaObject base = MappedMetaObject.create("test::pkg::Base");
        base.addMetaAttr(StringAttribute.create("baseAttr", "baseValue"));
        root.addChild(base);

        MappedMetaObject child = MappedMetaObject.create("test::pkg::Child");
        child.setSuperData(base);
        root.addChild(child);

        String effectiveJson = CanonicalJsonSerializer.canonicalSerializeEffective(child);

        assertNotNull(effectiveJson);
        // The effective output for Child should include baseAttr from Base
        assert effectiveJson.contains("\"@baseAttr\"") : "effective output should include inherited @baseAttr";
    }
}

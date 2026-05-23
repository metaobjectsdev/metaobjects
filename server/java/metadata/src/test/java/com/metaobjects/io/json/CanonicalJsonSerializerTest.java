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
import com.metaobjects.object.MetaObject;
import com.metaobjects.object.ValueMetaObject;
import com.metaobjects.registry.SharedRegistryTestBase;
import com.metaobjects.validator.LengthValidator;
import com.metaobjects.validator.RegexValidator;
import org.junit.BeforeClass;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

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
            new LengthValidator("_boot_length");
            new RegexValidator("_boot_regex");
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

        // Build an object.entity node. The generic createInstance path constructs an
        // EntityMetaObject (whose 1-arg ctor stamps the semantic subType "entity").
        MetaObject product = getSharedRegistry().createInstance(
                MetaObject.TYPE_OBJECT, MetaObject.SUBTYPE_ENTITY, "acme::commerce::Product");

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
    // NOTE: The node is built as "object.entity" (the declared semantic subtype),
    // matching the conformance corpus fixture exactly. The backing class is
    // EntityMetaObject; its 1-arg ctor stamps the semantic subType "entity" — ADR-0005.
    // -----------------------------------------------------------------------
    @Test
    public void testSingleEntityCanonicalOutput() {
        MetaRoot root = buildSingleEntityRoot();

        String actual = CanonicalJsonSerializer.canonicalSerialize(root);

        // Expected output using "object.entity" (the declared semantic subtype),
        // matching the conformance fixture byte-for-byte.
        String expected =
            "{\n" +
            "  \"metadata.root\": {\n" +
            "    \"package\": \"acme::commerce\",\n" +
            "    \"children\": [\n" +
            "      {\n" +
            "        \"object.entity\": {\n" +
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
        assertTrue("expected metadata.root key", json.contains("\"metadata.root\""));
        assertTrue("expected package key, got: " + json, json.contains("\"package\": \"myapp::core\""));
    }

    // -----------------------------------------------------------------------
    // Test 3 — isAbstract emitted as reserved "abstract" key, not as @-attr
    // -----------------------------------------------------------------------
    @Test
    public void testIsAbstractEmittedAsReservedKey() {
        MetaRoot root = new MetaRoot("test::pkg");

        ValueMetaObject abstractObj = ValueMetaObject.create("test::pkg::BaseEntity");
        abstractObj.addMetaAttr(BooleanAttribute.create(MetaData.ATTR_IS_ABSTRACT, true));
        root.addChild(abstractObj);

        String json = CanonicalJsonSerializer.canonicalSerialize(root);

        // The isAbstract=true should appear as "abstract": true, NOT as "@isAbstract"
        assertTrue("expected 'abstract' reserved key, got: " + json, json.contains("\"abstract\": true"));
        assertFalse("must NOT emit @isAbstract as an attr key", json.contains("\"@isAbstract\""));
    }

    // -----------------------------------------------------------------------
    // Test 4 — isArray emitted as reserved "isArray" key for MetaField
    // -----------------------------------------------------------------------
    @Test
    public void testIsArrayEmittedAsReservedKeyForField() {
        MetaRoot root = new MetaRoot("test::pkg");

        ValueMetaObject obj = ValueMetaObject.create("test::pkg::Widget");
        StringField tagsField = new StringField("tags");
        tagsField.setArray(true);
        obj.addMetaField(tagsField);
        root.addChild(obj);

        String json = CanonicalJsonSerializer.canonicalSerialize(root);

        assertTrue("expected 'isArray' reserved key, got: " + json, json.contains("\"isArray\": true"));
        assertFalse("must NOT emit @isArray as an attr key", json.contains("\"@isArray\""));
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
        assertTrue("expected @tags as array, got: " + json, json.contains("\"@tags\": ["));
        assertTrue("expected alpha in array", json.contains("\"alpha\""));
        assertTrue("expected beta in array", json.contains("\"beta\""));
    }

    // -----------------------------------------------------------------------
    // Test 6 — @-attrs emitted in alphabetical order
    // -----------------------------------------------------------------------
    @Test
    public void testAttrsInAlphabeticalOrder() {
        MetaRoot root = new MetaRoot("test::pkg");
        ValueMetaObject obj = ValueMetaObject.create("test::pkg::Foo");

        PrimaryIdentity pk = new PrimaryIdentity("primary1");
        pk.addMetaAttr(StringAttribute.create("zzz", "last"));
        pk.addMetaAttr(StringAttribute.create("aaa", "first"));
        obj.addChild(pk);
        root.addChild(obj);

        String json = CanonicalJsonSerializer.canonicalSerialize(root);

        int posAaa = json.indexOf("\"@aaa\"");
        int posZzz = json.indexOf("\"@zzz\"");
        assertTrue("both attrs should be present", posAaa >= 0 && posZzz >= 0);
        assertTrue("@aaa must appear before @zzz (alphabetical order)", posAaa < posZzz);
    }

    // -----------------------------------------------------------------------
    // Test 7 — extends emitted when super data is set
    // -----------------------------------------------------------------------
    @Test
    public void testExtendsEmittedWhenSuperDataSet() {
        MetaRoot root = new MetaRoot("test::pkg");

        ValueMetaObject baseEntity = ValueMetaObject.create("test::pkg::BaseEntity");
        baseEntity.addMetaAttr(BooleanAttribute.create(MetaData.ATTR_IS_ABSTRACT, true));
        root.addChild(baseEntity);

        ValueMetaObject product = ValueMetaObject.create("test::pkg::Product");
        product.setSuperData(baseEntity);
        root.addChild(product);

        String json = CanonicalJsonSerializer.canonicalSerialize(root);

        assertTrue("expected extends key with short name, got: " + json, json.contains("\"extends\": \"BaseEntity\""));
    }

    // -----------------------------------------------------------------------
    // Test 8 — output ends with exactly one trailing newline
    // -----------------------------------------------------------------------
    @Test
    public void testOutputEndsWithExactlyOneTrailingNewline() {
        MetaRoot root = new MetaRoot("test::pkg");
        String json = CanonicalJsonSerializer.canonicalSerialize(root);

        assertTrue("output must end with newline", json.endsWith("\n"));
        assertFalse("output must end with EXACTLY one newline", json.endsWith("\n\n"));
    }

    // -----------------------------------------------------------------------
    // Test 9 — canonicalSerializeEffective includes inherited attrs from super
    // -----------------------------------------------------------------------
    @Test
    public void testCanonicalSerializeEffectiveIncludesInheritedAttrs() {
        MetaRoot root = new MetaRoot("test::pkg");

        ValueMetaObject base = ValueMetaObject.create("test::pkg::Base");
        base.addMetaAttr(StringAttribute.create("baseAttr", "baseValue"));
        root.addChild(base);

        ValueMetaObject child = ValueMetaObject.create("test::pkg::Child");
        child.setSuperData(base);
        root.addChild(child);

        String effectiveJson = CanonicalJsonSerializer.canonicalSerializeEffective(child);

        assertNotNull(effectiveJson);
        // The effective output for Child should include baseAttr from Base
        assertTrue("effective output should include inherited @baseAttr", effectiveJson.contains("\"@baseAttr\""));
    }

    // -----------------------------------------------------------------------
    // Test 10 — child in a different package emits a "package" key
    // -----------------------------------------------------------------------
    @Test
    public void testChildInDifferentPackageEmitsPackageKey() {
        // Root is "acme::core"; child object lives in "acme::commerce" (different package).
        MetaRoot root = new MetaRoot("acme::core");

        ValueMetaObject product = ValueMetaObject.create("acme::commerce::Product");
        root.addChild(product);

        String json = CanonicalJsonSerializer.canonicalSerialize(root);

        // The child node must emit its own "package" key because it differs from the root's.
        assertTrue("child node must emit 'package' key when it differs from parent's, got: " + json,
                json.contains("\"package\": \"acme::commerce\""));
    }

    // -----------------------------------------------------------------------
    // Test 11 — extends emitted as FQN when super is in a different package
    //
    // Base lives in "other::pkg"; Derived lives in "acme::commerce".
    // The serializer must emit the fully-qualified "other::pkg::Base" so that
    // a canonical parser can resolve it without its original load context.
    // -----------------------------------------------------------------------
    @Test
    public void testExtendsEmittedAsFQNWhenSuperInDifferentPackage() {
        MetaRoot root = new MetaRoot("acme::commerce");

        // Base is in a DIFFERENT package from the root/Derived.
        ValueMetaObject base = ValueMetaObject.create("other::pkg::Base");
        base.addMetaAttr(BooleanAttribute.create(MetaData.ATTR_IS_ABSTRACT, true));
        root.addChild(base);

        ValueMetaObject derived = ValueMetaObject.create("acme::commerce::Derived");
        derived.setSuperData(base);
        root.addChild(derived);

        String json = CanonicalJsonSerializer.canonicalSerialize(root);

        // Must use the fully-qualified name because super is in a different package.
        assertTrue("extends must be the FQN when super is in a different package, got: " + json,
                json.contains("\"extends\": \"other::pkg::Base\""));
        // Must NOT use the short name — that would be unresolvable in the canonical parser.
        assertFalse("extends must NOT be the short name when super is in a different package",
                json.contains("\"extends\": \"Base\""));
    }

    // -----------------------------------------------------------------------
    // Test 12 — extends emitted as short name when super is in the same package
    //
    // Both Base and Derived are in "test::pkg".  The existing Test 7 covers
    // same-package extends; this test makes the intent explicit.
    // -----------------------------------------------------------------------
    @Test
    public void testExtendsEmittedAsShortNameWhenSamePackage() {
        MetaRoot root = new MetaRoot("test::pkg");

        ValueMetaObject base = ValueMetaObject.create("test::pkg::Base");
        base.addMetaAttr(BooleanAttribute.create(MetaData.ATTR_IS_ABSTRACT, true));
        root.addChild(base);

        ValueMetaObject derived = ValueMetaObject.create("test::pkg::Derived");
        derived.setSuperData(base);
        root.addChild(derived);

        String json = CanonicalJsonSerializer.canonicalSerialize(root);

        // Same package — short name is unambiguous and preferred.
        assertTrue("extends must be the short name when super is in the same package, got: " + json,
                json.contains("\"extends\": \"Base\""));
        // Must NOT use the FQN — that would be unnecessarily verbose.
        assertFalse("extends must NOT be the FQN when super is in the same package",
                json.contains("\"extends\": \"test::pkg::Base\""));
    }

    // -----------------------------------------------------------------------
    // Test 13 — validator with authored name ending in digit is NOT suppressed (Fix 1)
    //
    // A RegexValidator named "length2" has subType "regex", so the auto-generated
    // prefix would be "regex". The name "length2" does NOT match "^regex\d+$", so
    // isAutoGeneratedName() must return false and the name must be emitted.
    // -----------------------------------------------------------------------
    @Test
    public void testAuthoredValidatorNameEndingInDigitIsEmitted() {
        MetaRoot root = new MetaRoot("test::pkg");
        ValueMetaObject obj = ValueMetaObject.create("test::pkg::Widget");

        // RegexValidator subType = "regex"; name "length2" ends in digit but does NOT
        // match the expected auto-generated pattern "regex<N>".
        RegexValidator validator = new RegexValidator("length2");
        obj.addChild(validator);
        root.addChild(obj);

        String json = CanonicalJsonSerializer.canonicalSerialize(root);

        // The validator's authored name must appear in the output.
        assertTrue("authored validator name 'length2' must be emitted (not suppressed as auto-generated), got: " + json,
                json.contains("\"name\": \"length2\""));
    }
}

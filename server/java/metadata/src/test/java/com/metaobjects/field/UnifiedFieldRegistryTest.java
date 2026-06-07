package com.metaobjects.field;

import com.metaobjects.registry.MetaDataRegistry;
import com.metaobjects.object.EntityMetaObject;
import com.metaobjects.attr.StringAttribute;
import com.metaobjects.attr.IntAttribute;
import com.metaobjects.attr.BooleanAttribute;
import com.metaobjects.validator.RequiredValidator;
import com.metaobjects.field.StringField;
import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Set;

import static org.junit.Assert.*;

/**
 * Comprehensive test for unified field type registry and metadata loading.
 * Tests that all field types properly self-register and can be loaded from metadata files.
 */
public class UnifiedFieldRegistryTest {

    private MetaDataRegistry registry;
    private Path tempDir;

    @Before
    public void setUp() throws IOException {
        // Create temp directory for test files
        tempDir = Files.createTempDirectory("unified-field-registry-test");
        
        // Get the unified registry instance
        registry = MetaDataRegistry.getInstance();
        
        // Ensure static registrations are loaded by creating instances
        triggerStaticRegistrations();
    }

    @After
    public void tearDown() throws IOException {
        // Clean up temp directory
        if (tempDir != null) {
            deleteDirectory(tempDir.toFile());
        }
    }

    /**
     * Trigger static registrations by creating instances of registered field types
     */
    private void triggerStaticRegistrations() {
        try {
            // Create instances to ensure static blocks execute
            new StringField("testString");           // Already registered
            new IntegerField("testInt");             // Already registered
            new LongField("testLong");               // New registration
            new DoubleField("testDouble");           // New registration
            new BooleanField("testBoolean");         // New registration
            new DateField("testDate");               // New registration
            new EntityMetaObject("testObject");      // Object type
            new StringAttribute("testStringAttr");   // Attribute type
            new IntAttribute("testIntAttr");         // Attribute type
            new BooleanAttribute("testBoolAttr");    // Attribute type
            new com.metaobjects.attr.LongAttribute("testLongAttr");     // Long attribute type
            new com.metaobjects.attr.DoubleAttribute("testDoubleAttr"); // Double attribute type
        } catch (Exception e) {
            // Ignore - just triggering static registrations
        }
    }

    @Test
    public void testFieldTypeRegistrations() {
        // Verify all expected field types are registered
        Set<String> registeredTypes = registry.getRegisteredTypeNames();
        // Extract base types from qualified names (e.g., "field.string" -> "field")
        Set<String> baseTypes = registeredTypes.stream()
            .map(name -> name.split("\\.")[0])
            .collect(java.util.stream.Collectors.toSet());
        
        assertTrue("Should have field types registered", baseTypes.contains("field"));
        assertTrue("Should have object types registered", baseTypes.contains("object"));
        assertTrue("Should have attr types registered", baseTypes.contains("attr"));
        
        MetaDataRegistry.RegistryStats stats = registry.getStats();
        assertNotNull("Registry stats should be available", stats);
        assertTrue("Should have multiple registered types", stats.totalTypes() >= 8);
    }

    @Test
    public void testStringFieldRegistration() {
        // Test StringField registration and child requirements. maxLength is the
        // StringField-specific (cross-port canonical) attr; pattern/length validation
        // is expressed via validator CHILD nodes — the field-level @pattern attr was
        // dropped in SP-G Unit 6c.
        assertTrue("StringField should accept maxLength attribute",
                  registry.acceptsChild("field", "string", "attr", "int", "maxLength"));
        // Absence is asserted on the NAMED requirement — field.base's open wildcard
        // attr policy makes acceptsChild() true for an arbitrary attr name.
        assertNull("StringField should NOT register a NAMED field-level pattern requirement (SP-G Unit 6c)",
                  registry.getTypeDefinition("field", "string").getChildRequirement("pattern"));
        assertTrue("StringField should accept validator children",
                  registry.acceptsChild("field", "string", "validator", "required", "*"));
        assertTrue("StringField should accept LengthValidator children",
                  registry.acceptsChild("field", "string", "validator", "length", "*"));

        String description = registry.getSupportedChildrenDescription("field", "string");
        assertNotNull("Should have supported children description", description);
        assertTrue("Description should mention validator support", description.toLowerCase().contains("validator"));
    }

    @Test
    public void testIntegerFieldRegistration() {
        // Range validation is expressed via validator.numeric @min/@max children — the
        // field-level @minValue/@maxValue attrs were dropped in SP-G Unit 6c.
        assertTrue("IntegerField should be registered",
                  registry.isRegistered("field", "int"));
        assertNull("IntegerField should NOT register a NAMED field-level minValue requirement (SP-G Unit 6c)",
                  registry.getTypeDefinition("field", "int").getChildRequirement("minValue"));
        assertTrue("IntegerField should accept validator.numeric children",
                  registry.acceptsChild("field", "int", "validator", "numeric", "*"));
    }

    @Test
    public void testLongFieldRegistration() {
        // Range validation is expressed via validator.numeric @min/@max children — the
        // field-level @minValue/@maxValue attrs were dropped in SP-G Unit 6c.
        assertTrue("LongField should be registered",
                  registry.isRegistered("field", "long"));
        assertNull("LongField should NOT register a NAMED field-level minValue requirement (SP-G Unit 6c)",
                  registry.getTypeDefinition("field", "long").getChildRequirement("minValue"));
        assertTrue("LongField should accept validator.numeric children",
                  registry.acceptsChild("field", "long", "validator", "numeric", "*"));
    }

    @Test
    public void testDoubleFieldRegistration() {
        // precision is the DoubleField-specific (cross-port canonical) attr; range
        // validation is expressed via validator.numeric @min/@max children — the
        // field-level @minValue/@maxValue attrs were dropped in SP-G Unit 6c.
        assertNull("DoubleField should NOT register a NAMED field-level minValue requirement (SP-G Unit 6c)",
                  registry.getTypeDefinition("field", "double").getChildRequirement("minValue"));
        assertTrue("DoubleField should accept precision attribute",
                  registry.acceptsChild("field", "double", "attr", "int", "precision"));

        String description = registry.getSupportedChildrenDescription("field", "double");
        assertNotNull("Should have supported children description", description);
        assertTrue("Description should mention precision", description.toLowerCase().contains("precision"));
    }

    @Test
    public void testBooleanFieldRegistration() {
        // Test BooleanField registration
        assertTrue("BooleanField should be registered",
                  registry.isRegistered("field", "boolean"));
        
        String description = registry.getSupportedChildrenDescription("field", "boolean");
        assertNotNull("Should have supported children description", description);
        assertTrue("Description should mention true/false", description.toLowerCase().contains("true"));
    }

    @Test
    public void testDateFieldRegistration() {
        // DateField carries no date-specific per-field attrs in the cross-port
        // vocabulary: @dateFormat/@format (presentation) and @minDate/@maxDate (range)
        // were vestigial (no canonical peer, no consumer) and dropped in SP-G Unit 6c.
        // Range validation is expressed via validator.numeric children.
        assertTrue("DateField should be registered",
                  registry.isRegistered("field", "date"));
        assertNull("DateField should NOT register a NAMED field-level dateFormat requirement (SP-G Unit 6c)",
                  registry.getTypeDefinition("field", "date").getChildRequirement("dateFormat"));
        assertNull("DateField should NOT register a NAMED field-level minDate requirement (SP-G Unit 6c)",
                  registry.getTypeDefinition("field", "date").getChildRequirement("minDate"));
        assertTrue("DateField should accept validator children",
                  registry.acceptsChild("field", "date", "validator", "required", "*"));
    }

    @Test
    public void testMetadataFileLoadingWithAllFieldTypes() throws Exception {
        // Create metadata file with all the field types we've registered
        Path metadataFile = tempDir.resolve("all-field-types-metadata.json");
        createAllFieldTypesMetadata(metadataFile);
        
        // Load the metadata using SimpleLoader
        MetaDataLoader loader = MetaDataLoader.createManual(false, "all-field-types-test")
                .init()
                .register()
                .getLoader();
        
        try {
            MetaDataLoader simpleLoader = new MetaDataLoader(
                    LoaderOptions.create(false, false, true),
                    MetaDataLoader.SUBTYPE_MANUAL, "all-field-types");
            simpleLoader.setSourceURIs(java.util.Arrays.asList(metadataFile.toUri()));
            simpleLoader.init();

            // Debug: Print what children are actually loaded
            System.out.println("MetaDataLoader children: " + simpleLoader.getChildren().size());
            for (com.metaobjects.MetaData child : simpleLoader.getChildren()) {
                System.out.println("  Child: " + child.getName() + " (" + child.getClass().getSimpleName() + ")");
            }
            
            // Verify the metadata loaded successfully  
            // Try both simple name and fully qualified name
            com.metaobjects.object.MetaObject testObject = null;
            try {
                testObject = simpleLoader.getMetaObjectByName("AllFieldTypesTest");
            } catch (Exception e) {
                // Try fully qualified name
                testObject = simpleLoader.getMetaObjectByName("test::alltypes::AllFieldTypesTest");
            }
            assertNotNull("Test object should be loaded", testObject);
            
            // Verify each field type loaded correctly
            MetaField stringField = testObject.getMetaField("testString");
            assertNotNull("String field should be loaded", stringField);
            assertTrue("String field should be StringField", stringField instanceof StringField);
            
            MetaField intField = testObject.getMetaField("testInt");
            assertNotNull("Int field should be loaded", intField);
            assertTrue("Int field should be IntegerField", intField instanceof IntegerField);
            
            MetaField longField = testObject.getMetaField("testLong");
            assertNotNull("Long field should be loaded", longField);
            assertTrue("Long field should be LongField", longField instanceof LongField);
            
            MetaField doubleField = testObject.getMetaField("testDouble");
            assertNotNull("Double field should be loaded", doubleField);
            assertTrue("Double field should be DoubleField", doubleField instanceof DoubleField);
            
            MetaField booleanField = testObject.getMetaField("testBoolean");
            assertNotNull("Boolean field should be loaded", booleanField);
            assertTrue("Boolean field should be BooleanField", booleanField instanceof BooleanField);
            
            MetaField dateField = testObject.getMetaField("testDate");
            assertNotNull("Date field should be loaded", dateField);
            assertTrue("Date field should be DateField", dateField instanceof DateField);
            
        } finally {
            loader.destroy();
        }
    }

    @Test
    public void testFieldWithAttributesLoading() throws Exception {
        // Create metadata file with fields that have attributes
        Path metadataFile = tempDir.resolve("fields-with-attributes-metadata.json");
        createFieldsWithAttributesMetadata(metadataFile);
        
        MetaDataLoader loader = MetaDataLoader.createManual(false, "fields-with-attributes-test")
                .init()
                .register()
                .getLoader();
        
        try {
            MetaDataLoader simpleLoader = new MetaDataLoader(
                    LoaderOptions.create(false, false, true),
                    MetaDataLoader.SUBTYPE_MANUAL, "fields-with-attributes");
            simpleLoader.setSourceURIs(java.util.Arrays.asList(metadataFile.toUri()));
            simpleLoader.init();
            
            // Try both simple name and fully qualified name
            com.metaobjects.object.MetaObject testObject = null;
            try {
                testObject = simpleLoader.getMetaObjectByName("FieldsWithAttributesTest");
            } catch (Exception e) {
                // Try fully qualified name (package is test::withattributes)
                testObject = simpleLoader.getMetaObjectByName("test::withattributes::FieldsWithAttributesTest");
            }
            assertNotNull("Test object should be loaded", testObject);
            
            // Test string field with attributes. maxLength is the canonical (cross-port)
            // string attr; the field-level @pattern attr was dropped in SP-G Unit 6c
            // (pattern validation is expressed via validator.regex children).
            StringField emailField = (StringField) testObject.getMetaField("email");
            assertNotNull("Email field should be loaded", emailField);
            assertTrue("Email field should have maxLength attribute",
                      emailField.hasMetaAttr("maxLength"));

            // Test double field with attributes
            DoubleField priceField = (DoubleField) testObject.getMetaField("price");
            assertNotNull("Price field should be loaded", priceField);
            assertTrue("Price field should have precision attribute",
                      priceField.hasMetaAttr("precision"));
            
        } finally {
            loader.destroy();
        }
    }

    @Test
    public void testConstraintEnforcementInLoading() throws Exception {
        // Test that constraint enforcement works during metadata loading
        Path metadataFile = tempDir.resolve("constraint-test-metadata.json");
        createConstraintTestMetadata(metadataFile);
        
        MetaDataLoader loader = MetaDataLoader.createManual(false, "constraint-test")
                .init()
                .register()
                .getLoader();
        
        try {
            MetaDataLoader simpleLoader = new MetaDataLoader(
                    LoaderOptions.create(false, false, true),
                    MetaDataLoader.SUBTYPE_MANUAL, "constraint-test");
            simpleLoader.setSourceURIs(java.util.Arrays.asList(metadataFile.toUri()));
            simpleLoader.init();
            
            // Verify constraint enforcement is working
            // Try both simple name and fully qualified name
            com.metaobjects.object.MetaObject testObject = null;
            try {
                testObject = simpleLoader.getMetaObjectByName("ConstraintTest");
            } catch (Exception e) {
                // Try fully qualified name (package is test::constraints)
                testObject = simpleLoader.getMetaObjectByName("test::constraints::ConstraintTest");
            }
            assertNotNull("Test object should be loaded", testObject);
            
            // Try to add an invalid child - should be rejected
            // Get a field from the object and try to add another field to it (invalid)
            MetaField validField = testObject.getMetaField("validField");
            assertNotNull("Should have validField", validField);

            try {
                StringField invalidChild = new StringField("invalidNestedField");
                validField.addChild(invalidChild);
                fail("Should reject field as child of field");
            } catch (Exception e) {
                assertTrue("Should reject same type addition (actual: " + e.getMessage() + ")",
                          e.getMessage().toLowerCase().contains("cannot add the same metadata type"));
            }
            
        } finally {
            loader.destroy();
        }
    }

    // Helper methods

    private void createAllFieldTypesMetadata(Path outputFile) throws IOException {
        String metadata = """
            {
              "metadata.root": {
                "package": "test::alltypes",
                "children": [
                  {
                    "object.entity": {
                      "name": "AllFieldTypesTest",
                      "children": [
                        {
                          "field.string": {
                            "name": "testString"
                          }
                        },
                        {
                          "field.int": {
                            "name": "testInt"
                          }
                        },
                        {
                          "field.long": {
                            "name": "testLong"
                          }
                        },
                        {
                          "field.double": {
                            "name": "testDouble"
                          }
                        },
                        {
                          "field.boolean": {
                            "name": "testBoolean"
                          }
                        },
                        {
                          "field.date": {
                            "name": "testDate"
                          }
                        }
                      ]
                    }
                  }
                ]
              }
            }
            """;
        Files.writeString(outputFile, metadata, StandardCharsets.UTF_8);
    }

    private void createFieldsWithAttributesMetadata(Path outputFile) throws IOException {
        String metadata = """
            {
              "metadata.root": {
                "package": "test::withattributes",
                "children": [
                  {
                    "object.entity": {
                      "name": "FieldsWithAttributesTest",
                      "children": [
                        {
                          "field.string": {
                            "name": "email",
                            "@maxLength": 255
                          }
                        },
                        {
                          "field.double": {
                            "name": "price",
                            "@precision": 2
                          }
                        },
                        {
                          "field.long": {
                            "name": "quantity"
                          }
                        }
                      ]
                    }
                  }
                ]
              }
            }
            """;
        Files.writeString(outputFile, metadata, StandardCharsets.UTF_8);
    }

    private void createConstraintTestMetadata(Path outputFile) throws IOException {
        String metadata = """
            {
              "metadata.root": {
                "package": "test::constraints",
                "children": [
                  {
                    "object.entity": {
                      "name": "ConstraintTest",
                      "children": [
                        {
                          "field.string": {
                            "name": "validField"
                          }
                        }
                      ]
                    }
                  }
                ]
              }
            }
            """;
        Files.writeString(outputFile, metadata, StandardCharsets.UTF_8);
    }

    private void deleteDirectory(File dir) {
        if (dir.exists()) {
            File[] files = dir.listFiles();
            if (files != null) {
                for (File file : files) {
                    if (file.isDirectory()) {
                        deleteDirectory(file);
                    } else {
                        file.delete();
                    }
                }
            }
            dir.delete();
        }
    }
}
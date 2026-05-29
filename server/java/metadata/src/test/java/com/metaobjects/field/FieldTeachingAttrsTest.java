package com.metaobjects.field;

import com.metaobjects.attr.PropertiesAttribute;
import com.metaobjects.registry.SharedRegistryTestBase;
import org.junit.BeforeClass;
import org.junit.Test;

import java.util.Properties;

import static org.junit.Assert.*;

/**
 * Tests for the FR-010 teaching attributes on {@code field.base} and {@code field.enum}.
 *
 * <p>Registered in this task (FR-010 Plan 3, Task 1):
 * <ul>
 *   <li>{@link MetaField#ATTR_EXAMPLE} — optional string on any field subtype</li>
 *   <li>{@link MetaField#ATTR_INSTRUCTION} — optional string on any field subtype</li>
 *   <li>{@link EnumField#ATTR_ENUM_DOC} — optional properties (per-member description map)
 *       on {@code field.enum}</li>
 * </ul>
 */
public class FieldTeachingAttrsTest extends SharedRegistryTestBase {

    @BeforeClass
    public static void registerFieldTypes() {
        // Ensure EnumField and PropertiesAttribute are registered (idempotent).
        try {
            new EnumField("_boot_enum");
            new PropertiesAttribute("_boot_props");
        } catch (Exception ignored) {
            // Already registered — acceptable.
        }
    }

    // -----------------------------------------------------------------------
    // Constants
    // -----------------------------------------------------------------------

    @Test
    public void attrExampleConstantHasExpectedValue() {
        assertEquals("ATTR_EXAMPLE constant must equal \"example\"",
            "example", MetaField.ATTR_EXAMPLE);
    }

    @Test
    public void attrInstructionConstantHasExpectedValue() {
        assertEquals("ATTR_INSTRUCTION constant must equal \"instruction\"",
            "instruction", MetaField.ATTR_INSTRUCTION);
    }

    @Test
    public void attrEnumDocConstantHasExpectedValue() {
        assertEquals("ATTR_ENUM_DOC constant must equal \"enumDoc\"",
            "enumDoc", EnumField.ATTR_ENUM_DOC);
    }

    // -----------------------------------------------------------------------
    // @example and @instruction on a concrete field (StringField)
    // -----------------------------------------------------------------------

    @Test
    public void exampleAttrAbsentByDefault() {
        com.metaobjects.field.StringField field = new com.metaobjects.field.StringField("email");
        assertFalse("@example must not be present on a freshly-constructed field",
            field.hasMetaAttr(MetaField.ATTR_EXAMPLE, false));
    }

    @Test
    public void instructionAttrAbsentByDefault() {
        com.metaobjects.field.StringField field = new com.metaobjects.field.StringField("email");
        assertFalse("@instruction must not be present on a freshly-constructed field",
            field.hasMetaAttr(MetaField.ATTR_INSTRUCTION, false));
    }

    // -----------------------------------------------------------------------
    // @enumDoc round-trip on EnumField — mirrors EnumFieldEnumAliasTest idiom
    // -----------------------------------------------------------------------

    /**
     * An {@link EnumField} that carries a {@link PropertiesAttribute} named
     * {@code enumDoc} must round-trip the map through
     * {@code getMetaAttr(EnumField.ATTR_ENUM_DOC).getValue()}.
     *
     * <p>Construction idiom mirrors {@code EnumFieldEnumAliasTest#enumAliasAttributeRoundTrips}.</p>
     */
    @Test
    public void enumDocAttributeRoundTrips() {
        // Build the field
        EnumField field = new EnumField("priority");

        // Attach @values (required for a well-formed EnumField)
        com.metaobjects.attr.StringAttribute valuesAttr =
            new com.metaobjects.attr.StringAttribute(EnumField.ATTR_VALUES);
        valuesAttr.setArray(true);
        valuesAttr.setValueAsString("LOW,MEDIUM,HIGH");
        field.addMetaAttr(valuesAttr);

        // Build the @enumDoc properties attribute
        Properties docs = new Properties();
        docs.setProperty("LOW",    "Lower-priority task; can wait.");
        docs.setProperty("MEDIUM", "Normal-priority task.");
        docs.setProperty("HIGH",   "Urgent; address immediately.");

        PropertiesAttribute docAttr = new PropertiesAttribute(EnumField.ATTR_ENUM_DOC);
        docAttr.setValueAsObject(docs);
        field.addMetaAttr(docAttr);

        // Retrieve and verify
        com.metaobjects.MetaData retrieved = field.getMetaAttr(EnumField.ATTR_ENUM_DOC);
        assertNotNull("@enumDoc attribute must be retrievable", retrieved);

        Object rawValue = ((com.metaobjects.attr.MetaAttribute<?>) retrieved).getValue();
        assertNotNull("@enumDoc value must not be null", rawValue);
        assertTrue("@enumDoc value must be a java.util.Properties instance",
            rawValue instanceof Properties);

        Properties roundTripped = (Properties) rawValue;
        assertEquals("LOW should have the expected description",
            "Lower-priority task; can wait.", roundTripped.getProperty("LOW"));
        assertEquals("HIGH should have the expected description",
            "Urgent; address immediately.", roundTripped.getProperty("HIGH"));
    }

    /**
     * An {@link EnumField} without {@code @enumDoc} must not fail attribute lookup —
     * the attribute is optional.
     */
    @Test
    public void enumFieldWithoutEnumDocHasNoDocAttr() {
        EnumField field = new EnumField("status");

        com.metaobjects.attr.StringAttribute valuesAttr =
            new com.metaobjects.attr.StringAttribute(EnumField.ATTR_VALUES);
        valuesAttr.setArray(true);
        valuesAttr.setValueAsString("ACTIVE,INACTIVE");
        field.addMetaAttr(valuesAttr);

        // @enumDoc is optional — hasMetaAttr(name, false) should return false
        assertFalse("EnumField without @enumDoc must not report it as present",
            field.hasMetaAttr(EnumField.ATTR_ENUM_DOC, false));
    }
}

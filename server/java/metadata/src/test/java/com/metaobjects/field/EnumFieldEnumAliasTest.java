package com.metaobjects.field;

import com.metaobjects.attr.PropertiesAttribute;
import com.metaobjects.registry.SharedRegistryTestBase;
import org.junit.BeforeClass;
import org.junit.Test;

import java.util.Properties;

import static org.junit.Assert.*;

/**
 * Tests for the optional {@code @enumAlias} (properties) attribute on {@link EnumField}.
 *
 * <p>FR-010: the alias map carries off-vocabulary → canonical-member mappings consumed
 * by the extract engine.  This attribute is optional and additive — loading an
 * {@code EnumField} without it remains valid.</p>
 */
public class EnumFieldEnumAliasTest extends SharedRegistryTestBase {

    @BeforeClass
    public static void registerEnumField() {
        // Ensure EnumField and PropertiesAttribute are registered (idempotent).
        try {
            new EnumField("_boot_enum");
            new PropertiesAttribute("_boot_props");
        } catch (Exception ignored) {
            // Already registered — acceptable.
        }
    }

    // -----------------------------------------------------------------------
    // Test 1 — constant value
    // -----------------------------------------------------------------------

    /**
     * {@link EnumField#ATTR_ENUM_ALIAS} must equal the canonical JSON attribute name.
     */
    @Test
    public void attrEnumAliasConstantHasExpectedValue() {
        assertEquals("ATTR_ENUM_ALIAS constant must equal \"enumAlias\"",
            "enumAlias", EnumField.ATTR_ENUM_ALIAS);
    }

    // -----------------------------------------------------------------------
    // Test 2 — round-trip via direct construction
    // -----------------------------------------------------------------------

    /**
     * An {@link EnumField} that carries a {@link PropertiesAttribute} named
     * {@code enumAlias} must round-trip the map through
     * {@code getMetaAttr(EnumField.ATTR_ENUM_ALIAS).getValue()}.
     *
     * <p>Construction idiom mirrors {@code EnumFieldTest#enumFieldDirectConstruction}:
     * instantiate via {@code new EnumField(name)}, build the attribute, then
     * {@code addMetaAttr}.</p>
     */
    @Test
    public void enumAliasAttributeRoundTrips() {
        // Build the field
        EnumField field = new EnumField("mood");

        // Attach @values (required for a well-formed EnumField)
        com.metaobjects.attr.StringAttribute valuesAttr =
            new com.metaobjects.attr.StringAttribute(EnumField.ATTR_VALUES);
        valuesAttr.setArray(true);
        valuesAttr.setValueAsString("FRIENDLY,NEUTRAL,HOSTILE");
        field.addMetaAttr(valuesAttr);

        // Build the @enumAlias properties attribute
        Properties aliases = new Properties();
        aliases.setProperty("warm", "FRIENDLY");
        aliases.setProperty("cold", "HOSTILE");

        PropertiesAttribute aliasAttr = new PropertiesAttribute(EnumField.ATTR_ENUM_ALIAS);
        aliasAttr.setValueAsObject(aliases);
        field.addMetaAttr(aliasAttr);

        // Retrieve and verify
        com.metaobjects.MetaData retrieved = field.getMetaAttr(EnumField.ATTR_ENUM_ALIAS);
        assertNotNull("@enumAlias attribute must be retrievable", retrieved);

        Object rawValue = ((com.metaobjects.attr.MetaAttribute<?>) retrieved).getValue();
        assertNotNull("@enumAlias value must not be null", rawValue);
        assertTrue("@enumAlias value must be a java.util.Properties instance",
            rawValue instanceof Properties);

        Properties roundTripped = (Properties) rawValue;
        assertEquals("warm should map to FRIENDLY", "FRIENDLY", roundTripped.getProperty("warm"));
        assertEquals("cold should map to HOSTILE",  "HOSTILE",  roundTripped.getProperty("cold"));
    }

    // -----------------------------------------------------------------------
    // Test 3 — absence of @enumAlias is still valid
    // -----------------------------------------------------------------------

    /**
     * An {@link EnumField} without {@code @enumAlias} must not fail attribute lookup
     * with a hard exception that prevents normal use — the attribute is optional.
     *
     * <p>The Java {@code getMetaAttr} contract throws
     * {@link com.metaobjects.MetaDataNotFoundException} for missing attrs; this test
     * confirms the field without the alias loads correctly and simply lacks the attr.</p>
     */
    @Test
    public void enumFieldWithoutAliasHasNoAliasAttr() {
        EnumField field = new EnumField("status");

        com.metaobjects.attr.StringAttribute valuesAttr =
            new com.metaobjects.attr.StringAttribute(EnumField.ATTR_VALUES);
        valuesAttr.setArray(true);
        valuesAttr.setValueAsString("ACTIVE,INACTIVE");
        field.addMetaAttr(valuesAttr);

        // @enumAlias is optional — hasMetaAttr(name, false) should return false
        assertFalse("EnumField without @enumAlias must not report it as present",
            field.hasMetaAttr(EnumField.ATTR_ENUM_ALIAS, false));
    }
}

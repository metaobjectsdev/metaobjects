package com.metaobjects.generator.mustache;

import org.junit.Before;
import org.junit.Test;
import static org.junit.Assert.*;

import java.io.IOException;

/**
 * Tests for ValueObject template parsing that were moved from metaobjects-core.
 * These tests require the valueobject-extension template that references ValueObject classes.
 */
public class ValueObjectTemplateParserTest {

    private TemplateParser parser;

    @Before
    public void setUp() {
        parser = new TemplateParser();
    }

    @Test
    public void testParseValueObjectTemplate() throws IOException {
        TemplateDefinition template = parser.parseTemplateFromFile("templates/valueobject-extension.mustache.yaml");

        assertNotNull("ValueObject template should be loaded", template);
        assertEquals("ValueObject Extension Template", template.getName());
        assertEquals("java", template.getTargetLanguage());

        // Validate the template
        parser.validateTemplate(template);

        // Check template content
        String templateContent = template.getTemplate();
        assertTrue("Should extend ValueObject", templateContent.contains("extends ValueObject"));
        assertTrue("Should have META_OBJECT_NAME", templateContent.contains("META_OBJECT_NAME"));
        assertTrue("Should have dynamic getters", templateContent.contains("getAttrValue"));
    }
}
package com.metaobjects.documentation;

import com.metaobjects.attr.StringArrayAttribute;
import com.metaobjects.attr.StringAttribute;
import com.metaobjects.registry.MetaDataTypeProvider;
import org.junit.Test;

import java.util.ServiceLoader;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Cross-language vocabulary contract: the 7 doc attr names MUST be identical
 * across TS / C# / Java / Python. If you change a constant value here, the
 * cross-language conformance fixtures break.
 */
public class DocumentationConstantsTest {

    @Test
    public void constants_have_expected_cross_language_strings() {
        assertEquals("description", DocumentationConstants.DOC_ATTR_DESCRIPTION);
        assertEquals("title",       DocumentationConstants.DOC_ATTR_TITLE);
        assertEquals("notes",       DocumentationConstants.DOC_ATTR_NOTES);
        assertEquals("deprecated",  DocumentationConstants.DOC_ATTR_DEPRECATED);
        assertEquals("replacedBy",  DocumentationConstants.DOC_ATTR_REPLACED_BY);
        assertEquals("seeAlso",     DocumentationConstants.DOC_ATTR_SEE_ALSO);
        assertEquals("aliases",     DocumentationConstants.DOC_ATTR_ALIASES);
    }

    @Test
    public void DOC_ATTR_NAMES_contains_all_7_in_declaration_order() {
        assertEquals(7, DocumentationConstants.DOC_ATTR_NAMES.size());
        assertEquals(DocumentationConstants.DOC_ATTR_DESCRIPTION,
                     DocumentationConstants.DOC_ATTR_NAMES.get(0));
        assertEquals(DocumentationConstants.DOC_ATTR_ALIASES,
                     DocumentationConstants.DOC_ATTR_NAMES.get(6));
    }

    @Test
    public void schema_has_7_entries_with_correct_value_types() {
        assertEquals(7, DocumentationSchema.COMMON_DOC_ATTRS.size());

        // First 5 are string, last 2 are stringarray — cross-language invariant
        for (int i = 0; i < 5; i++) {
            assertEquals(
                "attr[" + i + "] should be string",
                StringAttribute.SUBTYPE_STRING,
                DocumentationSchema.COMMON_DOC_ATTRS.get(i).valueType()
            );
        }
        assertEquals(
            StringArrayAttribute.SUBTYPE_STRING_ARRAY,
            DocumentationSchema.COMMON_DOC_ATTRS.get(5).valueType()
        );
        assertEquals(
            StringArrayAttribute.SUBTYPE_STRING_ARRAY,
            DocumentationSchema.COMMON_DOC_ATTRS.get(6).valueType()
        );
    }

    @Test
    public void schema_attr_names_match_constants() {
        var attrs = DocumentationSchema.COMMON_DOC_ATTRS;
        assertEquals(DocumentationConstants.DOC_ATTR_DESCRIPTION, attrs.get(0).name());
        assertEquals(DocumentationConstants.DOC_ATTR_TITLE,       attrs.get(1).name());
        assertEquals(DocumentationConstants.DOC_ATTR_NOTES,       attrs.get(2).name());
        assertEquals(DocumentationConstants.DOC_ATTR_DEPRECATED,  attrs.get(3).name());
        assertEquals(DocumentationConstants.DOC_ATTR_REPLACED_BY, attrs.get(4).name());
        assertEquals(DocumentationConstants.DOC_ATTR_SEE_ALSO,    attrs.get(5).name());
        assertEquals(DocumentationConstants.DOC_ATTR_ALIASES,     attrs.get(6).name());
    }

    @Test
    public void all_doc_attrs_are_optional() {
        for (var attr : DocumentationSchema.COMMON_DOC_ATTRS) {
            assertFalse("attr '" + attr.name() + "' should not be required", attr.required());
        }
    }

    @Test
    public void provider_is_discoverable_via_SPI() {
        boolean found = ServiceLoader.load(MetaDataTypeProvider.class)
            .stream()
            .anyMatch(p -> p.type() == DocumentationMetaDataProvider.class);
        assertTrue("DocumentationMetaDataProvider must be SPI-registered", found);
    }

    @Test
    public void provider_id_is_metaobjects_documentation() {
        assertEquals("metaobjects-documentation",
                     new DocumentationMetaDataProvider().getProviderId());
    }

    @Test
    public void provider_depends_on_core_base_types() {
        String[] deps = new DocumentationMetaDataProvider().getDependencies();
        assertEquals(1, deps.length);
        assertEquals("core-base-types", deps[0]);
    }
}

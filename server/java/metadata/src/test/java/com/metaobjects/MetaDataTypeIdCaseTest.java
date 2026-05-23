package com.metaobjects;

import org.junit.Test;
import static org.junit.Assert.*;

public class MetaDataTypeIdCaseTest {
    @Test public void preserves_camelCase_subtype() {
        MetaDataTypeId id = new MetaDataTypeId("source", "dbView");
        assertEquals("source", id.type());
        assertEquals("dbView", id.subType());
        assertEquals("source.dbView", id.toQualifiedName());
    }
    @Test public void differs_by_case_is_not_equal() {
        assertNotEquals(new MetaDataTypeId("source", "dbView"),
                        new MetaDataTypeId("source", "dbview"));
    }
    @Test public void wildcard_pattern_matches_case_sensitively() {
        MetaDataTypeId id = new MetaDataTypeId("source", "dbView");
        assertTrue(id.matches("source.*"));
        assertTrue(id.matches("source.dbView"));
        assertFalse(id.matches("source.dbview"));
        assertFalse(id.matches("Source.dbView"));
    }
}

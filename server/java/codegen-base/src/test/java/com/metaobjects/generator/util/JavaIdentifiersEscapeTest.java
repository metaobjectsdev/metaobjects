package com.metaobjects.generator.util;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public class JavaIdentifiersEscapeTest {

    @Test
    public void escapesWhatWouldEndTheLiteral() {
        assertEquals("a\\\\b\\\"c", JavaIdentifiers.escapeStringLiteral("a\\b\"c"));
        assertEquals("line1\\nline2\\r\\t", JavaIdentifiers.escapeStringLiteral("line1\nline2\r\t"));
        assertEquals("\\u0001x\\u007f", JavaIdentifiers.escapeStringLiteral("\u0001x\u007f"));
    }

    @Test
    public void leavesOrdinaryTextAlone() {
        assertEquals("^[a-z]+é$", JavaIdentifiers.escapeStringLiteral("^[a-z]+é$"));
    }
}

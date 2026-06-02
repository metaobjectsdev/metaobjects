package com.metaobjects.render;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

public class EmailDocumentTest {

    @Test public void accessorsExposeAllFields() {
        EmailDocument doc = new EmailDocument("Hello", "<p>Hi</p>", "Hi");
        assertEquals("Hello", doc.subject());
        assertEquals("<p>Hi</p>", doc.htmlBody());
        assertEquals("Hi", doc.textBody());
    }

    @Test public void textBodyMayBeNull() {
        EmailDocument doc = new EmailDocument("S", "<b>H</b>", null);
        assertEquals("S", doc.subject());
        assertEquals("<b>H</b>", doc.htmlBody());
        assertNull(doc.textBody());
    }
}

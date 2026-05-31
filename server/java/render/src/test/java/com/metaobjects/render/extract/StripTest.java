package com.metaobjects.render.extract;

import org.junit.Test;
import static org.junit.Assert.*;

public class StripTest {

    @Test
    public void unwrapsJsonFence() {
        String in = "Sure! Here you go:\n```json\n{\"a\":1}\n```\nHope that helps.";
        String out = Strip.strip(in);
        assertTrue(out.contains("{\"a\":1}"));
        assertFalse(out.contains("```"));
    }

    @Test
    public void unwrapsBareFence() {
        assertEquals("{\"a\":1}", Strip.strip("```\n{\"a\":1}\n```").trim());
    }

    @Test
    public void unwrapsXmlFence() {
        String out = Strip.strip("```xml\n<a>1</a>\n```");
        assertTrue(out.contains("<a>1</a>"));
        assertFalse(out.contains("```"));
    }

    @Test
    public void noFenceReturnsTrimmedInput() {
        assertEquals("{\"a\":1}", Strip.strip("   {\"a\":1}   "));
    }

    @Test
    public void nullSafe() {
        assertEquals("", Strip.strip(null));
    }
}

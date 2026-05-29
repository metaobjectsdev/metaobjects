package com.metaobjects.render.recover;

import org.junit.Test;
import java.util.List;
import java.util.Map;
import static org.junit.Assert.*;

public class JsonForgivingReaderTest {

    private Map<String, Object> read(String s) { return new JsonForgivingReader().read(s); }

    @Test
    public void cleanObject() {
        Map<String, Object> m = read("{\"a\":\"1\",\"b\":\"two\"}");
        assertEquals("1", m.get("a"));
        assertEquals("two", m.get("b"));
    }

    @Test
    public void trailingComma() {
        Map<String, Object> m = read("{\"a\":\"1\",}");
        assertEquals("1", m.get("a"));
        assertEquals(1, m.size());
    }

    @Test
    public void singleQuotes() {
        Map<String, Object> m = read("{'a':'1'}");
        assertEquals("1", m.get("a"));
    }

    @Test
    public void unquotedKeys() {
        Map<String, Object> m = read("{a:\"1\",b:\"2\"}");
        assertEquals("1", m.get("a"));
        assertEquals("2", m.get("b"));
    }

    @Test
    public void nestedObject() {
        Map<String, Object> m = read("{\"a\":{\"b\":\"1\"}}");
        assertEquals("1", ((Map<?, ?>) m.get("a")).get("b"));
    }

    @Test
    public void arrayValues() {
        Map<String, Object> m = read("{\"xs\":[\"a\",\"b\"]}");
        assertEquals(List.of("a", "b"), m.get("xs"));
    }

    @Test
    public void truncatedRecoversCompletePrefixKeys() {
        Map<String, Object> m = read("{\"a\":\"1\",\"b\":\"2\",\"c\":");
        assertEquals("1", m.get("a"));
        assertEquals("2", m.get("b"));
        assertFalse(m.containsKey("c"));
    }

    @Test
    public void unrecoverableReturnsEmpty() {
        assertTrue(read("@@@@").isEmpty());
    }
}

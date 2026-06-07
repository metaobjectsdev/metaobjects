package com.metaobjects.render.extract;

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
    public void jsonNullLiteralIsNullSentinelNotTheStringNull() {
        Map<String, Object> m = read("{\"a\":null}");
        assertSame("bare JSON null must be the NULL_LITERAL sentinel, not the string \"null\"",
                JsonForgivingReader.NULL_LITERAL, m.get("a"));
        assertNotEquals("null", m.get("a"));
    }

    @Test
    public void jsonNullDoesNotTruncateTheRestOfTheObject() {
        Map<String, Object> m = read("{\"a\":null,\"b\":\"x\"}");
        assertSame(JsonForgivingReader.NULL_LITERAL, m.get("a"));
        assertEquals("a null-valued field must not stop parsing subsequent fields", "x", m.get("b"));
    }

    @Test
    public void quotedNullStaysTheStringNull() {
        // A *quoted* "null" is a genuine string value and must NOT be confused with the null literal.
        Map<String, Object> m = read("{\"a\":\"null\"}");
        assertEquals("null", m.get("a"));
    }

    @Test
    public void arrayValues() {
        Map<String, Object> m = read("{\"xs\":[\"a\",\"b\"]}");
        assertEquals(List.of("a", "b"), m.get("xs"));
    }

    @Test
    public void truncatedExtractsCompletePrefixKeys() {
        Map<String, Object> m = read("{\"a\":\"1\",\"b\":\"2\",\"c\":");
        assertEquals("1", m.get("a"));
        assertEquals("2", m.get("b"));
        assertSame("cut-off value is present-but-garbled", JsonForgivingReader.TRUNCATED, m.get("c"));
    }

    @Test
    public void unextractableReturnsEmpty() {
        assertTrue(read("@@@@").isEmpty());
    }

    @Test(timeout = 5000)
    public void malformedArrayBraceCloseDoesNotHang() {
        Map<String, Object> m = read("{\"xs\":[}");
        assertTrue(m.containsKey("xs"));   // xs present (empty/partial list), no hang
    }

    @Test(timeout = 5000)
    public void malformedArrayBraceCloseAfterCommaDoesNotHang() {
        Map<String, Object> m = read("{\"xs\":[1,}");
        // does not hang; xs extracted as a list with the prefix element
        assertTrue(m.get("xs") instanceof java.util.List);
    }

    @Test
    public void emptyValueMarksTruncated() {
        Map<String, Object> m = read("{\"a\":\"1\",\"c\":}");
        assertEquals("1", m.get("a"));
        assertSame(JsonForgivingReader.TRUNCATED, m.get("c"));
    }

    @Test
    public void emptyValueWhitespaceMarksTruncated() {
        Map<String, Object> m = read("{\"a\": }");
        assertSame(JsonForgivingReader.TRUNCATED, m.get("a"));
    }

    @Test
    public void emptyValueThenMoreKeysContinues() {
        Map<String, Object> m = read("{\"a\":,\"b\":\"2\"}");
        assertSame(JsonForgivingReader.TRUNCATED, m.get("a"));
        assertEquals("2", m.get("b"));
    }
}

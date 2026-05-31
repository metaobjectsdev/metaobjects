package com.metaobjects.render.extract;

import org.junit.Test;
import java.util.List;
import java.util.Map;
import static org.junit.Assert.*;

public class ExtractMapTest {

    private Map<String, Object> data() {
        return Map.of("s", "hi", "n", 7L, "d", 1.5, "b", Boolean.TRUE, "xs", List.of("a", "b"));
    }

    @Test public void asStringReadsAndDefaultsNull() {
        assertEquals("hi", ExtractMap.asString(data(), "s"));
        assertNull(ExtractMap.asString(Map.of(), "s"));
    }
    @Test public void asIntNarrowsLong() {
        assertEquals(Integer.valueOf(7), ExtractMap.asInt(data(), "n"));
        assertNull(ExtractMap.asInt(Map.of(), "n"));
    }
    @Test public void asLongReads() { assertEquals(Long.valueOf(7), ExtractMap.asLong(data(), "n")); }
    @Test public void asDoubleReads() { assertEquals(Double.valueOf(1.5), ExtractMap.asDouble(data(), "d")); }
    @Test public void asBoolReads() {
        assertEquals(Boolean.TRUE, ExtractMap.asBool(data(), "b"));
        assertNull(ExtractMap.asBool(Map.of(), "b"));
    }
    @Test public void asStringListReadsAndDefaultsNull() {
        assertEquals(List.of("a", "b"), ExtractMap.asStringList(data(), "xs"));
        assertNull(ExtractMap.asStringList(Map.of(), "xs"));
    }
    @Test public void asStringListCoercesElementsToString() {
        Map<String, Object> m = Map.of("xs", List.of(1L, 2L));
        assertEquals(List.of("1", "2"), ExtractMap.asStringList(m, "xs"));
    }
}

package com.metaobjects.render.recover;

import org.junit.Test;
import java.util.List;
import java.util.Map;
import static org.junit.Assert.*;

public class RecoverMapTest {

    private Map<String, Object> data() {
        return Map.of("s", "hi", "n", 7L, "d", 1.5, "b", Boolean.TRUE, "xs", List.of("a", "b"));
    }

    @Test public void asStringReadsAndDefaultsNull() {
        assertEquals("hi", RecoverMap.asString(data(), "s"));
        assertNull(RecoverMap.asString(Map.of(), "s"));
    }
    @Test public void asIntNarrowsLong() {
        assertEquals(Integer.valueOf(7), RecoverMap.asInt(data(), "n"));
        assertNull(RecoverMap.asInt(Map.of(), "n"));
    }
    @Test public void asLongReads() { assertEquals(Long.valueOf(7), RecoverMap.asLong(data(), "n")); }
    @Test public void asDoubleReads() { assertEquals(Double.valueOf(1.5), RecoverMap.asDouble(data(), "d")); }
    @Test public void asBoolReads() {
        assertEquals(Boolean.TRUE, RecoverMap.asBool(data(), "b"));
        assertNull(RecoverMap.asBool(Map.of(), "b"));
    }
    @Test public void asStringListReadsAndDefaultsNull() {
        assertEquals(List.of("a", "b"), RecoverMap.asStringList(data(), "xs"));
        assertNull(RecoverMap.asStringList(Map.of(), "xs"));
    }
    @Test public void asStringListCoercesElementsToString() {
        Map<String, Object> m = Map.of("xs", List.of(1L, 2L));
        assertEquals(List.of("1", "2"), RecoverMap.asStringList(m, "xs"));
    }
}

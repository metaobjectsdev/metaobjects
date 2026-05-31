package com.metaobjects.render.extract;

import org.junit.Test;
import java.util.List;
import java.util.Map;
import static org.junit.Assert.*;

public class XmlForgivingReaderTest {

    private Map<String, Object> read(String s, boolean ci) {
        return new XmlForgivingReader().read(s, ci);
    }

    @Test
    public void flatChildren() {
        Map<String, Object> m = read("<answer><t>hi</t><c>HIGH</c></answer>", false);
        assertEquals("hi", m.get("t"));
        assertEquals("HIGH", m.get("c"));
    }

    @Test
    public void nestedElement() {
        Map<String, Object> m = read("<answer><meta><n>1</n></meta></answer>", false);
        assertEquals("1", ((Map<?, ?>) m.get("meta")).get("n"));
    }

    @Test
    public void repeatedSiblingsCollapseToList() {
        Map<String, Object> m = read("<answer><x>a</x><x>b</x></answer>", false);
        assertEquals(List.of("a", "b"), m.get("x"));
    }

    @Test
    public void attributesIgnoredForValue() {
        Map<String, Object> m = read("<answer><t lang='en' n=2>hi</t></answer>", false);
        assertEquals("hi", m.get("t"));
    }

    @Test
    public void unclosedChildExtractsInnerText() {
        Map<String, Object> m = read("<answer><t>hi<c>HIGH</c></answer>", false);
        assertEquals("hi", m.get("t"));
        assertEquals("HIGH", m.get("c"));
    }

    @Test
    public void caseInsensitiveTags() {
        Map<String, Object> m = read("<Answer><T>hi</T></Answer>", true);
        assertEquals("hi", m.get("t"));
    }

    @Test
    public void spanStartingWithCloseTagDoesNotThrow() {
        Map<String, Object> m = read("</x>", false);
        assertTrue(m.isEmpty());
    }

    @Test
    public void degenerateCloseTagOnlyDoesNotThrow() {
        Map<String, Object> m = read("</>", false);
        assertTrue(m.isEmpty());
    }

    @Test
    public void strayCloseTagThenTextDoesNotThrow() {
        Map<String, Object> m = read("</foo>stuff", false);
        assertNotNull(m);   // no throw; content shape is best-effort
    }
}

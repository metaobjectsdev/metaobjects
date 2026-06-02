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
    @SuppressWarnings("unchecked")
    public void attributesParsedAlongsideText() {
        // A text element carrying attributes becomes a map of {attrs..., #text: body}.
        Map<String, Object> m = read("<answer><t lang='en' n=2>hi</t></answer>", false);
        Map<String, Object> t = (Map<String, Object>) m.get("t");
        assertEquals("en", t.get("lang"));
        assertEquals("2", t.get("n"));
        assertEquals("hi", t.get(XmlForgivingReader.TEXT_KEY));
    }

    @Test
    @SuppressWarnings("unchecked")
    public void selfClosingAllAttributes() {
        Map<String, Object> m = read("<answer><check id=\"A\" status=\"ok\"/></answer>", false);
        Map<String, Object> check = (Map<String, Object>) m.get("check");
        assertEquals("A", check.get("id"));
        assertEquals("ok", check.get("status"));
    }

    @Test
    @SuppressWarnings("unchecked")
    public void attributesMergeWithChildElements() {
        Map<String, Object> m = read(
                "<answer><correction id=\"NPC-004\"><reason>r</reason><area>a</area></correction></answer>", false);
        Map<String, Object> c = (Map<String, Object>) m.get("correction");
        assertEquals("NPC-004", c.get("id"));
        assertEquals("r", c.get("reason"));
        assertEquals("a", c.get("area"));
    }

    @Test
    public void selfClosingNoAttributesNoSpace() {
        Map<String, Object> m = read("<answer><br/></answer>", false);
        assertEquals("", m.get("br"));
    }

    @Test
    @SuppressWarnings("unchecked")
    public void repeatedSelfClosingCollapseToListOfMaps() {
        Map<String, Object> m = read("<answer><x a=\"1\"/><x a=\"2\"/></answer>", false);
        List<?> list = (List<?>) m.get("x");
        assertEquals(2, list.size());
        assertEquals("1", ((Map<String, Object>) list.get(0)).get("a"));
        assertEquals("2", ((Map<String, Object>) list.get(1)).get("a"));
    }

    @Test
    public void unclosedChildExtractsInnerText() {
        Map<String, Object> m = read("<answer><t>hi<c>HIGH</c></answer>", false);
        assertEquals("hi", m.get("t"));
        assertEquals("HIGH", m.get("c"));
    }

    @Test
    @SuppressWarnings("unchecked")
    public void unclosedElementWithImmediateChildNestsTheChild() {
        // A common LLM malformation: the parent's close tag is dropped while a real
        // child element is still emitted, and the parent's content begins IMMEDIATELY
        // with that child (no leading text). The child was meant to be nested, so it
        // must bind under the unclosed element rather than become a sibling.
        // (<check ...><payoff>text — the </check> is missing; </doc> closes the root.)
        Map<String, Object> m = read(
                "<doc><check id=\"A\" resolved=\"yes\"><payoff>the gate swings wide</doc>", true);
        Map<String, Object> check = (Map<String, Object>) m.get("check");
        assertNotNull("check element present", check);
        assertEquals("A", check.get("id"));
        assertEquals("yes", check.get("resolved"));
        assertEquals("the gate swings wide", check.get("payoff"));
        // closure_payoff must NOT leak out as a sibling of check
        assertFalse("payoff must not be a top-level sibling", m.containsKey("payoff"));
    }

    @Test
    public void unclosedElementWithLeadingTextKeepsSiblingSplit() {
        // Counterpart: when the unclosed element has leading TEXT before the next open
        // tag, that text is its body and the following tag stays a sibling (unchanged).
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

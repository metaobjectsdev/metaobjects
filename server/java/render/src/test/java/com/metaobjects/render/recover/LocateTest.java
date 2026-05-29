package com.metaobjects.render.recover;

import org.junit.Test;
import static org.junit.Assert.*;

public class LocateTest {

    @Test
    public void jsonIsolatesBalancedObjectFromProse() {
        String in = "Here is the result: {\"a\":1,\"b\":{\"c\":2}} — done.";
        assertEquals("{\"a\":1,\"b\":{\"c\":2}}", Locate.json(in));
    }

    @Test
    public void jsonIgnoresBracesInsideStrings() {
        String in = "{\"text\":\"a } not a close\",\"n\":1}";
        assertEquals(in, Locate.json(in));
    }

    @Test
    public void jsonTruncatedReturnsPrefixToEnd() {
        String in = "prefix {\"a\":1,\"b\":";
        assertEquals("{\"a\":1,\"b\":", Locate.json(in));
    }

    @Test
    public void jsonNoBraceReturnsNull() {
        assertNull(Locate.json("no object here"));
    }

    @Test
    public void jsonFirstClosedCandidateWins() {
        String in = "noise {\"a\":1} tail {\"b\":2}";
        assertEquals("{\"a\":1}", Locate.json(in));
    }

    @Test
    public void xmlSpansRoot() {
        String in = "blah <answer><t>hi</t></answer> blah";
        assertEquals("<answer><t>hi</t></answer>", Locate.xml(in, "answer", false));
    }

    @Test
    public void xmlUnclosedRootReturnsToEnd() {
        String in = "x <answer><t>hi</t>";
        assertEquals("<answer><t>hi</t>", Locate.xml(in, "answer", false));
    }

    @Test
    public void xmlCaseInsensitiveMatch() {
        String in = "<Answer><t>hi</t></Answer>";
        assertEquals("<Answer><t>hi</t></Answer>", Locate.xml(in, "answer", true));
    }

    @Test
    public void xmlNoOpenReturnsNull() {
        assertNull(Locate.xml("nothing", "answer", false));
    }
}

package com.metaobjects.registry;

import org.junit.Test;
import static org.junit.Assert.*;

public class ChildRequirementCaseTest {
    @Test public void preserves_camelCase_expected_subtype() {
        ChildRequirement r = new ChildRequirement(
            "*", "source", "dbView", false, null, null, null, null, null);
        assertEquals("source", r.getExpectedType());
        assertEquals("dbView", r.getExpectedSubType());
    }
    @Test public void null_becomes_wildcard() {
        ChildRequirement r = new ChildRequirement(
            "*", null, null, false, null, null, null, null, null);
        assertEquals("*", r.getExpectedType());
        assertEquals("*", r.getExpectedSubType());
    }
}

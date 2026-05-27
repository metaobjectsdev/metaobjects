/*
 * Copyright 2003 Doug Mealing LLC dba Meta Objects. All Rights Reserved.
 *
 * This software is the proprietary information of Doug Mealing LLC dba Meta Objects.
 * Use is subject to license terms.
 */
package com.metaobjects.source;

import org.junit.Test;

import static org.junit.Assert.assertEquals;

/**
 * FR5a / ADR-0009 — JSONPath builder unit tests.
 *
 * <p>Canonical form:</p>
 * <ul>
 *   <li>Root is {@code $}.</li>
 *   <li>Identifier-safe keys ({@code ^[A-Za-z_][A-Za-z0-9_]*$}) use dot: {@code .foo}.</li>
 *   <li>All other keys use single-quoted bracket: {@code ['my-key']}, {@code ['@attr']}.</li>
 *   <li>Array indices use bracket: {@code [N]}.</li>
 *   <li>Embedded {@code '} is escaped as {@code \'}.</li>
 * </ul>
 *
 * <p>Mirrors {@code JsonPathTests} in
 * {@code server/csharp/MetaObjects.Conformance.Tests/JsonPathTests.cs}.</p>
 */
public class JsonPathTest {

    @Test
    public void emptyBuilderRendersRoot() {
        JsonPath.Builder b = new JsonPath.Builder();
        assertEquals("$", b.toString());
    }

    @Test
    public void identifierKeysUseDotNotation() {
        JsonPath.Builder b = new JsonPath.Builder();
        b.pushKey("metadata");
        b.pushKey("root");
        assertEquals("$.metadata.root", b.toString());
    }

    @Test
    public void nonIdentifierKeysUseBracketQuotedForm() {
        JsonPath.Builder b = new JsonPath.Builder();
        b.pushKey("metadata");
        b.pushKey("root");
        b.pushKey("children");
        b.pushIndex(0);
        b.pushKey("my-package");
        assertEquals("$.metadata.root.children[0]['my-package']", b.toString());
    }

    @Test
    public void attrPrefixedKeysUseBracketQuotedForm() {
        JsonPath.Builder b = new JsonPath.Builder();
        b.pushKey("metadata");
        b.pushKey("root");
        b.pushKey("@values");
        assertEquals("$.metadata.root['@values']", b.toString());
    }

    @Test
    public void arrayIndicesUseBracketForm() {
        JsonPath.Builder b = new JsonPath.Builder();
        b.pushKey("root");
        b.pushKey("children");
        b.pushIndex(0);
        b.pushKey("object.entity");
        b.pushKey("children");
        b.pushIndex(1);
        b.pushKey("field.enum");
        assertEquals("$.root.children[0]['object.entity'].children[1]['field.enum']", b.toString());
    }

    @Test
    public void popReturnsToPreviousPath() {
        JsonPath.Builder b = new JsonPath.Builder();
        b.pushKey("metadata");
        b.pushKey("root");
        b.pushKey("children");
        b.pushIndex(0);
        assertEquals("$.metadata.root.children[0]", b.toString());
        b.pop();
        assertEquals("$.metadata.root.children", b.toString());
        b.pop();
        assertEquals("$.metadata.root", b.toString());
    }

    @Test
    public void emptyStringKeyUsesBracketQuotedForm() {
        JsonPath.Builder b = new JsonPath.Builder();
        b.pushKey("");
        // Empty string fails identifier regex → bracket form.
        assertEquals("$['']", b.toString());
    }

    @Test
    public void keysWithSingleQuotesAreEscaped() {
        JsonPath.Builder b = new JsonPath.Builder();
        b.pushKey("it's-a-trap");
        assertEquals("$['it\\'s-a-trap']", b.toString());
    }

    @Test
    public void keyStartingWithDigitUsesBracketForm() {
        JsonPath.Builder b = new JsonPath.Builder();
        b.pushKey("1invalid");
        assertEquals("$['1invalid']", b.toString());
    }

    @Test
    public void deepNestedPathForFieldEnumValues() {
        // Mirrors the example in ADR-0009 §Decision (per-segment quoting).
        JsonPath.Builder b = new JsonPath.Builder();
        b.pushKey("root");
        b.pushKey("children");
        b.pushIndex(0);
        b.pushKey("object.entity");
        b.pushKey("children");
        b.pushIndex(1);
        b.pushKey("field.enum");
        b.pushKey("@values");
        assertEquals(
            "$.root.children[0]['object.entity'].children[1]['field.enum']['@values']",
            b.toString());
    }

    @Test
    public void segmentForKeyRendersSingleSegment() {
        assertEquals(".foo", JsonPath.segmentForKey("foo"));
        assertEquals("['my-key']", JsonPath.segmentForKey("my-key"));
        assertEquals("['@attr']", JsonPath.segmentForKey("@attr"));
    }

    @Test
    public void segmentForIndexRendersZeroBasedIndices() {
        assertEquals("[0]", JsonPath.segmentForIndex(0));
        assertEquals("[42]", JsonPath.segmentForIndex(42));
    }

    @Test
    public void popOnEmptyBuilderIsNoOp() {
        // Defensive: matches the C# implementation's silent no-op on imbalanced pop.
        JsonPath.Builder b = new JsonPath.Builder();
        b.pop();
        b.pop();
        assertEquals("$", b.toString());
        assertEquals(0, b.depth());
    }

    @Test
    public void depthReflectsSegmentStack() {
        JsonPath.Builder b = new JsonPath.Builder();
        assertEquals(0, b.depth());
        b.pushKey("a");
        assertEquals(1, b.depth());
        b.pushIndex(0);
        assertEquals(2, b.depth());
        b.pop();
        assertEquals(1, b.depth());
    }
}

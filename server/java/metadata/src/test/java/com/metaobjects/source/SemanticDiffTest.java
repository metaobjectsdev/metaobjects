/*
 * Copyright 2003 Doug Mealing LLC dba Meta Objects. All Rights Reserved.
 *
 * This software is the proprietary information of Doug Mealing LLC dba Meta Objects.
 * Use is subject to license terms.
 */
package com.metaobjects.source;

import com.google.gson.JsonElement;
import com.google.gson.JsonParser;
import org.junit.Test;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * FR5a / ADR-0009 — SemanticDiff smoke tests.
 *
 * <p>FR5a doesn't exercise SemanticDiff at runtime — FR5c will consume the
 * boolean to drive the duplicate-with-no-change
 * {@code WARN_DUPLICATE_DECLARATION} path. The skeleton + tests ship now so
 * the port is ready when FR5c lands.</p>
 *
 * <p>Mirrors {@code SemanticDiffTests} in
 * {@code server/csharp/MetaObjects.Conformance.Tests/SemanticDiffTests.cs}.</p>
 */
public class SemanticDiffTest {

    private static JsonElement parse(String json) {
        return JsonParser.parseString(json);
    }

    @Test
    public void identicalObjectsHaveNoDiff() {
        JsonElement a = parse("{ \"name\": \"X\", \"@values\": [\"A\", \"B\"] }");
        JsonElement b = parse("{ \"name\": \"X\", \"@values\": [\"A\", \"B\"] }");
        assertFalse(SemanticDiff.diff(a, b));
    }

    @Test
    public void keyOrderDoesNotMatter() {
        JsonElement a = parse("{ \"a\": 1, \"b\": 2, \"c\": 3 }");
        JsonElement b = parse("{ \"c\": 3, \"a\": 1, \"b\": 2 }");
        assertFalse(SemanticDiff.diff(a, b));
    }

    @Test
    public void differentAttrValuesDiff() {
        JsonElement a = parse("{ \"name\": \"X\", \"@v\": 1 }");
        JsonElement b = parse("{ \"name\": \"X\", \"@v\": 2 }");
        assertTrue(SemanticDiff.diff(a, b));
    }

    @Test
    public void addedKeyDiffs() {
        JsonElement a = parse("{ \"name\": \"X\" }");
        JsonElement b = parse("{ \"name\": \"X\", \"@v\": 1 }");
        assertTrue(SemanticDiff.diff(a, b));
    }

    @Test
    public void childrenOrderMatters() {
        JsonElement a = parse("{ \"children\": [{ \"k\": 1 }, { \"k\": 2 }] }");
        JsonElement b = parse("{ \"children\": [{ \"k\": 2 }, { \"k\": 1 }] }");
        assertTrue(SemanticDiff.diff(a, b));
    }

    @Test
    public void sourceFieldIsExcludedFromDiff() {
        // ADR-0009 §semantic_diff.4: `source` is loader output, never participates.
        JsonElement a = parse(
            "{ \"name\": \"X\", \"source\": { \"format\": \"json\", \"files\": [\"a.json\"], \"jsonPath\": \"$\" } }");
        JsonElement b = parse(
            "{ \"name\": \"X\", \"source\": { \"format\": \"code\" } }");
        assertFalse(SemanticDiff.diff(a, b));
    }

    @Test
    public void nestedObjectDifferenceDiffs() {
        JsonElement a = parse("{ \"outer\": { \"inner\": 1 } }");
        JsonElement b = parse("{ \"outer\": { \"inner\": 2 } }");
        assertTrue(SemanticDiff.diff(a, b));
    }

    @Test
    public void nullVersusValueDiffs() {
        JsonElement a = parse("{ \"k\": null }");
        JsonElement b = parse("{ \"k\": 0 }");
        assertTrue(SemanticDiff.diff(a, b));
    }

    @Test
    public void bothNullSame() {
        assertFalse(SemanticDiff.diff(null, null));
    }

    @Test
    public void oneNullDiffs() {
        JsonElement a = parse("{}");
        assertTrue(SemanticDiff.diff(a, null));
        assertTrue(SemanticDiff.diff(null, a));
    }
}
